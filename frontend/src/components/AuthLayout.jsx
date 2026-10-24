import React from "react";
import { BrandMark, Icon } from "./ui.jsx";

/** Decorative radar for the sign-in hero. Purely ornamental — no data. */
function Radar() {
  const rings = [60, 120, 180, 240];
  return (
    <svg className="sc-auth-radar" viewBox="0 0 560 560" aria-hidden="true">
      <defs>
        <radialGradient id="auth-radar-bg" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="auth-radar-sweep" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#38bdf8" stopOpacity="0" />
          <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.45" />
        </linearGradient>
      </defs>
      <circle cx="280" cy="280" r="270" fill="url(#auth-radar-bg)" />
      {rings.map((r) => (
        <circle key={r} cx="280" cy="280" r={r} fill="none" stroke="rgba(56,189,248,0.18)" strokeDasharray={r === 240 ? "2 6" : undefined} />
      ))}
      <line x1="280" y1="20" x2="280" y2="540" stroke="rgba(56,189,248,0.10)" />
      <line x1="20" y1="280" x2="540" y2="280" stroke="rgba(56,189,248,0.10)" />
      <g className="sc-radar-sweep">
        <path d="M280 280 L520 280 A240 240 0 0 0 449.7 110.3 Z" fill="url(#auth-radar-sweep)" />
      </g>
      {[
        [360, 200, "#22c55e", 0],
        [210, 330, "#eab308", 0.6],
        [330, 390, "#ef4444", 1.2],
        [180, 190, "#38bdf8", 1.8],
        [420, 320, "#c084fc", 0.9],
      ].map(([x, y, c, d]) => (
        <g key={`${x}-${y}`}>
          <circle cx={x} cy={y} r="10" fill="none" stroke={c} className="sc-pulse-ring" style={{ animationDelay: `${d}s` }} />
          <circle cx={x} cy={y} r="4" fill={c} />
        </g>
      ))}
    </svg>
  );
}

const FEATURES = [
  { icon: "radar", title: "Live command", text: "Every service on one real-time map" },
  { icon: "siren", title: "Rapid response", text: "Disasters fan out to every domain" },
  { icon: "shield", title: "Self-healing", text: "Kubernetes recovery, observed live" },
];

export default function AuthLayout({ children }) {
  return (
    <div className="sc-auth">
      <aside className="sc-auth-hero">
        <div style={{ display: "flex", alignItems: "center", gap: "0.7rem", position: "relative", zIndex: 1 }}>
          <BrandMark />
          <div>
            <div className="sc-brand-name">SentinelCloud</div>
            <div className="sc-brand-tag">Critical Infrastructure Intelligence</div>
          </div>
        </div>

        <Radar />

        <div style={{ position: "relative", zIndex: 1 }}>
          <div className="sc-eyebrow">
            <Icon name="globe" /> Emergency response platform
          </div>
          <h2>
            See every crisis.
            <br />
            <span className="sc-grad">Coordinate every response.</span>
          </h2>
          <p>
            Hospitals, ambulances, blood banks and the power grid, streamed into one cloud-native command center built for the
            moments that matter most.
          </p>
        </div>

        <div className="sc-auth-features">
          {FEATURES.map((f) => (
            <div key={f.title} className="sc-auth-feature">
              <Icon name={f.icon} />
              <b>{f.title}</b>
              <span>{f.text}</span>
            </div>
          ))}
        </div>
      </aside>

      <div className="sc-auth-panel">
        <div style={{ width: "100%", maxWidth: 420 }}>
          <div className="sc-auth-mobile-brand">
            <div style={{ display: "flex", alignItems: "center", gap: "0.7rem" }}>
              <BrandMark />
              <div className="sc-brand-name">SentinelCloud</div>
            </div>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
