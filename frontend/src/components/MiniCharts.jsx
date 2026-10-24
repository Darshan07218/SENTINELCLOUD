import React, { useId, useMemo } from "react";
import { Gauge } from "./ui.jsx";

/**
 * Small, dependency-free chart primitives shared by every dashboard.
 * Every chart in this module renders from data the caller already
 * fetched from a real backend endpoint — nothing here generates or
 * assumes data.
 *
 * Bars are HTML (so labels stay crisp at any width); lines are SVG with
 * non-scaling strokes and HTML point markers, for the same reason.
 */

export function BarChart({ data, labelKey, valueKey, colorFor, color, height = 160, maxOverride, showValues = true }) {
  const max = maxOverride || Math.max(1, ...data.map((d) => d[valueKey]));

  if (data.length === 0) {
    return <EmptyChart height={height} />;
  }

  return (
    <div role="img" aria-label={data.map((d) => `${d[labelKey]}: ${d[valueKey]}`).join(", ")}>
      <div style={{ position: "relative", height, display: "flex", alignItems: "flex-end", gap: "6%", padding: "0 2%" }}>
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <span
            key={f}
            aria-hidden="true"
            style={{ position: "absolute", left: 0, right: 0, bottom: `${f * 82}%`, borderTop: "1px dashed rgba(148,163,184,0.10)" }}
          />
        ))}
        {data.map((d, i) => {
          const c = colorFor ? colorFor(d) : color || "#38bdf8";
          const pct = (d[valueKey] / max) * 82;
          return (
            <div
              key={String(d[labelKey]) + i}
              title={`${d[labelKey]}: ${d[valueKey]}`}
              style={{ position: "relative", flex: 1, height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center" }}
            >
              {showValues && (
                <span className="sc-mono" style={{ fontSize: "0.68rem", color: "var(--text-2)", marginBottom: 4 }}>
                  {d[valueKey]}
                </span>
              )}
              <div
                className="sc-chart-bar"
                style={{
                  width: "100%",
                  maxWidth: 46,
                  height: `${Math.max(pct, 1.2)}%`,
                  borderRadius: "7px 7px 3px 3px",
                  background: `linear-gradient(180deg, ${c}, ${c}55)`,
                  boxShadow: `0 0 18px -4px ${c}aa, inset 0 1px 0 rgba(255,255,255,0.25)`,
                  animationDelay: `${i * 0.05}s`,
                }}
              />
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: "6%", padding: "0.45rem 2% 0", borderTop: "1px solid var(--border)" }}>
        {data.map((d, i) => (
          <span
            key={String(d[labelKey]) + i}
            style={{ flex: 1, textAlign: "center", fontSize: "0.66rem", color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
            title={String(d[labelKey])}
          >
            {String(d[labelKey]).replace(/_/g, " ")}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Area/line chart. `series` is [{ values: number[], color, dashed?, hideDots? }]
 * (hideDots: no per-point markers, for dense hourly series).
 * All series share the x-axis (index) and the y-axis (max across all).
 */
export function LineChart({ series, height = 170, minZero = true, xLabels }) {
  const gradId = useId().replace(/:/g, "");
  const W = 600;
  const H = height;
  const PAD_T = 12;
  const PAD_B = 6;

  const all = series.flatMap((s) => s.values.filter((v) => v != null));
  const longest = Math.max(...series.map((s) => s.values.length + (s.offset || 0)), 0);

  if (all.length === 0 || longest === 0) return <EmptyChart height={height} />;

  const max = Math.max(1, ...all);
  const min = minZero ? Math.min(0, ...all) : Math.min(...all);
  const range = max - min || 1;
  const x = (i) => (longest > 1 ? (i / (longest - 1)) * W : W / 2);
  const y = (v) => PAD_T + (1 - (v - min) / range) * (H - PAD_T - PAD_B);

  return (
    <div>
      <div style={{ position: "relative", height: H }}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }} aria-hidden="true">
          <defs>
            {series.map((s, si) => (
              <linearGradient key={si} id={`${gradId}-${si}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity="0.35" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <line key={f} x1={0} x2={W} y1={PAD_T + f * (H - PAD_T - PAD_B)} y2={PAD_T + f * (H - PAD_T - PAD_B)} stroke="rgba(148,163,184,0.09)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
          ))}
          {series.map((s, si) => {
            const pts = s.values.map((v, i) => (v == null ? null : [x(s.offset ? i + s.offset : i), y(v)])).filter(Boolean);
            if (pts.length === 0) return null;
            const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
            const area = `${line}L${pts[pts.length - 1][0].toFixed(1)},${H}L${pts[0][0].toFixed(1)},${H}Z`;
            return (
              <g key={si}>
                {!s.dashed && <path d={area} fill={`url(#${gradId}-${si})`} />}
                <path
                  d={line}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2.2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  strokeDasharray={s.dashed ? "6 5" : undefined}
                  vectorEffect="non-scaling-stroke"
                  style={{ filter: `drop-shadow(0 0 6px ${s.color}88)` }}
                />
              </g>
            );
          })}
        </svg>
        {series.map((s, si) =>
          !s.hideDots &&
          s.values.map((v, i) =>
            v == null ? null : (
              <span
                key={`${si}-${i}`}
                title={`${s.label ? s.label + ": " : ""}${v}`}
                style={{
                  position: "absolute",
                  left: `${(x(s.offset ? i + s.offset : i) / W) * 100}%`,
                  top: `${(y(v) / H) * 100}%`,
                  width: s.emphasize ? 10 : 6,
                  height: s.emphasize ? 10 : 6,
                  transform: "translate(-50%, -50%)",
                  borderRadius: "50%",
                  background: s.emphasize ? "var(--bg)" : s.color,
                  border: s.emphasize ? `2px solid ${s.color}` : "none",
                  boxShadow: `0 0 8px ${s.color}`,
                }}
              />
            )
          )
        )}
      </div>
      {xLabels && (
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: "0.66rem", color: "var(--faint)" }}>
          {xLabels.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/** A ring chart for status/state breakdowns (e.g. ambulance fleet status, transformer status counts). */
export function DonutChart({ data, labelKey, valueKey, colorFor, size = 150, centerLabel = "total" }) {
  const total = data.reduce((sum, d) => sum + d[valueKey], 0);
  const radius = size / 2 - 14;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;
  const GAP = data.filter((d) => d[valueKey] > 0).length > 1 ? 3 : 0;

  const segments = useMemo(() => {
    let offset = 0;
    return data
      .filter((d) => d[valueKey] > 0)
      .map((d) => {
        const fraction = total > 0 ? d[valueKey] / total : 0;
        const segment = { ...d, fraction, offset };
        offset += fraction;
        return segment;
      });
  }, [data, total, valueKey]);

  if (total === 0) {
    return <EmptyChart height={size} />;
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "1.25rem", flexWrap: "wrap" }}>
      <div style={{ position: "relative", width: size, height: size, flex: "none" }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={segments.map((s) => `${s[labelKey]}: ${s[valueKey]}`).join(", ")}>
          <circle cx={center} cy={center} r={radius} fill="none" stroke="rgba(148,163,184,0.08)" strokeWidth={14} />
          {segments.map((seg) => {
            const c = colorFor ? colorFor(seg) : "#38bdf8";
            const len = Math.max(0, seg.fraction * circumference - GAP);
            return (
              <circle
                key={seg[labelKey]}
                className="sc-donut-seg"
                cx={center}
                cy={center}
                r={radius}
                fill="none"
                stroke={c}
                strokeWidth={14}
                strokeLinecap={GAP ? "round" : "butt"}
                strokeDasharray={`${len} ${circumference}`}
                strokeDashoffset={-seg.offset * circumference}
                transform={`rotate(-90 ${center} ${center})`}
                style={{ filter: `drop-shadow(0 0 5px ${c}88)` }}
              >
                <title>{`${seg[labelKey]}: ${seg[valueKey]}`}</title>
              </circle>
            );
          })}
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center" }}>
          <div>
            <div className="sc-mono" style={{ fontSize: "1.6rem", fontWeight: 700, lineHeight: 1 }}>{total}</div>
            <div style={{ fontSize: "0.6rem", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)", marginTop: 4 }}>{centerLabel}</div>
          </div>
        </div>
      </div>
      <div style={{ display: "grid", gap: 7, flex: 1, minWidth: 140 }}>
        {data
          .filter((d) => d[valueKey] > 0)
          .map((d) => {
            const c = colorFor ? colorFor(d) : "#38bdf8";
            return (
              <div key={d[labelKey]} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.76rem", color: "var(--text-2)" }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: c, boxShadow: `0 0 8px ${c}`, flex: "none" }} />
                <span style={{ flex: 1 }}>{d[labelKey]}</span>
                <span className="sc-mono" style={{ color: "var(--muted)" }}>{d[valueKey]}</span>
              </div>
            );
          })}
      </div>
    </div>
  );
}

/** Horizontal gauge/progress bar — used for occupancy-style percentages (bed occupancy, average power load). */
export function GaugeBar({ label, valuePct, color }) {
  return <Gauge label={label} valuePct={valuePct} color={color} />;
}

export function EmptyChart({ height }) {
  return (
    <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--faint)", fontSize: "0.78rem", border: "1px dashed var(--border-strong)", borderRadius: 12 }}>
      No data yet
    </div>
  );
}
