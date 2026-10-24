import React, { useEffect, useRef, useState } from "react";
import { tierColor, tierLabel } from "../lib/statusTier.js";

/**
 * Shared presentational kit for every page. Pure presentation: no data
 * fetching, no state beyond animation. Classes live in styles.css.
 */

// ---------------------------------------------------------------------
// Icons — inline SVG (lucide-style strokes), no icon font / CDN, CSP-safe.
// ---------------------------------------------------------------------

const ICON_PATHS = {
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />,
  radar: (
    <>
      <path d="M19.07 4.93A10 10 0 1 0 22 12" />
      <path d="M16.24 7.76A6 6 0 1 0 18 12" />
      <circle cx="12" cy="12" r="2" />
      <path d="m13.4 10.6 6.6-6.6" />
    </>
  ),
  command: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  hospital: (
    <>
      <path d="M12 6v4M10 8h4" />
      <path d="M14 22v-4a2 2 0 0 0-4 0v4" />
      <path d="M18 22V5l-6-3-6 3v17" />
      <path d="M4 22h16M6 13h.01M6 17h.01M18 13h.01M18 17h.01" />
    </>
  ),
  ambulance: (
    <>
      <path d="M10 10H6M8 8v4" />
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
      <path d="M19 18h2a1 1 0 0 0 1-1v-3.28a1 1 0 0 0-.68-.95l-1.9-.63a1 1 0 0 1-.6-.53L17.4 8.6A1 1 0 0 0 16.48 8H14" />
      <path d="M8 18h7" />
      <circle cx="17" cy="18" r="2" />
      <circle cx="7" cy="18" r="2" />
    </>
  ),
  droplet: <path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5S5 13 5 15a7 7 0 0 0 7 7Z" />,
  zap: <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />,
  siren: (
    <>
      <path d="M7 18v-6a5 5 0 1 1 10 0v6" />
      <path d="M5 21a1 1 0 0 1-1-1v-1a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1z" />
      <path d="M21 12h1M18.5 4.5 18 5M2 12h1M12 2v1M4.93 4.93l.71.71M12 12v6" />
    </>
  ),
  activity: <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />,
  flask: (
    <>
      <path d="M10 2v7.53a2 2 0 0 1-.21.9L4.72 20.55A1 1 0 0 0 5.62 22h12.76a1 1 0 0 0 .9-1.45l-5.07-10.12a2 2 0 0 1-.21-.9V2" />
      <path d="M8.5 2h7M7 16h10" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5M21 12H9" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  alert: (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  bed: (
    <>
      <path d="M2 4v16M2 8h18a2 2 0 0 1 2 2v10M2 17h20M6 8v9" />
    </>
  ),
  heart: <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />,
  thermometer: <path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z" />,
  server: (
    <>
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <path d="M6 6h.01M6 18h.01" />
    </>
  ),
  map: (
    <>
      <path d="M14.1 5.9 9.9 3.8a2 2 0 0 0-1.8 0L3.6 6A1 1 0 0 0 3 7v12.3a1 1 0 0 0 1.4.9l3.7-1.9a2 2 0 0 1 1.8 0l4.2 2.1a2 2 0 0 0 1.8 0l4.5-2.3a1 1 0 0 0 .6-.9V4.7a1 1 0 0 0-1.4-.9l-3.7 1.9a2 2 0 0 1-1.8 0Z" />
      <path d="M15 5.8v15M9 3.2v15" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  bell: (
    <>
      <path d="M10.27 21a2 2 0 0 0 3.46 0" />
      <path d="M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.96 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33" />
    </>
  ),
  chart: (
    <>
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <path d="M7 16V9M12 16V5M17 16v-4" />
    </>
  ),
  trend: (
    <>
      <path d="m22 7-8.5 8.5-5-5L2 17" />
      <path d="M16 7h6v6" />
    </>
  ),
  layers: (
    <>
      <path d="m12.83 2.18 8.58 3.9a1 1 0 0 1 0 1.83l-8.58 3.9a2 2 0 0 1-1.66 0L2.6 7.91a1 1 0 0 1 0-1.83l8.58-3.9a2 2 0 0 1 1.66 0Z" />
      <path d="m2 12 9.17 4.17a2 2 0 0 0 1.66 0L22 12M2 17l9.17 4.17a2 2 0 0 0 1.66 0L22 17" />
    </>
  ),
  chevron: <path d="m9 18 6-6-6-6" />,
  flame: <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  cpu: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2" />
    </>
  ),
  key: (
    <>
      <path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4" />
      <path d="m21 2-9.6 9.6" />
      <circle cx="7.5" cy="15.5" r="5.5" />
    </>
  ),
  mail: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </>
  ),
  lock: (
    <>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </>
  ),
  arrowRight: <path d="M5 12h14M12 5l7 7-7 7" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20" />
    </>
  ),
};

export function Icon({ name, size, className, style, strokeWidth = 1.8 }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      width={size}
      height={size}
      style={style}
    >
      {ICON_PATHS[name] || ICON_PATHS.info}
    </svg>
  );
}

// ---------------------------------------------------------------------
// Animated number — eases from the previous value to the new one.
// Non-numeric values (strings like "42%" or "—") render as-is.
// ---------------------------------------------------------------------

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function AnimatedNumber({ value, decimals, suffix = "" }) {
  const numeric = typeof value === "number" && Number.isFinite(value);
  // Default precision follows the value itself: integers stay integers.
  const places = decimals ?? (numeric && !Number.isInteger(value) ? 1 : 0);
  const [display, setDisplay] = useState(numeric ? value : 0);
  const fromRef = useRef(0);

  useEffect(() => {
    if (!numeric) return undefined;
    if (prefersReducedMotion()) {
      setDisplay(value);
      fromRef.current = value;
      return undefined;
    }
    const from = fromRef.current;
    const start = performance.now();
    const duration = 900;
    let raf;
    const tick = (now) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (value - from) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      fromRef.current = value;
    };
  }, [value, numeric]);

  if (value === null || value === undefined) return "—";
  if (!numeric) return value;
  return `${display.toFixed(places)}${suffix}`;
}

