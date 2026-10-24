import React, { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Circle, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Icon } from "./ui.jsx";

/**
 * Real slippy map (Leaflet + OpenStreetMap data, CARTO dark basemap) used
 * by every dashboard map. It only renders the points it is given — each
 * one already carries real latitude/longitude from its own service.
 *
 * points: [{ id, lat, lng, color, shape, label, sublabel, radiusKm?, pulse?, title? }]
 *   shape: "circle" | "square" | "diamond" | "triangle" | "burst" | "alert"
 *   radiusKm: draws the true-scale affected area (disasters).
 *
 * CSP note: marker HTML is SVG with presentation attributes only (no
 * style="" attributes), so it works under style-src 'self'. Tiles come
 * from *.basemaps.cartocdn.com, allowed in nginx/security-headers.conf.
 */

// Since Aug 2026 CARTO watermarks keyless tiles. The key is a public,
// browser-side key by design (restrict it to your domains in CARTO).
const CARTO_KEY = import.meta.env.VITE_CARTO_BASEMAP_KEY;
const CARTO_QS = CARTO_KEY ? `?key=${encodeURIComponent(CARTO_KEY)}` : "";
const CARTO_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

// "Night" is CARTO Voyager recoloured by a CSS filter (styles.css,
// .sc-livemap.is-night) — far more legible than CARTO's near-black
// dark_all while matching the dashboard's navy theme.
const BASEMAPS = {
  night: {
    label: "Night",
    url: `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png${CARTO_QS}`,
    attribution: CARTO_ATTRIBUTION,
    subdomains: "abcd",
  },
  streets: {
    label: "Streets",
    url: `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png${CARTO_QS}`,
    attribution: CARTO_ATTRIBUTION,
    subdomains: "abcd",
  },
  satellite: {
    label: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    subdomains: "abc",
  },
};
const STYLE_STORAGE_KEY = "sc-map-style";

function readStoredStyle() {
  try {
    const v = window.localStorage.getItem(STYLE_STORAGE_KEY);
    return v && BASEMAPS[v] ? v : "night";
  } catch {
    return "night";
  }
}

const DEFAULT_CENTER = [18.52, 73.85];

function shapeSvg(shape, color, r, stroke, strokeWidth) {
  const c = 22;
  const common = `fill="${color}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"`;
  switch (shape) {
    case "square":
      return `<rect x="${c - r}" y="${c - r}" width="${r * 2}" height="${r * 2}" rx="2.5" ${common}/>`;
    case "diamond":
      return `<rect x="${c - r}" y="${c - r}" width="${r * 2}" height="${r * 2}" rx="2" transform="rotate(45 ${c} ${c})" ${common}/>`;
    case "triangle":
      return `<polygon points="${c},${c - r * 1.15} ${c + r},${c + r * 0.85} ${c - r},${c + r * 0.85}" ${common}/>`;
    case "burst": {
      const pts = [];
      for (let i = 0; i < 16; i++) {
        const a = (Math.PI / 8) * i;
        const rad = i % 2 === 0 ? r * 1.45 : r * 0.7;
        pts.push(`${(c + rad * Math.cos(a)).toFixed(1)},${(c + rad * Math.sin(a)).toFixed(1)}`);
      }
      return `<polygon points="${pts.join(" ")}" ${common}/>`;
    }
    case "alert":
      return `<circle cx="${c}" cy="${c}" r="${r + 2}" ${common}/><text x="${c}" y="${c + 4.5}" text-anchor="middle" font-size="13" font-weight="800" fill="#050a16">!</text>`;
    default:
      return `<circle cx="${c}" cy="${c}" r="${r}" ${common}/>`;
  }
}

const iconCache = new Map();
function markerIcon({ shape = "circle", color, pulse, selected }) {
  const key = `${shape}|${color}|${pulse ? 1 : 0}|${selected ? 1 : 0}`;
  if (iconCache.has(key)) return iconCache.get(key);
  const r = selected ? 8.5 : 6.5;
  const ring = pulse || selected ? `<circle class="sc-pulse-ring" cx="22" cy="22" r="9" fill="none" stroke="${color}" stroke-width="2"/>` : "";
  const halo = `<circle cx="22" cy="22" r="${r + 6}" fill="${color}" opacity="0.18"/>`;
  const html =
    `<svg width="44" height="44" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">` +
    ring +
    halo +
    shapeSvg(shape, color, r, selected ? "#ffffff" : "#050a16", selected ? 2.2 : 1.6) +
    `</svg>`;
  const icon = L.divIcon({ html, className: `sc-lm-marker${selected ? " is-selected" : ""}`, iconSize: [44, 44], iconAnchor: [22, 22], tooltipAnchor: [0, -14] });
  iconCache.set(key, icon);
  return icon;
}

