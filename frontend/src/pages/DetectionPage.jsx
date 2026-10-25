import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";
import { fetchIntakeOverview, fetchDetections, confirmDetection, dismissDetection, pollIntakeSources, injectDemoDetection } from "../lib/api.js";
import { tierColor } from "../lib/statusTier.js";
import LiveMap from "../components/LiveMap.jsx";
import { Alert, Badge, Card, Empty, PageHeader, Tile } from "../components/ui.jsx";

/**
 * Phase 19: automatic disaster detection (docs/PHASE-19-AUTO-DETECTION.md).
 * intake-service polls USGS earthquakes and Open-Meteo rain/wind for the
 * watched city. Severe detections become disasters on their own; the rest
 * wait here for an operator to confirm or dismiss.
 */
const DISASTER_TYPES = ["FLOOD", "FIRE", "EARTHQUAKE", "CYCLONE", "LANDSLIDE", "INDUSTRIAL_ACCIDENT"];
const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const STATUS_COLORS = {
  PENDING: "#38bdf8",
  CONFIRMING: "#38bdf8",
  CONFIRMED: "#22c55e",
  AUTO_CONFIRMED: "#a78bfa",
  DISMISSED: "#8b9bb3",
  EXPIRED: "#8b9bb3",
  FAILED: "#ef4444",
};
const SOURCE_LABELS = { USGS: "USGS", OPEN_METEO: "Open-Meteo", DEMO: "Demo" };
const DECIDERS = ["EMERGENCY_OPERATOR", "SYSTEM_ADMIN"];

function ago(iso) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const label = (t) => t.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());

function SourceCard({ source, canPoll, busy, onPoll }) {
  const state = !source.enabled ? ["OFF", "#8b9bb3"] : !source.lastPolledAt ? ["WAITING", "#38bdf8"] : source.lastError ? ["ERROR", "#ef4444"] : ["OK", "#22c55e"];
  const r = source.reading || {};
  return (
    <div className="sc-inset">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: "0.6rem" }}>
        <b>{source.label}</b>
        <Badge label={state[0]} color={state[1]} small />
      </div>
      <div className="sc-stats" style={{ marginBottom: "0.5rem" }}>
        {source.source === "USGS" ? (
          <>
            <Tile label="Quakes in range" value={source.lastFound ?? 0} />
            <Tile label="Watch radius km" value={r.watchRadiusKm ?? 0} />
          </>
        ) : (
          <>
            <Tile label="Rain next 24 h (mm)" value={r.rain24hMm ?? 0} color={(r.rain24hMm ?? 0) >= 64.5 ? "#f97316" : undefined} />
            <Tile label="Max gust (km/h)" value={r.maxGustKmh ?? 0} color={(r.maxGustKmh ?? 0) >= 62 ? "#f97316" : undefined} />
          </>
        )}
      </div>
      <p className="sc-hint" style={{ margin: 0 }}>
        {source.enabled ? `Polled every ${Math.round(source.intervalSeconds / 60)} min · last ${ago(source.lastPolledAt)}` : "Turned off (INTAKE_SOURCES)"}
        {source.source === "USGS" && r.minMagnitude != null ? ` · M${r.minMagnitude}+` : ""}
        {source.source === "OPEN_METEO" ? " · alerts from 64.5 mm (IMD heavy rain) or 62 km/h gusts" : ""}
      </p>
      {source.lastError && (
        <p className="sc-field-error" role="alert">
          Last poll failed: {source.lastError}
        </p>
      )}
      {canPoll && source.enabled && (
        <button type="button" disabled={busy} onClick={onPoll} className="sc-btn is-tone is-sm" style={{ "--btn-color": "#38bdf8", marginTop: "0.6rem" }}>
          Poll now
        </button>
      )}
    </div>
  );
}

