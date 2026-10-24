import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext.jsx";
import {
  fetchResilienceScenarios,
  fetchResilienceOverview,
  fetchResilienceRun,
  startResilienceDrill,
  abortResilienceDrill,
} from "../lib/api.js";
import { TIER_COLORS } from "../lib/statusTier.js";
import { Alert, Icon, PageHeader } from "../components/ui.jsx";
// Phase 12: in a stylesheet, not an inline <style>, so the CSP can forbid inline styles.
import "./ResiliencePage.css";

/**
 * Resilience Demo (Phase 11).
 *
 * An administrator picks a failure scenario; resilience-service injects a
 * real SOFTWARE fault into one of SentinelCloud's own pods and moves the
 * drill through Normal → Failure → Detection → Recovery → Restored only
 * when the cluster actually gets there. This page polls the drill once a
 * second and draws exactly what the backend observed: pod states, which
 * replica answered each live request, the autoscaler, the queue. Nothing
 * here is animated or scripted on the client.
 */

const C = {
  bg: "#050a16",
  panel: "rgba(15, 23, 42, 0.6)",
  panelRaised: "rgba(4, 8, 18, 0.55)",
  line: "rgba(148, 163, 184, 0.14)",
  text: "#e8eef8",
  muted: "#8b9bb3",
  faint: "#56657d",
  accent: "#38bdf8",
};

// Banner/stage levels use the Command Center's four status tiers.
const LEVEL = {
  normal: { color: TIER_COLORS.NORMAL, tint: "rgba(34,197,94,0.10)" },
  failed: { color: TIER_COLORS.CRITICAL, tint: "rgba(239,68,68,0.14)" },
  detecting: { color: TIER_COLORS.HIGH, tint: "rgba(249,115,22,0.12)" },
  recovering: { color: TIER_COLORS.WARNING, tint: "rgba(234,179,8,0.11)" },
  restored: { color: TIER_COLORS.NORMAL, tint: "rgba(34,197,94,0.12)" },
};

const STAGES = [
  { id: "NORMAL", label: "Normal State", level: "normal" },
  { id: "FAILURE", label: "Failure", level: "failed" },
  { id: "DETECTION", label: "Detection", level: "detecting" },
  { id: "RECOVERY", label: "Recovery", level: "recovering" },
  { id: "RESTORED", label: "Restored State", level: "restored" },
];

// Pod identity colours: deliberately NOT status colours, so red always means "failed request".
const POD_COLORS = ["#60a5fa", "#c084fc", "#2dd4bf", "#f9a8d4", "#a5b4fc", "#fcd34d"];

const shortPod = (name = "") => name.split("-").slice(-2).join("-");
const fmtSec = (s) => (s == null ? "—" : s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);

// ---------------------------------------------------------------------------

