import React, { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext.jsx";
import {
  fetchSimulatorScenarios,
  fetchSimulatorStatus,
  startSimulatorScenario,
  stopSimulatorScenario,
  setSimulatorAmbient,
} from "../lib/api.js";
import { Alert, Badge, Card, Empty, Icon, PageHeader, Tile } from "../components/ui.jsx";

/**
 * Phase 16: the scenario simulator (docs/PHASE-16-SIMULATOR.md). Start a
 * scripted disaster and narrate while it plays itself out; the timeline
 * shows each step's narration and what actually happened. Everything the
 * simulator does goes through the gateway as its own service account.
 */
const RUN_COLORS = { RUNNING: "#38bdf8", COMPLETED: "#22c55e", COMPLETED_WITH_ERRORS: "#f59e0b", STOPPED: "#a78bfa", FAILED: "#ef4444" };
const STEP_COLORS = { PENDING: "#8b9bb3", RUNNING: "#38bdf8", DONE: "#22c55e", FAILED: "#ef4444", SKIPPED: "#8b9bb3" };

const mmss = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export default function SimulatorPage() {
  const { authFetch, user } = useAuth();
  const isAdmin = user?.role === "SYSTEM_ADMIN";
  const [scenarios, setScenarios] = useState([]);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0); // re-render for the elapsed timer

  const load = useCallback(async () => {
    try {
      setStatus(await authFetch((token) => fetchSimulatorStatus(token)));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [authFetch]);

  useEffect(() => {
    authFetch((token) => fetchSimulatorScenarios(token))
      .then((res) => setScenarios(res.scenarios || []))
      .catch((err) => setError(err.message));
    load();
    const poll = setInterval(load, 2000);
    const clock = setInterval(() => setTick((n) => n + 1), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [authFetch, load]);

  async function act(fn) {
    setBusy(true);
    try {
      await authFetch(fn);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const run = status?.run;
  const running = run?.status === "RUNNING";
  const ambient = status?.ambient;
  const elapsed = run ? ((run.finishedAt ? Date.parse(run.finishedAt) : Date.now()) - Date.parse(run.startedAt)) / 1000 : 0;

  return (
    <section>
      <PageHeader
        eyebrow="Demo"
        icon="activity"
        title="Scenario Simulator"
        subtitle="Scripted disasters that play themselves out through the real API, so you can narrate instead of click."
      />
      {error && <Alert>{error}</Alert>}
      {!isAdmin && <Alert tone="info">You can watch runs here; starting one needs a SYSTEM_ADMIN.</Alert>}

      <div className="sc-split" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.3fr)", gap: "1.1rem", alignItems: "start" }}>
        <div className="sc-stack">
          <Card title="Scenarios" icon="flask" count={scenarios.length}>
            {scenarios.length === 0 ? (
              <Empty icon="clock">Loading scenarios…</Empty>
            ) : (
              <div style={{ display: "grid", gap: "0.6rem" }}>
                {scenarios.map((s) => (
                  <div key={s.id} className="sc-inset">
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 650, fontSize: "0.88rem" }}>{s.title}</span>
                      <span className="sc-mono" style={{ fontSize: "0.7rem", color: "var(--faint)" }}>
                        ~{mmss(s.durationSeconds)} · {s.stepCount} steps{s.ambient ? " · ambulances drive" : ""}
                      </span>
                    </div>
                    <p style={{ margin: "0.35rem 0 0.6rem", fontSize: "0.78rem", color: "var(--text-2)", lineHeight: 1.5 }}>{s.summary}</p>
                    {isAdmin && (
                      <button type="button" disabled={busy || running} onClick={() => act((token) => startSimulatorScenario(token, s.id))} className="sc-btn is-tone is-sm" style={{ "--btn-color": "#22c55e" }}>
                        Start scenario
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card
            title="Background activity"
            icon="radar"
            subtitle="Ambulances drive their calls to the end; transformers report normal readings"
            right={<Badge label={ambient?.enabled ? "ON" : "OFF"} color={ambient?.enabled ? "#22c55e" : "#8b9bb3"} />}
          >
            {ambient && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: "0.5rem" }}>
                  <Tile label="Moves" value={ambient.moves} />
                  <Tile label="Status changes" value={ambient.statusChanges} />
                  <Tile label="Calls completed" value={ambient.completedCalls} />
                  <Tile label="Readings" value={ambient.readings} />
                </div>
                <p className="sc-hint" style={{ marginTop: "0.6rem" }}>
                  Writes in the last minute: {status.budget?.usedLastMinute ?? 0} (background stops at {status.budget?.ambientCap}, the gateway at 60).
                  {ambient.skippedForBudget ? ` ${ambient.skippedForBudget} step(s) waited for budget.` : ""}
                  {ambient.lastError ? ` Last problem: ${ambient.lastError}` : ""}
                </p>
                {isAdmin && (
                  <button type="button" disabled={busy} onClick={() => act((token) => setSimulatorAmbient(token, !ambient.enabled))} className="sc-btn is-tone is-sm" style={{ "--btn-color": ambient.enabled ? "#f97316" : "#22c55e" }}>
                    {ambient.enabled ? "Switch off" : "Switch on"}
                  </button>
                )}
              </>
            )}
          </Card>
        </div>

        <Card
          title={run ? run.title : "No scenario run yet"}
          icon="clock"
          subtitle={run ? `Started by ${run.startedBy ?? "unknown"} · ${mmss(elapsed)} elapsed` : "Start a scenario and narrate along with this timeline."}
          right={run && <Badge label={run.status.replaceAll("_", " ")} color={RUN_COLORS[run.status]} />}
        >
          {!run && <Empty icon="info">Each step shows what to say and what actually happened.</Empty>}
          {run && (
            <>
              <ol className="sc-timeline" style={{ margin: 0 }}>
                {run.steps.map((s, i) => (
                  <li key={i} style={{ "--tl-color": STEP_COLORS[s.status] }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <span className="sc-mono" style={{ fontSize: "0.72rem", color: "var(--faint)" }}>{mmss(s.at)}</span>
                        <Badge label={s.status} color={STEP_COLORS[s.status]} small noDot />
                        {s.cleanup && <span style={{ fontSize: "0.68rem", color: "var(--faint)" }}>clean-up</span>}
                      </span>
                      <span className="sc-mono" style={{ fontSize: "0.68rem", color: "var(--faint)" }}>{s.action}</span>
                    </div>
                    <p style={{ margin: "4px 0 0", fontSize: "0.82rem", lineHeight: 1.5, color: s.status === "PENDING" ? "var(--muted)" : "var(--text)" }}>{s.say}</p>
                    {s.detail && (
                      <p style={{ margin: "2px 0 0", fontSize: "0.74rem", color: s.status === "FAILED" ? "#ef4444" : "var(--text-2)" }}>
                        <Icon name={s.status === "FAILED" ? "alert" : "check"} size={12} /> {s.detail}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
              {isAdmin && running && (
                <button type="button" disabled={busy} onClick={() => act((token) => stopSimulatorScenario(token))} className="sc-btn is-tone is-sm" style={{ "--btn-color": "#f97316", marginTop: "0.75rem" }}>
                  Stop (clean-up steps still run)
                </button>
              )}
            </>
          )}
        </Card>
      </div>
    </section>
  );
}
