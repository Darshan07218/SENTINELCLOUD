import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext.jsx";
import {
  fetchActiveDisasters,
  fetchDisasters,
  fetchSituationReport,
  createDisaster,
  updateDisasterStatus,
  fetchRecentEvents,
} from "../lib/api.js";
import { connectLiveFeed } from "../lib/socket.js";
import { eventColor, eventLabel, eventTime, isEventEnvelope, mergeEvents } from "../lib/events.js";
import { Alert, Badge, Card, Empty, Icon, LiveDot, PageHeader } from "../components/ui.jsx";
import ResponsePlanPanel from "../components/ResponsePlanPanel.jsx";

// Mirrors DISASTER_STATUS_TRANSITIONS in disaster-service (the server
// enforces it; this only decides which buttons to offer).
const NEXT_STATUSES = {
  ACTIVE: [
    { status: "CONTAINED", label: "Mark Contained", color: "#f59e0b" },
    { status: "RESOLVED", label: "Mark Resolved", color: "#22c55e" },
  ],
  CONTAINED: [
    { status: "ACTIVE", label: "Re-activate", color: "#ef4444" },
    { status: "RESOLVED", label: "Mark Resolved", color: "#22c55e" },
  ],
  RESOLVED: [],
};

const DISASTER_TYPES = ["FLOOD", "FIRE", "EARTHQUAKE", "CYCLONE", "LANDSLIDE", "INDUSTRIAL_ACCIDENT"];
const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

const SEVERITY_COLORS = { LOW: "#3b82f6", MEDIUM: "#f59e0b", HIGH: "#f97316", CRITICAL: "#ef4444" };
const STATUS_COLORS = { ACTIVE: "#ef4444", CONTAINED: "#f59e0b", RESOLVED: "#22c55e" };

function ConnectionIndicator({ status }) {
  const config = {
    open: { color: "#22c55e", label: "Live" },
    connecting: { color: "#f59e0b", label: "Connecting…" },
    closed: { color: "#ef4444", label: "Disconnected — retrying" },
    ended: { color: "#94a3b8", label: "Session ended — sign in again for live updates" },
  }[status] || { color: "#94a3b8", label: "Unknown" };

  return (
    <span role="status" className="sc-clock" style={{ color: config.color }}>
      <LiveDot color={config.color} live={status === "open"} />
      {config.label}
    </span>
  );
}

function CreateDisasterForm({ onCreated }) {
  const { authFetch } = useAuth();
  const [form, setForm] = useState({
    type: "FLOOD",
    severity: "HIGH",
    latitude: "18.52",
    longitude: "73.85",
    radiusKm: "15",
    description: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await authFetch((token) =>
        createDisaster(token, {
          type: form.type,
          severity: form.severity,
          latitude: Number(form.latitude),
          longitude: Number(form.longitude),
          radiusKm: Number(form.radiusKm),
          description: form.description,
        })
      );
      setForm((f) => ({ ...f, description: "" }));
      onCreated?.(result.disaster);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card as="form" onSubmit={handleSubmit} title="Report a Disaster" icon="plus" subtitle="Publishes DISASTER_DETECTED to every domain service.">
      <FormBody form={form} setForm={setForm} submitting={submitting} error={error} />
    </Card>
  );
}

// Split out so the <form> element can own onSubmit (Card renders the wrapper).
function FormBody({ form, setForm, submitting, error }) {
  return (
    <>
      <div className="sc-form-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.85rem", marginBottom: "0.85rem" }}>
        <div>
          <label className="sc-label" htmlFor="dis-type">Type</label>
          <select id="dis-type" className="sc-select" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {DISASTER_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace("_", " ")}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="sc-label" htmlFor="dis-severity">Severity</label>
          <select id="dis-severity" className="sc-select" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="sc-label" htmlFor="dis-lat">Latitude</label>
          <input id="dis-lat" className="sc-input sc-mono" type="number" step="any" min="-90" max="90" value={form.latitude} onChange={(e) => setForm({ ...form, latitude: e.target.value })} required />
        </div>
        <div>
          <label className="sc-label" htmlFor="dis-lng">Longitude</label>
          <input id="dis-lng" className="sc-input sc-mono" type="number" step="any" min="-180" max="180" value={form.longitude} onChange={(e) => setForm({ ...form, longitude: e.target.value })} required />
        </div>
        <div>
          <label className="sc-label" htmlFor="dis-radius">Affected radius (km)</label>
          <input id="dis-radius" className="sc-input sc-mono" type="number" step="any" min="0.1" max="500" value={form.radiusKm} onChange={(e) => setForm({ ...form, radiusKm: e.target.value })} required />
        </div>
      </div>
      <label className="sc-label" htmlFor="dis-description">Description</label>
      <textarea
        id="dis-description"
        className="sc-textarea"
        style={{ marginBottom: "0.85rem" }}
        value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })}
        placeholder="What's happening, and where — at least a few words for responders."
        required
        minLength={5}
      />
      {error && <Alert>{error}</Alert>}
      <button type="submit" disabled={submitting} className="sc-btn is-danger">
        {submitting ? (
          <>
            <span className="sc-spinner" aria-hidden="true" /> Publishing…
          </>
        ) : (
          <>
            <Icon name="siren" /> Publish Disaster
          </>
        )}
      </button>
    </>
  );
}