// ---------------------------------------------------------------------
// Layout pieces
// ---------------------------------------------------------------------

export function PageHeader({ eyebrow, icon, title, subtitle, actions }) {
  return (
    <header className="sc-page-head sc-fade-up">
      <div>
        {eyebrow && (
          <div className="sc-eyebrow">
            {icon && <Icon name={icon} />}
            {eyebrow}
          </div>
        )}
        <h2 className="sc-page-title">{title}</h2>
        {subtitle && <p className="sc-page-sub">{subtitle}</p>}
      </div>
      {actions && <div className="sc-page-actions">{actions}</div>}
    </header>
  );
}

export function Card({ title, subtitle, icon, count, right, children, className = "", style, as: Tag = "section", ...rest }) {
  return (
    <Tag className={`sc-card ${className}`} style={style} {...rest}>
      {(title || right) && (
        <div className="sc-card-head">
          <div style={{ minWidth: 0 }}>
            {title && (
              <h3 className="sc-card-title">
                {icon && (
                  <span className="sc-card-icon">
                    <Icon name={icon} />
                  </span>
                )}
                <span>
                  {title}
                  {count != null && count > 0 && <span className="sc-count">({count})</span>}
                </span>
              </h3>
            )}
            {subtitle && <p className="sc-card-sub" style={icon ? { marginLeft: 40 } : undefined}>{subtitle}</p>}
          </div>
          {right}
        </div>
      )}
      {children}
    </Tag>
  );
}

export function StatCard({ label, value, sublabel, icon, color, accent = false, decimals, suffix }) {
  return (
    <div className="sc-stat" style={color ? { "--stat-color": color } : undefined}>
      <div className="sc-stat-top">
        <span className="sc-stat-label">{label}</span>
        {icon && (
          <span className="sc-stat-icon">
            <Icon name={icon} />
          </span>
        )}
      </div>
      <div className={`sc-stat-value${accent ? " is-accent" : ""}`}>
        <AnimatedNumber value={value} decimals={decimals} suffix={suffix} />
      </div>
      {sublabel && <div className="sc-stat-sub">{sublabel}</div>}
      <span className="sc-stat-bar" aria-hidden="true" />
    </div>
  );
}

export function Tile({ label, value, color }) {
  return (
    <div className="sc-tile">
      <div className="sc-tile-label" title={label}>{label}</div>
      <div className="sc-tile-value" style={color ? { color } : undefined}>
        <AnimatedNumber value={value} />
      </div>
    </div>
  );
}

export function Badge({ label, color, small, noDot, title }) {
  return (
    <span
      className={`sc-badge${small ? " is-small" : ""}${noDot ? " no-dot" : ""}`}
      style={{ "--badge-color": color || "#8b9bb3" }}
      title={title}
    >
      {label}
    </span>
  );
}

/** Badge colored and labelled by the shared four-tier status mapping. */
export function TierBadge({ status, small, label }) {
  return <Badge label={label || tierLabel(status)} color={tierColor(status)} small={small} />;
}

export function LiveDot({ color, live = true, style }) {
  return <span className={`sc-dot${live ? " is-live" : ""}`} style={{ "--dot": color, ...style }} aria-hidden="true" />;
}

export function Alert({ tone = "error", children, role }) {
  const cls = tone === "warn" ? " is-warn" : tone === "ok" ? " is-ok" : tone === "info" ? " is-info" : "";
  const icon = tone === "ok" ? "check" : tone === "info" ? "info" : "alert";
  return (
    <div className={`sc-alert${cls}`} role={role || (tone === "error" ? "alert" : "status")}>
      <Icon name={icon} />
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

export function Empty({ children, icon = "check" }) {
  return (
    <div className="sc-empty">
      <Icon name={icon} />
      <span>{children}</span>
    </div>
  );
}

export function Loading({ label = "Loading…" }) {
  return (
    <div className="sc-loading-screen" role="status">
      <div>
        <div className="sc-loader" aria-hidden="true" />
        {label}
      </div>
    </div>
  );
}

export function SkeletonRows({ rows = 3 }) {
  return (
    <div style={{ display: "grid", gap: 10 }} role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="sc-skel" style={{ height: 14, width: `${90 - i * 14}%` }} />
      ))}
    </div>
  );
}

export function Gauge({ label, valuePct, color }) {
  const clamped = Math.max(0, Math.min(100, valuePct));
  return (
    <div className="sc-gauge">
      <div className="sc-gauge-head">
        <span>{label}</span>
        <b>{valuePct.toFixed(1)}%</b>
      </div>
      <div className="sc-gauge-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={clamped} aria-label={label}>
        <div
          className="sc-gauge-fill"
          style={{ width: `${clamped}%`, background: `linear-gradient(90deg, ${color}99, ${color})`, boxShadow: `0 0 12px ${color}88` }}
        />
      </div>
    </div>
  );
}

/** Background grid + drifting aurora, rendered once behind the app. */
export function Backdrop() {
  return (
    <div className="sc-backdrop" aria-hidden="true">
      <div className="sc-aurora a1" />
      <div className="sc-aurora a2" />
      <div className="sc-aurora a3" />
    </div>
  );
}

export function BrandMark() {
  return (
    <span className="sc-brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
        <path d="M8.5 12.5h2l1-3 2 6 1-3h1.5" />
      </svg>
    </span>
  );
}