export default function ResiliencePage() {
  const { user, authFetch } = useAuth();
  const isAdmin = user?.role === "SYSTEM_ADMIN";
  const [catalogue, setCatalogue] = useState(null);
  const [overview, setOverview] = useState(null);
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState({ runId: null, points: [] });

  const running = run?.status === "running";

  // The poller reads authFetch through a ref, so it never restarts (or
  // fires an extra request) just because the auth context re-rendered.
  const authFetchRef = useRef(authFetch);
  authFetchRef.current = authFetch;

  const refresh = useCallback(async () => {
    const authFetch = authFetchRef.current;
    try {
      const { run: current } = await authFetch((t) => fetchResilienceRun(t));
      setRun(current);
      if (current?.view?.target) {
        // Replica history for the scaling chart, accumulated client-side per run.
        const t = current.view.target;
        setHistory((h) => {
          const base = h.runId === current.id ? h.points : [];
          const point = {
            t: Date.now(),
            ready: t.pods.filter((p) => p.ready).length,
            desired: t.hpa?.desiredReplicas ?? null,
            cpu: t.hpa?.cpuPercent ?? null,
          };
          return { runId: current.id, points: [...base, point].slice(-240) };
        });
      }
      if (!current || current.status !== "running") {
        setOverview(await authFetch((t) => fetchResilienceOverview(t)));
      }
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    authFetchRef.current((t) => fetchResilienceScenarios(t)).then(setCatalogue).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, running ? 1000 : 5000);
    return () => clearInterval(id);
  }, [refresh, running]);

  async function start(scenario) {
    const ok = window.confirm(
      `Run "${scenario.title}"?\n\nThis deliberately fails part of SentinelCloud in this cluster (${scenario.target}) ` +
        `so you can watch Kubernetes recover it. It takes about ${Math.round(scenario.estimatedSeconds / 10) * 10}s.`
    );
    if (!ok) return;
    setBusy(true);
    try {
      const { run: started } = await authFetch((t) => startResilienceDrill(t, scenario.id));
      setRun(started);
      setHistory({ runId: started.id, points: [] });
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function abort() {
    setBusy(true);
    try {
      await authFetch((t) => abortResilienceDrill(t));
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 1240, margin: "0 auto", color: C.text }}>

      <Intro />

      {error && <Notice tone="error">{error}</Notice>}
      {catalogue && !catalogue.available && <Notice tone="warn">{catalogue.reason}</Notice>}

      {run ? (
        <RunView run={run} history={history} running={running} isAdmin={isAdmin} busy={busy} onAbort={abort} />
      ) : (
        <NormalOverview overview={overview} />
      )}

      <ScenarioPicker catalogue={catalogue} disabled={!isAdmin || running || busy || !catalogue?.available} isAdmin={isAdmin} running={running} onStart={start} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function Intro() {
  return (
    <PageHeader
      eyebrow="Platform · Chaos engineering"
      icon="flask"
      title={
        <>
          Resilience <span className="sc-grad">Demo</span>
        </>
      }
      subtitle="Break part of SentinelCloud on purpose and watch the platform heal itself. Each drill injects a software fault into one of SentinelCloud's own services, then follows Kubernetes as it notices, routes around and repairs the damage. This is a software resilience simulation: no real infrastructure is involved."
    />
  );
}

function Notice({ tone, children }) {
  return <Alert tone={tone === "error" ? "error" : "warn"}>{children}</Alert>;
}

// ---------------------------------------------------------------------------
// A drill in progress (or the last one)

function RunView({ run, history, running, isAdmin, busy, onAbort }) {
  const failureAt = run.stages.find((s) => s.stage === "FAILURE")?.enteredAt;
  return (
    <section aria-live="polite" style={{ marginBottom: "2rem" }}>
      <Banner run={run} running={running} isAdmin={isAdmin} busy={busy} onAbort={onAbort} />
      <StageTrack run={run} failureAt={failureAt} />
      <div className="rd-split" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.65fr) minmax(0, 1fr)", gap: "1rem", marginTop: "1rem" }}>
        <div style={{ display: "grid", gap: "1rem", alignContent: "start" }}>
          <LiveView run={run} history={history} />
          {run.summary && <Summary run={run} />}
        </div>
        <Timeline run={run} />
      </div>
    </section>
  );
}

function Banner({ run, running, isAdmin, busy, onAbort }) {
  const level = run.status === "failed" ? "failed" : run.banner?.level || "normal";
  const { color, tint } = LEVEL[level] || LEVEL.normal;
  const statusNote =
    run.status === "running" ? `${run.title} · ${fmtSec(run.elapsedSec)} elapsed`
      : run.status === "completed" ? `${run.title} · completed in ${fmtSec(run.elapsedSec)}`
        : run.status === "aborted" ? `${run.title} · aborted`
          : `${run.title} · did not complete`;
  return (
    <div style={{ background: tint, border: `1px solid ${color}`, borderRadius: 10, padding: "1.25rem 1.5rem", display: "flex", gap: "1.5rem", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ color, fontSize: "clamp(1.9rem, 4.6vw, 3.1rem)", fontWeight: 800, letterSpacing: "0.02em", lineHeight: 1.05 }}>{run.banner?.headline}</div>
        <div style={{ marginTop: "0.45rem", fontSize: "1.05rem", lineHeight: 1.45, color: C.text }}>{run.banner?.detail}</div>
        <div style={{ marginTop: "0.35rem", fontSize: "0.85rem", color: C.muted }}>{statusNote}</div>
      </div>
      {running && isAdmin && (
        <button className="rd-btn sc-btn is-ghost" onClick={onAbort} disabled={busy}>
          <Icon name="x" /> Abort drill
        </button>
      )}
    </div>
  );
}

function StageTrack({ run, failureAt }) {
  const currentIdx = STAGES.findIndex((s) => s.id === run.stage);
  const t0 = failureAt ? Date.parse(failureAt) : Date.parse(run.startedAt);
  const current = run.stages.find((s) => s.stage === run.stage);
  return (
    <div className="sc-card" style={{ marginTop: "1rem" }}>
      <ol aria-label="Drill progress" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: `repeat(${STAGES.length}, minmax(0,1fr))` }}>
        {STAGES.map((s, i) => {
          const entry = run.stages.find((x) => x.stage === s.id);
          const reached = Boolean(entry?.enteredAt);
          const isCurrent = i === currentIdx && run.status === "running";
          const color = reached ? LEVEL[s.level].color : C.line;
          const offset = reached && failureAt && s.id !== "NORMAL" ? `T+${((Date.parse(entry.enteredAt) - t0) / 1000).toFixed(1)}s` : reached ? "start" : "waiting";
          return (
            <li key={s.id} aria-current={isCurrent ? "step" : undefined} style={{ position: "relative", textAlign: "center", padding: "0 0.25rem" }}>
              {i > 0 && (
                <span aria-hidden style={{ position: "absolute", top: 9, right: "50%", width: "100%", height: 3, background: reached ? color : C.line, zIndex: 0 }} />
              )}
              <span
                className={isCurrent ? "rd-current" : undefined}
                aria-hidden
                style={{ "--rd-ring": color, position: "relative", zIndex: 1, display: "inline-block", width: 21, height: 21, borderRadius: "50%", background: reached ? color : C.bg, border: `3px solid ${color}`, boxSizing: "border-box" }}
              />
              <div style={{ marginTop: 6, fontWeight: reached ? 650 : 450, color: reached ? C.text : C.faint, fontSize: "0.92rem" }}>{s.label}</div>
              <div style={{ color: reached ? C.muted : C.faint, fontSize: "0.78rem", fontVariantNumeric: "tabular-nums" }}>{offset}</div>
            </li>
          );
        })}
      </ol>
      {current?.summary && (
        <div style={{ marginTop: "1rem", paddingTop: "0.9rem", borderTop: `1px solid ${C.line}`, lineHeight: 1.55 }}>
          <div>{current.summary}</div>
          {current.evidence && <div style={{ marginTop: 6, color: C.muted, fontSize: "0.86rem" }}>{current.evidence}</div>}
        </div>
      )}
      {run.status === "failed" && run.error && <div style={{ marginTop: "0.75rem", color: TIER_COLORS.CRITICAL }}>{run.error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live view per scenario kind

function Panel({ title, note, children }) {
  return (
    <section className="sc-card" style={{ margin: 0 }}>
      <h3 className="sc-card-title">{title}</h3>
      {note && <p style={{ margin: "0.25rem 0 0.8rem", color: C.muted, fontSize: "0.85rem", lineHeight: 1.45 }}>{note}</p>}
      {children}
    </section>
  );
}

function LiveView({ run, history }) {
  const v = run.view;
  if (!v) return <Panel title="Live view" note="Collecting the first observations from the cluster…" />;
  if (v.kind === "broker") return <BrokerView view={v} />;
  const podColor = colorAssigner(v.target?.pods || [], v.traffic || [], v.load?.series || []);
  return (
    <>
      <Panel
        title={`Replicas of ${v.target.service}`}
        note={`${v.target.readyEndpoints} of ${v.target.pods.length} pods are in the load balancer (the Service's ready endpoints).`}
      >
        <PodGrid target={v.target} victim={v.victim} replacement={v.replacement} podColor={podColor} stage={run.status === "running" ? run.stage : "RESTORED"} />
      </Panel>
      {v.kind === "scaling" ? (
        <>
          <Panel title="Replicas over time" note="Ready pods and the number the HorizontalPodAutoscaler wants. The surge starts at Failure.">
            <ReplicaChart points={history.points} max={v.target.hpa?.maxReplicas || 5} />
          </Panel>
          <Panel title="Emergency traffic, by the pod that served it" note={`Requests per second from ${v.load?.concurrency ?? "?"} concurrent streams. New colours are new replicas taking their share.`}>
            <TrafficChart series={v.load?.series || []} podColor={podColor} />
            {v.load?.recent && <LoadStats recent={v.load.recent} />}
          </Panel>
        </>
      ) : (
        <Panel
          title="Live requests, by the pod that answered"
          note="4 requests per second through the Kubernetes Service, each on a new connection so kube-proxy balances every one. Red = the request failed."
        >
          <TrafficChart series={v.traffic || []} podColor={podColor} />
        </Panel>
      )}
    </>
  );
}

function colorAssigner(pods, ...seriesLists) {
  const names = new Set(pods.map((p) => p.name));
  for (const series of seriesLists) for (const b of series) Object.keys(b.byPod || {}).forEach((n) => names.add(n));
  const sorted = [...names].sort();
  return (name) => POD_COLORS[sorted.indexOf(name) % POD_COLORS.length] || C.faint;
}

const POD_STATE = {
  ready: { label: "Ready, receiving traffic", tier: "NORMAL" },
  "running-not-ready": { label: "Running, not ready", tier: "HIGH" },
  waiting: { label: "Restarting", tier: "WARNING" },
  terminated: { label: "Crashed", tier: "CRITICAL" },
  terminating: { label: "Terminating", tier: "CRITICAL" },
  initializing: { label: "Starting", tier: "WARNING" },
  pending: { label: "Being scheduled", tier: "WARNING" },
};

function PodGrid({ target, victim, replacement, podColor, stage }) {
  const inLb = new Set(target.endpoints.filter((e) => e.ready).map((e) => e.pod));
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: "0.6rem" }}>
      {target.pods.map((p) => {
        const st = POD_STATE[p.state] || { label: p.state, tier: "UNKNOWN" };
        const label = p.reason ? `${st.label} (${p.reason})` : st.label;
        const color = TIER_COLORS[st.tier];
        return (
          <li key={p.name} style={{ background: C.panelRaised, border: `1px solid ${p.name === victim ? TIER_COLORS.CRITICAL : C.line}`, borderRadius: 8, padding: "0.7rem 0.8rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span aria-hidden style={{ width: 10, height: 10, borderRadius: 2, background: podColor(p.name), flex: "none" }} />
              <span title={p.name} style={{ fontWeight: 600, fontSize: "0.92rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {shortPod(p.name)}
              </span>
            </div>
            <div style={{ marginTop: 6, color, fontSize: "0.86rem", fontWeight: 600 }}>{label}</div>
            <div style={{ marginTop: 4, color: C.muted, fontSize: "0.8rem", lineHeight: 1.5 }}>
              {p.restarts} restart{p.restarts === 1 ? "" : "s"} · {inLb.has(p.name) ? "in load balancer" : "out of load balancer"}
              {p.name === victim && (
                <div style={{ color: TIER_COLORS.CRITICAL }}>
                  {stage === "FAILURE" && p.ready
                    ? "Fault injected here: Kubernetes hasn't noticed yet"
                    : stage === "RESTORED" || stage === null
                      ? "Fault injected here: recovered"
                      : "Fault injected here"}
                </div>
              )}
              {p.name === replacement && <div style={{ color: TIER_COLORS.NORMAL }}>Replacement pod</div>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Stacked bars: one column per second, segments per pod, failed requests in red on top. */
function TrafficChart({ series, podColor }) {
  const W = 640;
  const H = 150;
  const data = series.slice(-60);
  if (data.length === 0) return <Empty />;
  const max = Math.max(4, ...data.map((b) => b.ok + b.failed));
  const colW = W / 60;
  const pods = [...new Set(data.flatMap((b) => Object.keys(b.byPod || {})))].sort();
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label="Requests per second by pod" style={{ width: "100%", height: "auto", display: "block" }}>
        {[0.5, 1].map((f) => (
          <line key={f} x1={0} x2={W} y1={H - f * H} y2={H - f * H} stroke={C.line} strokeWidth={1} />
        ))}
        <text x={2} y={11} fill={C.faint} fontSize={10}>{max}/s</text>
        {data.map((b, i) => {
          const x = (60 - data.length + i) * colW;
          let y = H;
          const segs = [];
          for (const pod of pods) {
            const n = b.byPod?.[pod] || 0;
            if (!n) continue;
            const h = (n / max) * H;
            y -= h;
            segs.push(<rect key={pod} x={x + 1} y={y + 1} width={Math.max(1, colW - 2)} height={Math.max(0, h - 2)} rx={2} fill={podColor(pod)}><title>{`${pod}: ${n} ok`}</title></rect>);
          }
          if (b.failed) {
            const h = (b.failed / max) * H;
            y -= h;
            segs.push(<rect key="failed" x={x + 1} y={y + 1} width={Math.max(1, colW - 2)} height={Math.max(0, h - 2)} rx={2} fill={TIER_COLORS.CRITICAL}><title>{`${b.failed} failed`}</title></rect>);
          }
          return <g key={b.t}>{segs}</g>;
        })}
        <text x={0} y={H + 14} fill={C.faint} fontSize={10}>60s ago</text>
        <text x={W} y={H + 14} fill={C.faint} fontSize={10} textAnchor="end">now</text>
      </svg>
      <Legend items={[...pods.map((p) => ({ label: shortPod(p), color: podColor(p), title: p })), { label: "Failed", color: TIER_COLORS.CRITICAL }]} />
    </div>
  );
}

function ReplicaChart({ points, max }) {
  const W = 640;
  const H = 120;
  if (points.length < 2) return <Empty />;
  const t0 = points[0].t;
  const span = Math.max(1, points[points.length - 1].t - t0);
  const yMax = Math.max(max, ...points.map((p) => Math.max(p.ready, p.desired || 0)));
  const GUTTER = 18; // room for the y-axis numbers, so lines never cover them
  const TOP = 14;
  const x = (t) => GUTTER + ((t - t0) / span) * (W - GUTTER);
  const y = (v) => H - (v / yMax) * (H - TOP);
  const line = (key) => points.filter((p) => p[key] != null).map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join("");
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H + 4}`} role="img" aria-label="Ready and desired replicas over time" style={{ width: "100%", height: "auto", display: "block" }}>
        {Array.from({ length: yMax }, (_, i) => i + 1).map((v) => (
          <g key={v}>
            <line x1={GUTTER} x2={W} y1={y(v)} y2={y(v)} stroke={C.line} />
            <text x={2} y={y(v) + 3.5} fill={C.faint} fontSize={10}>{v}</text>
          </g>
        ))}
        <path d={line("desired")} fill="none" stroke={TIER_COLORS.HIGH} strokeWidth={2} strokeDasharray="6 4" />
        <path d={line("ready")} fill="none" stroke="#60a5fa" strokeWidth={2.5} />
      </svg>
      <Legend items={[{ label: "Ready replicas", color: "#60a5fa" }, { label: "Wanted by HPA", color: TIER_COLORS.HIGH, dashed: true }]} />
    </div>
  );
}

function LoadStats({ recent }) {
  return (
    <p style={{ margin: "0.6rem 0 0", color: C.muted, fontSize: "0.86rem" }}>
      Last 5s: {Math.round(recent.requestsPerSec)} requests/s, p95 latency {recent.p95Ms != null ? `${Math.round(recent.p95Ms)}ms` : "—"}
      {recent.failed ? `, ${recent.failed} failed` : ""}.
    </p>
  );
}

function BrokerView({ view }) {
  const q = view.queue;
  const b = view.broker;
  return (
    <>
      <Panel title="Event queue" note="Drill events on their own durable queue. The line climbs when consumers stall or the broker is down, and falls as the backlog drains.">
        {q ? <QueueChart series={q.series} /> : <Empty />}
        {q && (
          <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "0.5rem", margin: "0.8rem 0 0" }}>
            <Stat label="Queued now" value={q.depth} />
            <Stat label="Buffered in outbox" value={q.outbox} tone={q.outbox ? "HIGH" : undefined} />
            <Stat label="Peak queue" value={q.peakDepth} />
            <Stat label="Produced / delivered" value={`${q.produced} / ${q.consumed}`} />
          </dl>
        )}
      </Panel>
      <Panel title="Broker and service connections" note="rabbitmq-0 is a StatefulSet pod with its own PersistentVolume; each service reports its own RabbitMQ connection.">
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
          <ConnRow name={b ? `${b.name} (broker)` : "rabbitmq-0 (broker)"} ok={Boolean(b?.ready)} detail={b ? (POD_STATE[b.state]?.label || b.state) : "pod gone, being recreated"} />
          {view.services.map((s) => (
            <ConnRow key={s.service} name={s.service} ok={s.connected} detail={s.connected ? "connected" : s.detail} />
          ))}
        </ul>
      </Panel>
    </>
  );
}

function QueueChart({ series }) {
  const W = 640;
  const H = 130;
  const data = series.slice(-90);
  if (data.length < 2) return <Empty />;
  const max = Math.max(10, ...data.map((d) => Math.max(d.depth, d.outbox)));
  const x = (i) => (i / (data.length - 1)) * W;
  const y = (v) => H - (v / max) * (H - 6);
  const path = (key) => data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join("");
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H + 4}`} role="img" aria-label="Queue depth and outbox size over time" style={{ width: "100%", height: "auto", display: "block" }}>
        <line x1={0} x2={W} y1={y(max)} y2={y(max)} stroke={C.line} />
        <text x={2} y={y(max) + 11} fill={C.faint} fontSize={10}>{max} events</text>
        <path d={`${path("depth")}L${W},${H}L0,${H}Z`} fill="rgba(96,165,250,0.15)" />
        <path d={path("depth")} fill="none" stroke="#60a5fa" strokeWidth={2.5} />
        <path d={path("outbox")} fill="none" stroke={TIER_COLORS.HIGH} strokeWidth={2} strokeDasharray="6 4" />
      </svg>
      <Legend items={[{ label: "Queued in RabbitMQ", color: "#60a5fa" }, { label: "Buffered in outbox (broker down)", color: TIER_COLORS.HIGH, dashed: true }]} />
    </div>
  );
}

function ConnRow({ name, ok, detail }) {
  const color = ok ? TIER_COLORS.NORMAL : TIER_COLORS.CRITICAL;
  return (
    <li style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: "0.9rem" }}>
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: color, flex: "none", transform: "translateY(-1px)" }} />
      <span style={{ fontWeight: 600, minWidth: 170 }}>{name}</span>
      <span style={{ color: ok ? C.muted : color, overflow: "hidden", textOverflow: "ellipsis" }}>{ok ? "OK" : "Down"}: {detail}</span>
    </li>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div style={{ background: C.panelRaised, borderRadius: 8, padding: "0.55rem 0.7rem" }}>
      <dt style={{ color: C.muted, fontSize: "0.78rem" }}>{label}</dt>
      <dd style={{ margin: 0, fontSize: "1.25rem", fontWeight: 650, fontVariantNumeric: "tabular-nums", color: tone ? TIER_COLORS[tone] : C.text }}>{value}</dd>
    </div>
  );
}

function Legend({ items }) {
  return (
    <ul style={{ listStyle: "none", display: "flex", flexWrap: "wrap", gap: "0.4rem 1rem", margin: "0.5rem 0 0", padding: 0, color: C.muted, fontSize: "0.8rem" }}>
      {items.map((it) => (
        <li key={it.label} title={it.title} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span aria-hidden style={{ width: 14, height: it.dashed ? 0 : 8, borderTop: it.dashed ? `2px dashed ${it.color}` : "none", background: it.dashed ? "none" : it.color, borderRadius: 2 }} />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

function Empty() {
  return <p style={{ color: C.faint, margin: "0.5rem 0" }}>Waiting for the first seconds of data…</p>;
}

// ---------------------------------------------------------------------------

function Summary({ run }) {
  const s = run.summary;
  const items = [
    ["Time to detect", fmtSec(s.timeToDetectSec)],
    ["Time to start recovery", fmtSec(s.timeToRecoverySec)],
    ["Time to restore", fmtSec(s.timeToRestoreSec)],
  ];
  if (s.successRatePercent != null) items.push([`Requests that succeeded during the incident (${s.requestsDuringIncident.ok} of ${s.requestsDuringIncident.ok + s.requestsDuringIncident.failed})`, `${s.successRatePercent}%`]);
  if (s.replicasBefore != null) items.push(["Replicas", `${s.replicasBefore} → ${s.replicasAfter}`]);
  if (s.p95MsDuringSurge != null) items.push(["p95 latency", `${s.p95MsDuringSurge}ms during surge → ${s.p95MsAfterScaleOut ?? "—"}ms after scale-out`]);
  if (s.peakQueueDepth != null) items.push(["Peak queue", `${s.peakQueueDepth} events (${s.peakBufferedInOutbox} buffered during a ${fmtSec(s.brokerOutageSec)} outage)`]);
  if (s.eventsLost != null) items.push(["Events lost", `${s.eventsLost} of ${s.eventsProduced}`]);
  return (
    <Panel title="What the platform did" note="Measured from the moment the fault was injected. No one intervened by hand.">
      <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0.5rem", margin: 0 }}>
        {items.map(([k, v]) => <Stat key={k} label={k} value={v} />)}
      </dl>
    </Panel>
  );
}

function Timeline({ run }) {
  const ref = useRef(null);
  const [clipped, setClipped] = useState(false);
  const events = run.timeline;
  useEffect(() => {
    // Follow the newest entry; fade the top edge when earlier entries are scrolled out of view.
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
      setClipped(ref.current.scrollTop > 0);
    }
  }, [events.length]);
  const fade = clipped ? "linear-gradient(to bottom, transparent 0, #000 36px)" : undefined;
  const t0 = Date.parse(run.startedAt);
  return (
    <Panel title="What happened" note="Every step as resilience-service observed it, with the Kubernetes event that proves it.">
      <ol ref={ref} style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 640, overflowY: "auto", display: "grid", gap: "0.7rem", maskImage: fade, WebkitMaskImage: fade }}
        onScroll={(e) => setClipped(e.currentTarget.scrollTop > 0)}>
        {events.map((e, i) => {
          const stage = STAGES.find((s) => s.id === e.stage);
          const color = e.kind === "stage" && stage ? LEVEL[stage.level].color : e.kind === "error" ? TIER_COLORS.CRITICAL : C.line;
          return (
            <li key={i} style={{ borderLeft: `3px solid ${color}`, paddingLeft: "0.7rem" }}>
              <div style={{ color: C.faint, fontSize: "0.76rem", fontVariantNumeric: "tabular-nums" }}>
                +{((Date.parse(e.at) - t0) / 1000).toFixed(1)}s{e.kind === "stage" && stage ? ` · ${stage.label}` : ""}
              </div>
              <div style={{ fontSize: "0.88rem", lineHeight: 1.45, fontWeight: e.kind === "stage" ? 600 : 400 }}>{e.message}</div>
              {e.evidence && <div style={{ color: C.muted, fontSize: "0.8rem", lineHeight: 1.4, marginTop: 2 }}>{e.evidence}</div>}
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Idle: the normal state, plus the scenario picker

function NormalOverview({ overview }) {
  if (!overview) return null;
  if (!overview.services?.length) return null;
  return (
    <section style={{ marginBottom: "2rem" }}>
      <div style={{ background: LEVEL.normal.tint, border: `1px solid ${LEVEL.normal.color}`, borderRadius: 10, padding: "1rem 1.5rem", marginBottom: "1rem" }}>
        <div style={{ color: LEVEL.normal.color, fontSize: "1.6rem", fontWeight: 800 }}>NORMAL STATE</div>
        <div style={{ marginTop: 4, color: C.text }}>No drill running. The services a drill can target, as Kubernetes sees them right now:</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "0.75rem" }}>
        {overview.services.map((s) => {
          const ready = s.pods.filter((p) => p.ready).length;
          const healthy = ready > 0 && ready === s.pods.length;
          return (
            <div key={s.service} className="sc-stat" style={{ "--stat-color": healthy ? TIER_COLORS.NORMAL : TIER_COLORS.HIGH }}>
              <div style={{ fontWeight: 650 }}>{s.service}</div>
              <div style={{ color: healthy ? TIER_COLORS.NORMAL : TIER_COLORS.HIGH, fontSize: "0.9rem", marginTop: 4 }}>
                {ready}/{s.pods.length} pods ready · {s.readyEndpoints ?? "?"} in load balancer
              </div>
              <div style={{ color: C.muted, fontSize: "0.82rem", marginTop: 2 }}>
                {s.pods.reduce((n, p) => n + p.restarts, 0)} restarts total
                {s.hpa ? ` · HPA ${s.hpa.minReplicas}–${s.hpa.maxReplicas}, CPU ${s.hpa.cpuPercent ?? "n/a"}%` : ""}
              </div>
            </div>
          );
        })}
        {overview.broker && (
          <div className="sc-stat" style={{ "--stat-color": overview.broker.ready ? TIER_COLORS.NORMAL : TIER_COLORS.CRITICAL }}>
            <div style={{ fontWeight: 650 }}>RabbitMQ</div>
            <div style={{ color: overview.broker.ready ? TIER_COLORS.NORMAL : TIER_COLORS.CRITICAL, fontSize: "0.9rem", marginTop: 4 }}>
              {overview.broker.name} {overview.broker.ready ? "ready" : "not ready"}
            </div>
            <div style={{ color: C.muted, fontSize: "0.82rem", marginTop: 2 }}>{overview.broker.restarts} restarts total</div>
          </div>
        )}
      </div>
    </section>
  );
}

function ScenarioPicker({ catalogue, disabled, isAdmin, running, onStart }) {
  if (!catalogue) return null;
  return (
    <section>
      <h3 style={{ margin: "0 0 0.3rem", fontSize: "1.15rem", fontWeight: 650 }}>Run a drill</h3>
      <p style={{ margin: "0 0 0.9rem", color: C.muted, lineHeight: 1.5 }}>
        {!isAdmin
          ? "You can watch drills here. Starting one needs a SYSTEM_ADMIN account."
          : running
            ? "One drill at a time: wait for the current one to finish or abort it."
            : "Each drill fails one part of the platform, then shows how Kubernetes detects and recovers from it."}
      </p>
      <div className="rd-scenarios" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "0.75rem" }}>
        {catalogue.scenarios.map((s) => (
          <article key={s.id} className="rd-card sc-card" style={{ margin: 0, display: "flex", flexDirection: "column", gap: "0.55rem" }}>
            <h4 className="sc-card-title" style={{ fontSize: "1rem" }}>
              <span className="sc-card-icon">
                <Icon name="flask" />
              </span>
              {s.title}
            </h4>
            <p style={{ margin: 0, color: C.muted, fontSize: "0.88rem", lineHeight: 1.5, flex: 1 }}>{s.description}</p>
            <p style={{ margin: 0, fontSize: "0.82rem", color: C.text, lineHeight: 1.45 }}>
              Shows: {s.demonstrates.join(", ").toLowerCase()}
            </p>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
              <span style={{ color: C.faint, fontSize: "0.8rem" }}>about {Math.round(s.estimatedSeconds / 10) * 10}s</span>
              <button className="rd-btn sc-btn is-sm" disabled={disabled} onClick={() => onStart(s)}>
                <Icon name="zap" /> Run drill
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

