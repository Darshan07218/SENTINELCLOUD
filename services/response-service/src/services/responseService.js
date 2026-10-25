import { randomUUID } from "node:crypto";
import { buildPlan, ACTION_KINDS } from "../playbook.js";
import { estimateImpact } from "../impact.js";
import { registry } from "../metrics.js";

/**
 * Phase 15 — the response engine (docs/PHASE-15-RESPONSE-ENGINE.md).
 *
 * Event in → plan → (approval) → commands out → replies in → plan settled.
 * Everything that changes state runs in one transaction with the events it
 * causes (commands, plan events go through the outbox), so a crash can never
 * leave "approved but no command sent" or "command sent but not recorded".
 */

/** Wait this long for the three key reactions before planning with what has arrived. */
export const PLAN_WAIT_SECONDS = 20;
/** A command with no reply after this long is marked FAILED (timeout). */
export const COMMAND_TIMEOUT_SECONDS = 120;
/** Recorded as the requester of auto-approved actions (no human involved). */
export const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

export const REACTION_KEYS = Object.freeze({
  "hospital.capacity.updated": "hospital",
  "ambulance.status.updated": "ambulance",
  "blood.shortage.detected": "blood",
  "power.infrastructure.at_risk": "power",
});
const REACTION_SOURCES = new Set(["hospital-service", "ambulance-service", "blood-bank-service", "power-service"]);
/** Planning waits for these; power only adds a notice. */
const REQUIRED_FOR_PLANNING = ["hospital", "ambulance", "blood"];