const SERVICE_SECTIONS = [
  { key: "hospital", icon: "hospital", title: "Hospital Service" },
  { key: "ambulance", icon: "ambulance", title: "Ambulance Service" },
  { key: "bloodBank", icon: "droplet", title: "Blood Bank Service" },
  { key: "power", icon: "zap", title: "Power Service" },
];

function describeSection(key, r) {
  if (key === "hospital")
    return `${r.nearbyHospitalCount} nearby hospitals — ${r.totalAvailableBeds} beds, ${r.totalAvailableIcuBeds} ICU beds, ${r.totalAvailableVentilators} ventilators available`;
  if (key === "ambulance") return `${r.availableAmbulanceCount} ambulances available nearby`;
  if (key === "bloodBank") return `${r.nearbyBloodBankCount} nearby blood banks — ${r.shortageAlertCount} shortage alert(s) at those banks`;
  return `${r.nearbySubstationCount} nearby substations — ${r.totalAtRiskTransformerCount} at-risk transformer(s)`;
}

function SituationReportPanel({ disaster, onClose, canManage, onStatusChanged }) {
  const { authFetch } = useAuth();
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [changing, setChanging] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await authFetch((token) => fetchSituationReport(token, disaster.id));
      setReport(result.situationReport);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [authFetch, disaster.id]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [load]);

  async function handleSetStatus(status) {
    setChanging(true);
    try {
      await authFetch((token) => updateDisasterStatus(token, disaster.id, status));
      setError(null);
      await load();
      onStatusChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setChanging(false);
    }
  }

  // Buttons follow the report's status (re-fetched every 4 s), not the
  // list entry the panel was opened from — that copy goes stale as soon
  // as anyone changes the status.
  const actions = report ? NEXT_STATUSES[report.status] || [] : [];
  const progress = report ? (report.respondedServices / (report.totalExpectedServices || 1)) * 100 : 0;

  return (
    <Card
      className="sc-fade-up"
      title={`${disaster.type.replace("_", " ")} — Situation Report`}
      icon="radar"
      subtitle={disaster.description}
      right={
        <button type="button" onClick={onClose} aria-label="Close situation report" className="sc-icon-btn">
          <Icon name="x" />
        </button>
      }
    >
      {error && <Alert>{error}</Alert>}

      {report && (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: "0.6rem" }}>
            <Badge label={report.severity} color={SEVERITY_COLORS[report.severity]} />
            <Badge label={report.status} color={STATUS_COLORS[report.status]} />
          </div>
          <div className="sc-gauge" style={{ marginBottom: "1rem" }}>
            <div className="sc-gauge-head">
              <span>{report.fullyReported ? "Fully reported" : "Awaiting more responses"}</span>
              <b>
                {report.respondedServices}/{report.totalExpectedServices} services
              </b>
            </div>
            <div className="sc-gauge-track">
              <div className="sc-gauge-fill" style={{ width: `${progress}%`, background: report.fullyReported ? "#22c55e" : "linear-gradient(90deg, #0ea5e9, #6366f1)" }} />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.6rem" }}>
            {SERVICE_SECTIONS.map((s) => {
              const r = report[s.key];
              const responded = Boolean(r.respondedAt);
              return (
                <div key={s.key} className="sc-inset" style={{ borderColor: responded ? "rgba(34,197,94,0.25)" : undefined }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span className="sc-stat-icon" style={{ "--stat-color": responded ? "#22c55e" : "#8b9bb3" }}>
                      <Icon name={s.icon} />
                    </span>
                    <span style={{ fontSize: "0.8rem", fontWeight: 650, flex: 1 }}>{s.title}</span>
                    {responded ? <LiveDot color="#22c55e" live={false} /> : <span className="sc-spinner" style={{ borderColor: "rgba(148,163,184,0.25)", borderTopColor: "#8b9bb3", width: 12, height: 12 }} aria-hidden="true" />}
                  </div>
                  {responded ? (
                    <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-2)", lineHeight: 1.5 }}>{describeSection(s.key, r)}</p>
                  ) : (
                    <p style={{ margin: 0, fontSize: "0.76rem", color: "var(--faint)", fontStyle: "italic" }}>{r.message}</p>
                  )}
                </div>
              );
            })}
          </div>

          {canManage && actions.length > 0 && (
            <div style={{ display: "flex", gap: 8, marginTop: "1rem", flexWrap: "wrap" }}>
              {actions.map((a) => (
                <button key={a.status} type="button" disabled={changing} onClick={() => handleSetStatus(a.status)} className="sc-btn is-tone is-sm" style={{ "--btn-color": a.color }}>
                  {a.label}
                </button>
              ))}
            </div>
          )}
          {report.statusNote && <p className="sc-hint" style={{ marginTop: "0.75rem" }}>Status note: {report.statusNote}</p>}
        </>
      )}
    </Card>
  );
}

