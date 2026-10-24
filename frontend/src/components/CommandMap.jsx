import React, { useMemo } from "react";
import { tierColor, toTier } from "../lib/statusTier.js";
import LiveMap from "./LiveMap.jsx";

const TYPE_SHAPES = {
  HOSPITAL: "circle",
  AMBULANCE: "triangle",
  BLOOD_BANK: "diamond",
  POWER: "square",
  DISASTER: "burst",
};

const TYPE_LABELS = {
  HOSPITAL: "Hospital",
  AMBULANCE: "Ambulance",
  BLOOD_BANK: "Blood Bank",
  POWER: "Substation",
  DISASTER: "Disaster",
};

/**
 * Feature 3 — Interactive map, on a real slippy map (Leaflet +
 * OpenStreetMap/CARTO tiles; see LiveMap.jsx). Hover for detail, click
 * to select/pin an entity (shown under the map), pan/zoom freely, and
 * the infrastructure-type filter from the command bar shows/hides layers.
 * Disaster affected areas are drawn at their true radius in km.
 *
 * Every marker comes from points already fetched from a real backend
 * endpoint by CommandCenter.jsx (each already has latitude/longitude
 * from its own service) and passed in as `points`. This component only
 * renders; it never invents data.
 */
export default function CommandMap({ points, activeTypes, onSelect, selectedId }) {
  const visiblePoints = useMemo(() => points.filter((p) => activeTypes.has(p.entityType)), [points, activeTypes]);

  const mapPoints = useMemo(
    () =>
      visiblePoints.map((p) => ({
        id: p.id,
        lat: p.latitude,
        lng: p.longitude,
        color: tierColor(p.statusForColor),
        shape: TYPE_SHAPES[p.entityType],
        label: p.name,
        sublabel: `${TYPE_LABELS[p.entityType]} · ${String(p.statusLabel || p.statusForColor).replace(/_/g, " ")}`,
        radiusKm: p.entityType === "DISASTER" ? p.radiusKm || 5 : undefined,
        pulse: ["CRITICAL", "HIGH"].includes(toTier(p.statusForColor)),
        source: p,
      })),
    [visiblePoints]
  );

  // Re-fit the view when the visible layer set changes, not on every poll.
  const fitKey = [...activeTypes].sort().join(",");

  return (
    <div>
      <LiveMap
        points={mapPoints}
        height={460}
        badge={`${visiblePoints.length} tracked`}
        fitKey={fitKey}
        selectedId={selectedId}
        onSelect={(mp) => onSelect?.(mp.source)}
        label={`Map of ${visiblePoints.length} infrastructure points`}
      />

      <div className="sc-legend">
        {Object.entries(TYPE_LABELS).map(([type, label]) => (
          <span key={type} style={{ opacity: activeTypes.has(type) ? 1 : 0.35 }}>
            <svg width={13} height={13} viewBox="0 0 12 12" aria-hidden="true">
              <LegendShape shape={TYPE_SHAPES[type]} />
            </svg>
            {label}
          </span>
        ))}
        <span style={{ marginLeft: "auto", color: "var(--faint)" }}>Color = status · dashed ring = disaster radius</span>
      </div>
    </div>
  );
}

function LegendShape({ shape }) {
  const c = "#8b9bb3";
  if (shape === "circle") return <circle cx={6} cy={6} r={4} fill={c} />;
  if (shape === "square") return <rect x={2} y={2} width={8} height={8} rx={1} fill={c} />;
  if (shape === "diamond") return <rect x={2.5} y={2.5} width={7} height={7} rx={1} fill={c} transform="rotate(45 6 6)" />;
  if (shape === "triangle") return <polygon points="6,1.5 10.5,10 1.5,10" fill={c} />;
  const pts = [];
  for (let i = 0; i < 16; i++) {
    const a = (Math.PI / 8) * i;
    const r = i % 2 === 0 ? 5.5 : 2.6;
    pts.push(`${6 + r * Math.cos(a)},${6 + r * Math.sin(a)}`);
  }
  return <polygon points={pts.join(" ")} fill={c} />;
}