export const COMMAND_EXECUTORS = new Set(["ambulance-service", "blood-bank-service", "disaster-service", "hospital-service"]);
export const PLAN_EVENTS = Object.freeze({
  PROPOSED: "response.plan.proposed",
  APPROVED: "response.plan.approved",
  REJECTED: "response.plan.rejected",
  COMPLETED: "response.plan.completed",
  PARTIAL: "response.plan.completed", // same event, status says PARTIAL
  EXPIRED: "response.plan.expired",
  ROLLED_BACK: "response.plan.rolled_back",
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = new Set(["FLOOD", "FIRE", "EARTHQUAKE", "CYCLONE", "LANDSLIDE", "INDUSTRIAL_ACCIDENT"]);
const SEVERITIES = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const STATUSES = new Set(["ACTIVE", "CONTAINED", "RESOLVED"]);

const actionsFinished = registry.counter(
  "sentinel_response_actions_finished_total",
  "Response-plan actions that got a final outcome, by kind and outcome (SUCCEEDED, FAILED, UNDONE, UNDO_FAILED).",
  ["kind", "outcome"]
);

function httpError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/** Reason the disaster payload is unusable, or null. */
export function invalidDisaster(p) {
  if (!p || typeof p !== "object") return "no payload";
  if (!UUID_RE.test(String(p.disasterId))) return "disasterId is not a UUID";
  if (!TYPES.has(p.type) || !SEVERITIES.has(p.severity) || !STATUSES.has(p.status)) return "unknown type, severity or status";
  if (!Number.isFinite(p.latitude) || p.latitude < -90 || p.latitude > 90) return "latitude out of range";
  if (!Number.isFinite(p.longitude) || p.longitude < -180 || p.longitude > 180) return "longitude out of range";
  if (!Number.isFinite(p.radiusKm) || p.radiusKm <= 0 || p.radiusKm > 500) return "radiusKm out of range";
  return null;
}

/** The reactions that answer the disaster's CURRENT radius, by short name (hospital, ambulance, …). */
export function currentReactions(context) {
  const out = {};
  for (const [routingKey, entry] of Object.entries(context.reactions || {})) {
    const name = REACTION_KEYS[routingKey];
    if (name && entry?.payload && Number(entry.payload.searchRadiusKm) === context.radiusKm) out[name] = entry.payload;
  }
  return out;
}

/** What earlier plans for this disaster already achieved (input to a revision-2 plan). */
export function deliveredBy(plan) {
  const delivered = { ambulances: 0, bloodUnits: {}, failedBloodBanks: {}, beds: 0, icuBeds: 0, failedHospitals: [] };
  for (const a of plan?.actions || []) {
    if (a.kind === ACTION_KINDS.BLOOD_RESERVE && a.status === "FAILED") {
      // Don't ask the same bank for the same type again in the follow-up.
      (delivered.failedBloodBanks[a.params.bloodType] ||= []).push(a.params.bloodBankId);
    }
    if (a.kind === ACTION_KINDS.BEDS_RESERVE && a.status === "FAILED") delivered.failedHospitals.push(a.params.hospitalId);
    if (a.status !== "SUCCEEDED") continue;
    if (a.kind === ACTION_KINDS.BEDS_RESERVE) {
      // What the hospital actually held (it may hold fewer than asked if beds filled meanwhile).
      delivered.beds += a.result?.reservedBeds ?? 0;
      delivered.icuBeds += a.result?.reservedIcuBeds ?? 0;
    }
    if (a.kind === ACTION_KINDS.AMBULANCE_DISPATCH) delivered.ambulances += a.result?.dispatchedCount ?? 0;
    if (a.kind === ACTION_KINDS.BLOOD_RESERVE) {
      delivered.bloodUnits[a.params.bloodType] = (delivered.bloodUnits[a.params.bloodType] || 0) + a.params.units;
    }
  }
  return delivered;
}

/** The command that carries out one action; null for notices. */
export function commandFor(action, plan, requestedBy) {
  const d = plan.disaster;
  const base = { commandId: randomUUID(), planId: plan.id };
  switch (action.kind) {
    case ACTION_KINDS.AMBULANCE_DISPATCH:
      return {
        routingKey: "command.ambulance.dispatch",
        payload: { ...base, disasterId: d.id, latitude: d.latitude, longitude: d.longitude, count: action.params.count, severity: d.severity, description: `${d.severity} ${d.type}: ${d.description || ""}`.slice(0, 200), requestedBy },
      };
    case ACTION_KINDS.BLOOD_RESERVE:
      return {
        routingKey: "command.blood.reserve",
        payload: { ...base, bloodBankId: action.params.bloodBankId, bloodType: action.params.bloodType, units: action.params.units, hospitalId: action.params.hospitalId, requestedBy, notes: `Response plan for ${d.severity} ${d.type} (disaster ${d.id})` },
      };
    case ACTION_KINDS.BEDS_RESERVE:
      return {
        routingKey: "command.hospital.reserve-beds",
        payload: { ...base, disasterId: d.id, hospitalId: action.params.hospitalId, beds: action.params.beds, icuBeds: action.params.icuBeds, requestedBy, notes: `Response plan for ${d.severity} ${d.type} (disaster ${d.id})` },
      };
    case ACTION_KINDS.WIDEN_RADIUS:
      return { routingKey: "command.disaster.widen-radius", payload: { ...base, disasterId: d.id, radiusKm: action.params.radiusKm } };
    default:
      return null;
  }
}

/** The command that reverses a SUCCEEDED action; null if it can't be undone. */
export function undoCommandFor(action, plan) {
  const base = { commandId: randomUUID(), planId: plan.id };
  if (action.kind === ACTION_KINDS.AMBULANCE_DISPATCH && action.result?.emergencyIds?.length) {
    return { routingKey: "command.ambulance.stand-down", payload: { ...base, emergencyIds: action.result.emergencyIds } };
  }
  if (action.kind === ACTION_KINDS.BLOOD_RESERVE && action.result?.reservationId) {
    return { routingKey: "command.blood.release", payload: { ...base, reservationId: action.result.reservationId } };
  }
  if (action.kind === ACTION_KINDS.BEDS_RESERVE && action.result?.reservationId) {
    return { routingKey: "command.hospital.release-beds", payload: { ...base, reservationId: action.result.reservationId } };
  }
  return null; // widening a search isn't reversed: nothing was taken from anyone
}

/**
 * @param pool         pg pool (reads)
 * @param transaction  (fn) => runs fn({ repo, client }) in one transaction
 * @param repository   repository bound to the pool
 * @param outbox       createOutbox(...)
 * @param autoApprove  RESPONSE_AUTO_APPROVE: execute plans without waiting for an operator
 */
/**
 * @param estimate     Phase 20: (disaster) => impact estimate (impact.js); null plans
 *                     from the severity table alone, as in Phase 15
 */
export function createResponseService({ transaction, repository, outbox, autoApprove = false, log = console, estimate = estimateImpact }) {
  async function emitPlanEvent(client, plan, status) {
    const executable = plan.actions.filter((a) => a.kind !== ACTION_KINDS.NOTICE).length;
    await outbox.enqueue(
      client,
      PLAN_EVENTS[status],
      { planId: plan.id, disasterId: plan.disasterId, revision: plan.revision, status, mode: plan.mode, actionCount: plan.actions.length, executableCount: executable },
      plan.disasterId
    );
  }

  /** After a reply or timeout: close the plan if nothing is outstanding. Runs inside the caller's transaction. */
  async function settlePlan(repo, client, planId) {
    const plan = await repo.getPlan(planId);
    const commands = plan.actions.filter((a) => a.kind !== ACTION_KINDS.NOTICE);
    if (plan.status === "EXECUTING" && !commands.some((a) => a.status === "PENDING")) {
      const to = commands.every((a) => a.status === "SUCCEEDED") ? "COMPLETED" : "PARTIAL";
      if (await repo.transitionPlan(planId, ["EXECUTING"], to, { finished: true })) {
        await emitPlanEvent(client, { ...plan, status: to }, to);
      }
    } else if (plan.status === "UNDOING" && !plan.actions.some((a) => a.status === "UNDOING")) {
      if (await repo.transitionPlan(planId, ["UNDOING"], "ROLLED_BACK", { finished: true })) {
        await emitPlanEvent(client, { ...plan, status: "ROLLED_BACK" }, "ROLLED_BACK");
      }
    }
  }

  async function approve(planId, user, { note } = {}) {
    const plan = await transaction(async ({ repo, client }) => {
      const row = await repo.transitionPlan(planId, ["PROPOSED"], "EXECUTING", { decided: true, decidedBy: user?.id ?? null, decisionNote: note ?? null });
      if (!row) throw (await repo.getPlan(planId)) ? httpError(409, "PLAN_NOT_PROPOSED", "This plan has already been decided.") : httpError(404, "NOT_FOUND", "Plan not found.");
      const current = await repo.getPlan(planId);
      const requestedBy = user?.id ?? SYSTEM_USER_ID;
      for (const action of current.actions) {
        if (action.status !== "PROPOSED") continue;
        const command = commandFor(action, current, requestedBy);
        await outbox.enqueue(client, command.routingKey, command.payload, command.payload.commandId);
        await repo.markActionSent(action.id, command.payload.commandId);
      }
      await emitPlanEvent(client, { ...current, status: "EXECUTING" }, "APPROVED");
      await settlePlan(repo, client, planId); // a plan with nothing to execute completes at once
      return repo.getPlan(planId);
    });
    outbox.kick();
    log.log(`[response-service] plan ${planId} approved by ${user?.id ?? "auto mode"}`);
    return plan;
  }

  async function reject(planId, user, { note } = {}) {
    const plan = await transaction(async ({ repo, client }) => {
      const row = await repo.transitionPlan(planId, ["PROPOSED"], "REJECTED", { decided: true, decidedBy: user.id, decisionNote: note ?? null, finished: true });
      if (!row) throw (await repo.getPlan(planId)) ? httpError(409, "PLAN_NOT_PROPOSED", "This plan has already been decided.") : httpError(404, "NOT_FOUND", "Plan not found.");
      await repo.skipProposedActions(planId);
      const current = await repo.getPlan(planId);
      await emitPlanEvent(client, current, "REJECTED");
      return current;
    });
    outbox.kick();
    return plan;
  }

  async function undo(planId, user) {
    const plan = await transaction(async ({ repo, client }) => {
      const row = await repo.transitionPlan(planId, ["COMPLETED", "PARTIAL"], "UNDOING", { undone: true, undoneBy: user.id });
      if (!row) {
        throw (await repo.getPlan(planId))
          ? httpError(409, "PLAN_NOT_UNDOABLE", "Only a COMPLETED or PARTIAL plan can be undone (wait for it to finish, or it was already undone).")
          : httpError(404, "NOT_FOUND", "Plan not found.");
      }
      const current = await repo.getPlan(planId);
      for (const action of current.actions) {
        if (action.status !== "SUCCEEDED") continue;
        const command = undoCommandFor(action, current);
        if (!command) continue;
        await outbox.enqueue(client, command.routingKey, command.payload, command.payload.commandId);
        await repo.markActionUndoing(action.id, command.payload.commandId);
      }
      await settlePlan(repo, client, planId); // nothing to reverse → ROLLED_BACK at once
      return repo.getPlan(planId);
    });
    outbox.kick();
    return plan;
  }

  /**
   * Plans for a disaster if it's due: revision 1 once its key reactions are
   * in (or `force` after PLAN_WAIT_SECONDS); revision 2 once an escalation
   * succeeded and the reactions for the wider radius are in.
   */
  async function maybePlan(disasterId, { force = false } = {}) {
    const context = await repository.getContext(disasterId);
    if (!context || context.status === "RESOLVED") return null;
    const first = await repository.findPlan(disasterId, 1);
    let revision = 1;
    let delivered;
    if (first) {
      // The follow-up covers what revision 1 couldn't do, so it waits until
      // every revision-1 command has replied (a slow dispatch reply would
      // otherwise count as "nothing sent"). Not after an undo either.
      if (!["COMPLETED", "PARTIAL"].includes(first.status)) return null;
      const escalation = first.actions.find((a) => a.kind === ACTION_KINDS.WIDEN_RADIUS && a.status === "SUCCEEDED");
      if (!escalation || context.radiusKm < escalation.params.radiusKm) return null;
      if (await repository.findPlan(disasterId, 2)) return null;
      revision = 2;
      delivered = deliveredBy(first);
    }
    const reactions = currentReactions(context);
    if (!force && !REQUIRED_FOR_PLANNING.every((name) => reactions[name])) return null;

    const d = context.disaster;
    const disaster = { id: disasterId, type: d.type, severity: d.severity, latitude: d.latitude, longitude: d.longitude, radiusKm: context.radiusKm, description: d.description };
    // Phase 20: how many people the zone holds and what that means in casualties and beds.
    const impact = estimate ? estimate(disaster) : null;
    const { needs, actions } = buildPlan({ disaster, reactions, revision, delivered, impact });
    const executable = actions.some((a) => a.kind !== ACTION_KINDS.NOTICE);

    const plan = await transaction(async ({ repo, client }) => {
      const inserted = await repo.insertPlan({
        disasterId,
        revision,
        // Nothing to execute (e.g. enough already sent): recorded as done.
        status: executable ? "PROPOSED" : "COMPLETED",
        mode: autoApprove ? "AUTO" : "APPROVAL",
        // The estimate travels with the plan, so the page can show what it was based on.
        needs: impact
          ? { ...needs, impact: { population: impact.population, exposed: impact.exposed, casualties: impact.casualties, hospitalBeds: impact.hospitalBeds, icuBeds: impact.icuBeds, transport: impact.transport } }
          : needs,
        disaster,
        actions,
      });
      if (inserted) await emitPlanEvent(client, inserted, inserted.status === "PROPOSED" ? "PROPOSED" : "COMPLETED");
      return inserted;
    });
    if (!plan) return null; // another replica planned it first
    outbox.kick();
    log.log(`[response-service] proposed revision-${revision} plan ${plan.id} for disaster ${disasterId}: ${actions.length} action(s)${force ? " (planned without all reactions)" : ""}`);
    if (autoApprove && plan.status === "PROPOSED") return approve(plan.id, null, { note: "auto mode" });
    return plan;
  }

  async function handleDisasterEvent(envelope) {
    const problem = invalidDisaster(envelope.payload);
    if (problem) {
      log.warn(`[response-service] ignoring ${String(envelope.eventType).slice(0, 40)}: ${problem}`);
      return;
    }
    const p = envelope.payload;
    await transaction(async ({ repo, client }) => {
      await repo.upsertDisaster({ disasterId: p.disasterId, type: p.type, severity: p.severity, latitude: p.latitude, longitude: p.longitude, radiusKm: p.radiusKm, description: p.description ?? "", status: p.status });
      if (p.status === "RESOLVED") {
        // Too late to act on proposals that were never decided.
        for (const planId of await repo.plansOf(p.disasterId, ["PROPOSED"])) {
          if (await repo.transitionPlan(planId, ["PROPOSED"], "EXPIRED", { finished: true })) {
            await repo.skipProposedActions(planId);
            await emitPlanEvent(client, await repo.getPlan(planId), "EXPIRED");
          }
        }
      }
    });
    outbox.kick();
    if (p.status !== "RESOLVED") await maybePlan(p.disasterId);
  }

  async function handleReaction(envelope) {
    const { eventType, sourceService, correlationId, payload, occurredAt } = envelope;
    if (!REACTION_KEYS[eventType] || !REACTION_SOURCES.has(sourceService) || !UUID_RE.test(String(correlationId)) || !payload || typeof payload !== "object") {
      log.warn(`[response-service] ignoring unexpected reaction ${String(eventType).slice(0, 40)} from ${String(sourceService).slice(0, 40)}`);
      return;
    }
    const known = await transaction(async ({ repo }) => {
      const context = await repo.getContextForUpdate(correlationId);
      if (!context) return false; // a disaster from before this service existed
      const previous = context.reactions[eventType];
      if (previous?.occurredAt && occurredAt && Date.parse(previous.occurredAt) > Date.parse(occurredAt)) return true; // older redelivery
      await repo.saveReactions(correlationId, { ...context.reactions, [eventType]: { payload, occurredAt: occurredAt ?? null } });
      return true;
    });
    if (known) await maybePlan(correlationId);
  }

  async function handleCommandReply(envelope) {
    const { eventType, sourceService, payload } = envelope;
    const ok = eventType === "command.succeeded";
    if ((!ok && eventType !== "command.failed") || !COMMAND_EXECUTORS.has(sourceService) || !UUID_RE.test(String(payload?.commandId))) {
      log.warn(`[response-service] ignoring unexpected reply ${String(eventType).slice(0, 40)} from ${String(sourceService).slice(0, 40)}`);
      return;
    }
    const settled = await transaction(async ({ repo, client }) => {
      const action = await repo.findActionByCommandForUpdate(payload.commandId);
      if (!action) return null;
      const isUndo = action.undoCommandId === payload.commandId;
      let status = null;
      if (isUndo && ["UNDOING", "UNDO_FAILED"].includes(action.status)) status = ok ? "UNDONE" : "UNDO_FAILED";
      // FAILED: a success that arrives after the timeout still counts.
      if (!isUndo && ["PENDING", "FAILED"].includes(action.status)) status = ok ? "SUCCEEDED" : "FAILED";
      if (!status || status === action.status) return null; // duplicate reply
      await repo.finishAction(action.id, status, ok ? { result: payload.result ?? {} } : { error: payload.error ?? { code: "UNKNOWN" } });
      actionsFinished.inc({ kind: action.kind, outcome: status });
      await settlePlan(repo, client, action.planId);
      return { action, status };
    });
    if (!settled) return;
    outbox.kick();
    log.log(`[response-service] ${settled.action.kind} (plan ${settled.action.planId}) → ${settled.status}`);
    // This reply may have finished an escalated plan whose wider-radius
    // reactions are already in: plan the follow-up now rather than waiting
    // for the sweep. (maybePlan returns at once when nothing is due.)
    const plan = await repository.getPlan(settled.action.planId);
    if (plan && ["COMPLETED", "PARTIAL"].includes(plan.status)) await maybePlan(plan.disasterId);
  }

  /** Every few seconds: plan overdue disasters and time out silent commands. Never throws. */
  async function sweep() {
    try {
      for (const id of await repository.findUnplannedOlderThan(PLAN_WAIT_SECONDS)) await maybePlan(id, { force: true });
      for (const id of await repository.findEscalatedWithoutFollowUp(PLAN_WAIT_SECONDS)) await maybePlan(id, { force: true });
      // Safety net: close any plan whose actions have all finished.
      for (const id of await repository.findUnsettledPlans()) {
        await transaction(async ({ repo, client }) => {
          await repo.lockPlan(id);
          await settlePlan(repo, client, id);
        });
        outbox.kick();
        const settled = await repository.getPlan(id);
        if (settled && ["COMPLETED", "PARTIAL"].includes(settled.status)) await maybePlan(settled.disasterId);
      }
      for (const stale of await repository.findTimedOutActions(COMMAND_TIMEOUT_SECONDS)) {
        await transaction(async ({ repo, client }) => {
          const action = await repo.findActionByCommandForUpdate(stale.undoCommandId || stale.commandId);
          if (!action || !["PENDING", "UNDOING"].includes(action.status)) return;
          const status = action.status === "PENDING" ? "FAILED" : "UNDO_FAILED";
          await repo.finishAction(action.id, status, { error: { code: "TIMEOUT", message: `No reply within ${COMMAND_TIMEOUT_SECONDS} s.` } });
          actionsFinished.inc({ kind: action.kind, outcome: status });
          await settlePlan(repo, client, action.planId);
        });
        outbox.kick();
      }
    } catch (err) {
      log.error("[response-service] sweep failed (will retry):", err.message);
    }
  }

  return {
    approve,
    reject,
    undo,
    maybePlan,
    sweep,
    handleDisasterEvent,
    handleReaction,
    handleCommandReply,
    listPlans: (q) => repository.listPlans(q),
    async getPlan(id) {
      const plan = await repository.getPlan(id);
      if (!plan) throw httpError(404, "NOT_FOUND", "Plan not found.");
      return plan;
    },
  };
}
