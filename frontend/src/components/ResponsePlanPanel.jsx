import React, { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext.jsx";
import { fetchResponsePlans, decideResponsePlan } from "../lib/api.js";
import { Alert, Badge, Card, Empty, Icon, Tile } from "./ui.jsx";

/**
 * Phase 15: the response plan for one disaster (docs/PHASE-15-RESPONSE-ENGINE.md).
 * response-service proposes it from the situation report; an operator
 * approves or rejects it here, and can undo it once it has run.
 * Refreshes on its own every 4 s and whenever the live feed brings a
 * response.* or command.* event (refreshSignal).
 */
const PLAN_COLORS = {
  PROPOSED: "#38bdf8",
  EXECUTING: "#6366f1",
  COMPLETED: "#22c55e",
  PARTIAL: "#f59e0b",
  REJECTED: "#8b9bb3",
  EXPIRED: "#8b9bb3",
  UNDOING: "#f97316",
  ROLLED_BACK: "#a78bfa",
};
const ACTION_COLORS = {
  PROPOSED: "#38bdf8",
  INFO: "#8b9bb3",
  PENDING: "#6366f1",
  SUCCEEDED: "#22c55e",
  FAILED: "#ef4444",
  SKIPPED: "#8b9bb3",
  UNDOING: "#f97316",
  UNDONE: "#a78bfa",
  UNDO_FAILED: "#ef4444",
};
const ACTION_ICONS = { "ambulance.dispatch": "ambulance", "blood.reserve": "droplet", "hospital.reserve_beds": "bed", "disaster.widen_radius": "radar", notice: "info" };

function actionTitle(a) {
  const p = a.params || {};
  switch (a.kind) {
    case "ambulance.dispatch":
      return `Dispatch ${p.count} ambulance${p.count === 1 ? "" : "s"}`;
    case "blood.reserve":
      return `Reserve ${p.units} × ${p.bloodType} at ${p.bloodBankName} for ${p.hospitalName}`;
    case "hospital.reserve_beds":
      return `Hold ${p.beds} bed${p.beds === 1 ? "" : "s"}${p.icuBeds ? ` + ${p.icuBeds} ICU` : ""} at ${p.hospitalName}`;
    case "disaster.widen_radius":
      return `Widen the search from ${p.fromRadiusKm} km to ${p.radiusKm} km`;
    default:
      return "Needs a person";
  }
}

function actionOutcome(a) {
  if (a.status === "FAILED" || a.status === "UNDO_FAILED") return a.error?.message || "Failed.";
  if (a.status === "UNDONE") {
    if (a.kind === "ambulance.dispatch") return "Calls cancelled, ambulances free again.";
    return a.kind === "hospital.reserve_beds" ? "Beds released back to the hospital." : "Reservation released.";
  }
  if (a.status !== "SUCCEEDED" || !a.result) return null;
  if (a.kind === "ambulance.dispatch") {
    const waiting = a.result.unassignedCount ? `, ${a.result.unassignedCount} call(s) waiting for a free ambulance` : "";
    return `${a.result.dispatchedCount} dispatched${waiting}.`;
  }
  if (a.kind === "blood.reserve") return `Reserved (reservation ${String(a.result.reservationId).slice(0, 8)}).`;
  if (a.kind === "hospital.reserve_beds") {
    const fewer = a.result.reservedBeds < a.result.requestedBeds || a.result.reservedIcuBeds < a.result.requestedIcuBeds;
    return `Holding ${a.result.reservedBeds} bed(s)${a.result.reservedIcuBeds ? ` and ${a.result.reservedIcuBeds} ICU` : ""}${fewer ? " (fewer than asked: beds filled meanwhile)" : ""}.`;
  }
  if (a.kind === "disaster.widen_radius") return a.result.changed ? `Radius is now ${a.result.radiusKm} km; services are re-checking.` : "Already that wide.";
  return null;
}

function PlanView({ plan, canDecide, busy, onDecide }) {
  const [confirmUndo, setConfirmUndo] = useState(false);
  const needs = plan.needs || {};
  return (
    <div className="sc-inset" style={{ marginBottom: "0.75rem" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
        <Badge label={plan.status.replace("_", " ")} color={PLAN_COLORS[plan.status]} />
        <span style={{ fontSize: "0.8rem", fontWeight: 650 }}>{plan.revision === 1 ? "Response plan" : "Follow-up plan (after widening the search)"}</span>
        <span style={{ fontSize: "0.72rem", color: "var(--faint)" }}>{plan.mode === "AUTO" ? "auto mode" : "needs approval"}</span>
      </div>
      <p style={{ margin: "0 0 0.5rem", fontSize: "0.76rem", color: "var(--muted)" }}>
        This {plan.disaster?.severity} {String(plan.disaster?.type || "").replace("_", " ")} needs {needs.ambulances} ambulance(s)
        {needs.bloodUnitsPerType ? ` and ${needs.bloodUnitsPerType} unit(s) each of O− and O+` : ""}
        {needs.hospitalBeds ? `, ${needs.hospitalBeds} hospital bed(s) and ${needs.icuBeds} ICU bed(s)` : ""} (demo model).
      </p>
      {needs.impact && (
        <div className="sc-stats" style={{ marginBottom: "0.6rem" }}>
          <Tile label="People in zone" value={needs.impact.population} />
          <Tile label="Exposed" value={needs.impact.exposed} />
          <Tile label="Est. casualties" value={needs.impact.casualties} color="#f97316" />
          <Tile label="Beds needed" value={needs.impact.hospitalBeds} />
        </div>
      )}
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
        {plan.actions.map((a) => {
          const outcome = actionOutcome(a);
          return (
            <li key={a.id} style={{ display: "grid", gridTemplateColumns: "auto minmax(0,1fr)", gap: 8, alignItems: "start" }}>
              <span className="sc-stat-icon" style={{ "--stat-color": ACTION_COLORS[a.status] }}>
                <Icon name={ACTION_ICONS[a.kind] || "info"} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>{actionTitle(a)}</span>
                  <Badge label={a.status.replace("_", " ")} color={ACTION_COLORS[a.status]} small noDot />
                </div>
                <p style={{ margin: "2px 0 0", fontSize: "0.74rem", color: "var(--text-2)", lineHeight: 1.45 }}>{a.reason}</p>
                {outcome && <p style={{ margin: "2px 0 0", fontSize: "0.74rem", color: ACTION_COLORS[a.status] }}>{outcome}</p>}
              </div>
            </li>
          );
        })}
      </ol>
      {canDecide && plan.status === "PROPOSED" && (
        <div style={{ display: "flex", gap: 8, marginTop: "0.75rem", flexWrap: "wrap" }}>
          <button type="button" disabled={busy} onClick={() => onDecide(plan.id, "approve")} className="sc-btn is-tone is-sm" style={{ "--btn-color": "#22c55e" }}>
            Approve and execute
          </button>
          <button type="button" disabled={busy} onClick={() => onDecide(plan.id, "reject")} className="sc-btn is-tone is-sm" style={{ "--btn-color": "#8b9bb3" }}>
            Reject
          </button>
        </div>
      )}
      {canDecide && ["COMPLETED", "PARTIAL"].includes(plan.status) && plan.actions.some((a) => a.status === "SUCCEEDED" && a.kind !== "disaster.widen_radius") && (
        <div style={{ display: "flex", gap: 8, marginTop: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
          {!confirmUndo ? (
            <button type="button" disabled={busy} onClick={() => setConfirmUndo(true)} className="sc-btn is-tone is-sm" style={{ "--btn-color": "#f97316" }}>
              Undo plan
            </button>
          ) : (
            <>
              <span style={{ fontSize: "0.76rem", color: "var(--text-2)" }}>Cancel its emergency calls and release its blood?</span>
              <button type="button" disabled={busy} onClick={() => { setConfirmUndo(false); onDecide(plan.id, "undo"); }} className="sc-btn is-tone is-sm" style={{ "--btn-color": "#f97316" }}>
                Yes, undo
              </button>
              <button type="button" disabled={busy} onClick={() => setConfirmUndo(false)} className="sc-btn is-tone is-sm" style={{ "--btn-color": "#8b9bb3" }}>
                Keep
              </button>
            </>
          )}
        </div>
      )}
      {plan.decisionNote && <p className="sc-hint" style={{ marginTop: "0.5rem" }}>Note: {plan.decisionNote}</p>}
    </div>
  );
}

export default function ResponsePlanPanel({ disasterId, canDecide, refreshSignal }) {
  const { authFetch } = useAuth();
  const [plans, setPlans] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await authFetch((token) => fetchResponsePlans(token, disasterId));
      setPlans(res.plans);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [authFetch, disasterId]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    if (refreshSignal) load();
  }, [refreshSignal, load]);

  async function decide(planId, decision) {
    setBusy(true);
    try {
      await authFetch((token) => decideResponsePlan(token, planId, decision));
      setError(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="sc-fade-up" title="Response Plan" icon="shield" subtitle="Proposed by the response engine from the situation report">
      {error && <Alert>{error}</Alert>}
      {plans && plans.length === 0 && (
        <Empty icon="clock">Waiting for the services to report. A plan is proposed once hospitals, ambulances and blood banks have answered (at most about 20 s).</Empty>
      )}
      {plans && plans.map((p) => <PlanView key={p.id} plan={p} canDecide={canDecide} busy={busy} onDecide={decide} />)}
    </Card>
  );
}