export default function DetectionPage() {
  const { authFetch, user } = useAuth();
  const canDecide = DECIDERS.includes(user?.role);
  const isAdmin = user?.role === "SYSTEM_ADMIN";
  const [overview, setOverview] = useState(null);
  const [detections, setDetections] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState({ type: "FLOOD", severity: "HIGH" });

  const load = useCallback(async () => {
    try {
      const [o, d] = await Promise.all([authFetch((t) => fetchIntakeOverview(t)), authFetch((t) => fetchDetections(t, { limit: 100 }))]);
      setOverview(o);
      setDetections(d.detections || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [authFetch]);

  useEffect(() => {
    load();
    const poll = setInterval(load, 5000);
    return () => clearInterval(poll);
  }, [load]);

  async function act(fn, successText) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await authFetch(fn);
      setNotice(typeof successText === "function" ? successText(result) : successText);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const pending = detections.filter((d) => d.status === "PENDING" || d.status === "FAILED" || d.status === "CONFIRMING");
  const mapPoints = useMemo(
    () =>
      detections
        .filter((d) => !["DISMISSED", "EXPIRED"].includes(d.status))
        .slice(0, 30)
        .map((d) => ({
          id: d.id,
          lat: d.latitude,
          lng: d.longitude,
          color: tierColor(d.severity),
          shape: "burst",
          radiusKm: d.radiusKm,
          pulse: d.status === "PENDING",
          label: d.title,
          sublabel: `${SOURCE_LABELS[d.source] || d.source} · ${d.severity} · ${label(d.status)}`,
        })),
    [detections]
  );

  const watch = overview?.watch;
  const policy = overview?.policy;

  return (
    <section>
      <PageHeader
        eyebrow="Operations"
        icon="radar"
        title="Auto-Detection"
        subtitle={
          watch
            ? `Watching ${watch.name} for earthquakes (USGS, within ${watch.radiusKm} km, M${watch.minMagnitude}+) and heavy rain or storms (Open-Meteo). ` +
              (policy.autoConfirmMinSeverity === "NONE"
                ? "Every detection waits for an operator."
                : `${policy.autoConfirmMinSeverity}${policy.autoConfirmMinSeverity === "CRITICAL" ? "" : " and above"} becomes a disaster automatically; the rest wait for an operator.`)
            : "Disasters detected automatically from public earthquake and weather feeds."
        }
      />

      {error && <Alert>{error}</Alert>}
      {notice && (
        <Alert tone="ok" role="status">
          {notice}
        </Alert>
      )}

      <div className="sc-grid-2 sc-section">
        {(overview?.sources || []).map((s) => (
          <SourceCard
            key={s.source}
            source={s}
            canPoll={canDecide}
            busy={busy}
            onPoll={() => act((t) => pollIntakeSources(t), (r) => (r.newDetections ? `${r.newDetections} new detection(s).` : "Polled: nothing new."))}
          />
        ))}
      </div>

      <div className="sc-split sc-section" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1fr)", gap: "1.1rem", alignItems: "start" }}>
        <Card title="Waiting for a decision" icon="bell" count={pending.length}>
          {pending.length === 0 ? (
            <Empty>Nothing waiting. New detections appear here within minutes of a feed reporting them.</Empty>
          ) : (
            <div className="sc-stack">
              {pending.map((d) => (
                <div key={d.id} className="sc-inset">
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 6 }}>
                    <Badge label={d.severity} color={tierColor(d.severity)} small />
                    <Badge label={label(d.type)} color="#38bdf8" small noDot />
                    <Badge label={SOURCE_LABELS[d.source] || d.source} color="#8b9bb3" small noDot />
                    {d.status !== "PENDING" && <Badge label={d.status} color={STATUS_COLORS[d.status]} small />}
                    <span className="sc-mono" style={{ marginLeft: "auto", fontSize: "0.7rem", color: "var(--faint)" }}>
                      {ago(d.detectedAt)}
                    </span>
                  </div>
                  <div className="sc-cell-strong">{d.title}</div>
                  <p className="sc-hint" style={{ margin: "0.3rem 0 0" }}>
                    {d.description} Affected radius {d.radiusKm} km.
                  </p>
                  {d.error && <p className="sc-field-error">Last attempt failed: {d.error}</p>}
                  {canDecide && d.status !== "CONFIRMING" && (
                    <div style={{ display: "flex", gap: 8, marginTop: "0.7rem" }}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => act((t) => confirmDetection(t, d.id), "Confirmed: the disaster was created and the response has started.")}
                        className="sc-btn is-tone is-sm"
                        style={{ "--btn-color": "#22c55e" }}
                      >
                        Confirm disaster
                      </button>
                      <button type="button" disabled={busy} onClick={() => act((t) => dismissDetection(t, d.id), "Dismissed.")} className="sc-btn is-tone is-sm" style={{ "--btn-color": "#8b9bb3" }}>
                        Dismiss
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Where" icon="map" subtitle="Recent detections; dashed ring = affected radius">
          <LiveMap points={mapPoints} height={340} badge={`${mapPoints.length} shown`} label="Detection map" />
        </Card>
      </div>

      {isAdmin && (
        <Card title="Simulate a detection" icon="flask" subtitle="Real earthquakes and storms near the city are rare. A DEMO detection goes through exactly the same pipeline, clearly labelled." className="sc-section">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "end" }}>
            <label>
              <span className="sc-label">Type</span>
              <select className="sc-select is-sm" value={demo.type} onChange={(e) => setDemo({ ...demo, type: e.target.value })}>
                {DISASTER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {label(t)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="sc-label">Severity</span>
              <select className="sc-select is-sm" value={demo.severity} onChange={(e) => setDemo({ ...demo, severity: e.target.value })}>
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                act(
                  (t) => injectDemoDetection(t, demo),
                  (r) => (r.detection.status === "AUTO_CONFIRMED" ? "Detected and auto-confirmed: the disaster was created." : "Detected: it is waiting for a decision above.")
                )
              }
              className="sc-btn is-tone is-sm"
              style={{ "--btn-color": "#a78bfa" }}
            >
              Inject detection
            </button>
          </div>
        </Card>
      )}

      <Card title="History" icon="clock" count={detections.length} className="sc-card-flush" style={{ padding: 0 }}>
        {detections.length === 0 ? (
          <Empty icon="info">No detections yet.</Empty>
        ) : (
          <div className="sc-table-scroll">
            <table className="sc-table" style={{ minWidth: 760 }}>
              <thead>
                <tr>
                  <th>Detected</th>
                  <th>Source</th>
                  <th>Event</th>
                  <th>Severity</th>
                  <th>Status</th>
                  <th>Decided by</th>
                </tr>
              </thead>
              <tbody>
                {detections.map((d) => (
                  <tr key={d.id}>
                    <td className="sc-mono">{ago(d.detectedAt)}</td>
                    <td>{SOURCE_LABELS[d.source] || d.source}</td>
                    <td>
                      <div className="sc-cell-strong">{d.title}</div>
                      {d.disasterId && (
                        <div className="sc-cell-sub">
                          <Link to="/emergency">Disaster created</Link>
                        </div>
                      )}
                    </td>
                    <td>
                      <Badge label={d.severity} color={tierColor(d.severity)} small />
                    </td>
                    <td>
                      <Badge label={d.status} color={STATUS_COLORS[d.status] || "#8b9bb3"} small />
                    </td>
                    <td className="sc-mono">{d.decidedBy || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </section>
  );
}