export default function EmergencyDashboard() {
  const { authFetch, user, getAccessToken } = useAuth();
  const [activeDisasters, setActiveDisasters] = useState([]);
  const [recentDisasters, setRecentDisasters] = useState([]);
  const [selectedDisaster, setSelectedDisaster] = useState(null);
  const [liveEvents, setLiveEvents] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [error, setError] = useState(null);
  const [planSignal, setPlanSignal] = useState(0);
  const disconnectRef = useRef(null);

  const canReport = user && ["EMERGENCY_OPERATOR", "SYSTEM_ADMIN"].includes(user.role);

  const loadDisasters = useCallback(async () => {
    // allSettled: one failing list must not blank the other.
    const [activeRes, allRes] = await Promise.allSettled([
      authFetch((token) => fetchActiveDisasters(token)),
      authFetch((token) => fetchDisasters(token, { limit: 10 })),
    ]);
    if (activeRes.status === "fulfilled") setActiveDisasters(activeRes.value.disasters);
    if (allRes.status === "fulfilled") setRecentDisasters(allRes.value.disasters);
    const failed = [activeRes, allRes].find((r) => r.status === "rejected");
    setError(failed ? failed.reason?.message || "Could not load disasters." : null);
  }, [authFetch]);

  useEffect(() => {
    loadDisasters();
  }, [loadDisasters]);

  // Bootstrap the live feed panel with recent history (so it isn't empty
  // on first load), then subscribe to the WebSocket for everything after
  // that — see lib/socket.js and notification-service/src/index.js.
  useEffect(() => {
    authFetch((token) => fetchRecentEvents(token, 30))
      .then((res) => setLiveEvents((prev) => mergeEvents(prev, res.events || [], 100)))
      .catch(() => {});

    disconnectRef.current = connectLiveFeed({
      getToken: getAccessToken,
      onStatusChange: setConnectionStatus,
      onMessage: (frame) => {
        if (frame?.type !== "event" || !isEventEnvelope(frame.event)) return;
        setLiveEvents((prev) => mergeEvents(prev, [frame.event], 100));
        // Only disaster lifecycle events change the disaster lists; the
        // situation report panel picks up reactions on its own 4 s poll.
        if (frame.event.eventType.startsWith("disaster.")) {
          loadDisasters();
        }
        // Phase 15: plan proposed/decided, or a command finished → refresh the plan card.
        if (frame.event.eventType.startsWith("response.") || frame.event.eventType.startsWith("command.")) {
          setPlanSignal((n) => n + 1);
        }
      },
    });

    return () => disconnectRef.current?.();
  }, [authFetch, getAccessToken, loadDisasters]);

  const displayedFeed = useMemo(() => [...liveEvents].reverse(), [liveEvents]);

  return (
    <section>
      <PageHeader
        eyebrow="Operations"
        icon="siren"
        title="Live Emergency Dashboard"
        subtitle="Active disasters, cross-service situation reports and the real-time event bus."
        actions={<ConnectionIndicator status={connectionStatus} />}
      />

      {error && <Alert>{error}</Alert>}

      <div className="sc-split" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.3fr) minmax(0, 1fr)", gap: "1.1rem", alignItems: "start" }}>
        <div className="sc-stack">
          <Card title="Active Disasters" icon="flame" count={activeDisasters.length}>
            {activeDisasters.length === 0 ? (
              <Empty>No active disasters right now.</Empty>
            ) : (
              <ul className="sc-list">
                {activeDisasters.map((d) => (
                  <li key={d.id} style={{ background: selectedDisaster?.id === d.id ? "rgba(56,189,248,0.07)" : undefined }}>
                    <button type="button" className="sc-list-btn" onClick={() => setSelectedDisaster(d)}>
                      <Badge label={d.severity} color={SEVERITY_COLORS[d.severity]} />
                      <span className="sc-list-main">
                        <span className="sc-list-title" style={{ display: "block" }}>{d.type.replace("_", " ")}</span>
                        <span className="sc-list-meta" style={{ display: "block" }}>
                          {d.description.slice(0, 80)}
                          {d.description.length > 80 ? "…" : ""}
                        </span>
                      </span>
                      <span className="sc-list-aside">View report</span>
                      <Icon name="chevron" className="sc-chev" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {selectedDisaster && (
            <SituationReportPanel
              key={selectedDisaster.id}
              disaster={selectedDisaster}
              canManage={canReport}
              onStatusChanged={loadDisasters}
              onClose={() => setSelectedDisaster(null)}
            />
          )}

          {selectedDisaster && (
            <ResponsePlanPanel key={`plan-${selectedDisaster.id}`} disasterId={selectedDisaster.id} canDecide={canReport} refreshSignal={planSignal} />
          )}

          {!selectedDisaster && canReport && (
            <CreateDisasterForm
              onCreated={(disaster) => {
                loadDisasters();
                setSelectedDisaster(disaster);
              }}
            />
          )}

          {!selectedDisaster && !canReport && (
            <Card title="Recent Disasters" icon="clock">
              {recentDisasters.length === 0 ? (
                <Empty icon="info">No disasters recorded yet.</Empty>
              ) : (
                <ul className="sc-list">
                  {recentDisasters.map((d) => (
                    <li key={d.id}>
                      <button type="button" className="sc-list-btn" onClick={() => setSelectedDisaster(d)}>
                        <Badge label={d.status} color={STATUS_COLORS[d.status]} small />
                        <span className="sc-list-main sc-list-title">
                          {d.type.replace("_", " ")} — {d.description.slice(0, 50)}
                        </span>
                        <Icon name="chevron" className="sc-chev" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>

        <Card title="Live Event Feed" icon="activity" subtitle={`${displayedFeed.length} event(s)`} right={<LiveDot color={connectionStatus === "open" ? "#22c55e" : "#f59e0b"} live={connectionStatus === "open"} />}>
          {displayedFeed.length === 0 ? (
            <Empty icon="clock">No events yet — waiting for the bus…</Empty>
          ) : (
            <ol className="sc-timeline" style={{ maxHeight: 620, overflowY: "auto" }}>
              {displayedFeed.map((evt) => (
                <li key={evt.eventId} style={{ "--tl-color": eventColor(evt.eventType) }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <Badge label={eventLabel(evt.eventType)} color={eventColor(evt.eventType)} small noDot />
                    <span className="sc-mono" style={{ fontSize: "0.66rem", color: "var(--faint)" }}>{eventTime(evt)}</span>
                  </div>
                  <div style={{ fontSize: "0.7rem", color: "var(--muted)", marginTop: 4 }}>
                    from {String(evt.sourceService || "unknown")}{" "}
                    {typeof evt.correlationId === "string" && <span className="sc-mono" style={{ color: "var(--faint)" }}>· {evt.correlationId.slice(0, 8)}</span>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </section>
  );
}