/** Fits the view to the data once it first arrives (not on every poll), and on `fitKey` change. */
function AutoFit({ points, fitKey, fitRef }) {
  const map = useMap();
  const fittedFor = useRef(null);

  const fit = useMemo(
    () => () => {
      if (points.length === 0) return;
      const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng]));
      points.forEach((p) => {
        if (p.radiusKm) bounds.extend(L.latLng(p.lat, p.lng).toBounds(p.radiusKm * 2000));
      });
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: points.length === 1 ? 13 : 14, animate: true });
    },
    [map, points]
  );

  fitRef.current = fit;

  useEffect(() => {
    if (points.length === 0) return;
    if (fittedFor.current === fitKey) return;
    fittedFor.current = fitKey;
    fit();
  }, [points.length, fitKey, fit]);

  return null;
}

/** Leaflet measures its container once; tell it when the card resizes (sidebar drawer, window resize). */
function ResizeWatcher() {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [map]);
  return null;
}

export default function LiveMap({ points, height = 440, onSelect, selectedId, badge, fitKey = "all", label = "Live infrastructure map" }) {
  const fitRef = useRef(null);
  const [style, setStyle] = useState(readStoredStyle);
  const valid = useMemo(() => points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)), [points]);
  const basemap = BASEMAPS[style];

  // Re-fit when the SET of markers changes (a filter was applied/cleared),
  // but not when the same markers just refresh on the next poll.
  const idsKey = useMemo(() => valid.map((p) => p.id).sort().join("|"), [valid]);

  function chooseStyle(next) {
    setStyle(next);
    try {
      window.localStorage.setItem(STYLE_STORAGE_KEY, next);
    } catch {
      /* storage unavailable — choice just isn't remembered */
    }
  }

  return (
    <div className={`sc-map sc-livemap is-${style}`} style={{ height }} role="region" aria-label={label}>
      {badge && (
        <span className="sc-map-badge">
          <Icon name="radar" size={12} /> {badge}
        </span>
      )}
      <div className="sc-map-tools">
        <div className="sc-map-styles" role="radiogroup" aria-label="Map style">
          {Object.entries(BASEMAPS).map(([id, b]) => (
            <button key={id} type="button" role="radio" aria-checked={style === id} className={style === id ? "is-active" : undefined} onClick={() => chooseStyle(id)}>
              {b.label}
            </button>
          ))}
        </div>
        <button type="button" className="sc-map-fit" onClick={() => fitRef.current?.()} aria-label="Fit map to all markers" title="Fit to all markers">
          <Icon name="map" size={15} />
        </button>
      </div>
      <MapContainer center={DEFAULT_CENTER} zoom={11} scrollWheelZoom zoomControl attributionControl style={{ height: "100%", width: "100%" }} worldCopyJump>
        <TileLayer key={style} url={basemap.url} attribution={basemap.attribution} subdomains={basemap.subdomains} maxZoom={19} detectRetina={style !== "satellite"} />
        <AutoFit points={valid} fitKey={`${fitKey}#${idsKey}`} fitRef={fitRef} />
        <ResizeWatcher />

        {valid
          .filter((p) => p.radiusKm)
          .map((p) => (
            <Circle
              key={`area-${p.id}`}
              center={[p.lat, p.lng]}
              radius={p.radiusKm * 1000}
              pathOptions={{ color: p.color, weight: 1.5, dashArray: "6 6", fillColor: p.color, fillOpacity: 0.1 }}
              interactive={false}
            />
          ))}

        {valid.map((p) => (
          <Marker
            key={p.id}
            position={[p.lat, p.lng]}
            icon={markerIcon({ shape: p.shape, color: p.color, pulse: p.pulse, selected: selectedId === p.id })}
            zIndexOffset={selectedId === p.id ? 1000 : p.pulse ? 500 : 0}
            eventHandlers={onSelect ? { click: () => onSelect(p) } : undefined}
            title={p.title || p.label}
            alt={p.label}
          >
            <Tooltip direction="top" className="sc-lm-tip" opacity={1}>
              <div className="sc-lm-tip-title">{p.label}</div>
              {p.sublabel && (
                <div className="sc-lm-tip-sub">
                  <svg width="8" height="8" aria-hidden="true">
                    <circle cx="4" cy="4" r="4" fill={p.color} />
                  </svg>
                  {p.sublabel}
                </div>
              )}
            </Tooltip>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
