import { randomUUID } from "node:crypto";
import { normalReading } from "./ambient.js";
import { haversineKm } from "./trips.js";

/**
 * Phase 16 — plays one scenario at a time (docs/PHASE-16-SIMULATOR.md §2).
 *
 * Steps run at their `at` offsets. Each step's outcome (DONE / FAILED with
 * the reason) is recorded for the Simulator page; a failed step doesn't stop
 * the run, because a demo shouldn't die halfway. stop() skips the remaining
 * steps except `cleanup` ones, which run straight away.
 */
export class ConflictError extends Error {}

/** power-service answers a reading with { telemetry: { status, … } }. */
export function telemetryStatus(result) {
  return result?.telemetry?.status ?? result?.status ?? "reported";
}

const realClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The actions a scenario step can take, each through the gateway (`client`). */
export function createActions({ client, clock = realClock, pollMs = 2000 }) {
  async function waitForPlan(ctx, revision, timeoutSeconds) {
    const deadline = clock.now() + timeoutSeconds * 1000;
    for (;;) {
      const { plans = [] } = (await client.get(`/response/plans?disasterId=${ctx.disasterId}`)) || {};
      const plan = plans.find((p) => p.revision === revision);
      if (plan) return plan;
      if (clock.now() >= deadline) throw new Error(`no revision-${revision} plan within ${timeoutSeconds} s`);
      await clock.sleep(pollMs);
    }
  }

  function requireDisaster(ctx) {
    if (!ctx.disasterId) throw new Error("no disaster reported yet in this run");
    return ctx.disasterId;
  }

  return {
    async report(params, ctx) {
      const { disaster } = await client.post("/disasters", params);
      Object.assign(ctx, { disasterId: disaster.id, disaster });
      return `Disaster ${disaster.id.slice(0, 8)} reported (${disaster.severity} ${disaster.type}, ${disaster.radiusKm} km).`;
    },

    async approvePlan({ revision = 1, timeoutSeconds = 30 }, ctx) {
      requireDisaster(ctx);
      const plan = await waitForPlan(ctx, revision, timeoutSeconds);
      if (plan.status !== "PROPOSED") return `Revision-${revision} plan is already ${plan.status}; nothing to approve.`;
      const { plan: approved } = await client.post(`/response/plans/${plan.id}/approve`, { note: "Approved by the scenario simulator." });
      const commands = approved.actions.filter((a) => a.kind !== "notice").length;
      return `Revision-${revision} plan approved: ${commands} action(s) sent.`;
    },

    async rejectPlan({ revision = 1, timeoutSeconds = 30, note }, ctx) {
      requireDisaster(ctx);
      const plan = await waitForPlan(ctx, revision, timeoutSeconds);
      if (plan.status !== "PROPOSED") return `Revision-${revision} plan is already ${plan.status}; nothing to reject.`;
      await client.post(`/response/plans/${plan.id}/reject`, { note });
      return `Revision-${revision} plan rejected: "${note}".`;
    },

    async updateDisaster(fields, ctx) {
      const { disaster } = await client.put(`/disasters/${requireDisaster(ctx)}`, fields);
      return `Disaster updated: ${disaster.severity}, ${disaster.radiusKm} km.`;
    },

    async setStatus({ status, note }, ctx) {
      const id = requireDisaster(ctx);
      try {
        await client.post(`/disasters/${id}/status`, { status, note });
      } catch (err) {
        // Already there (e.g. an operator resolved it by hand): fine for a demo.
        if (err.code === "INVALID_STATUS_TRANSITION") return `Disaster was already past ${status}.`;
        throw err;
      }
      return `Disaster is now ${status}.`;
    },

    async hospitalSurge({ count = 2, fraction = 0.6 }, ctx) {
      const d = ctx.disaster || {};
      const { hospitals = [] } = (await client.get(`/hospitals/near?lat=${d.latitude}&lng=${d.longitude}&radiusKm=${d.radiusKm || 15}`)) || {};
      const chosen = hospitals.filter((h) => h.availableBeds > 0).slice(0, count);
      for (const h of chosen) {
        const reduced = Math.floor(h.availableBeds * (1 - fraction));
        await client.patch(`/hospitals/${h.id}/beds`, { availableBeds: reduced });
        ctx.hospitalBackup.push({ id: h.id, name: h.name, availableBeds: h.availableBeds });
      }
      return chosen.length
        ? `Free beds cut by ${Math.round(fraction * 100)}% at ${chosen.map((h) => h.name).join(" and ")}.`
        : "No hospital with free beds near the disaster.";
    },

    async hospitalRecover(_params, ctx) {
      const restored = [];
      for (const h of ctx.hospitalBackup.splice(0)) {
        await client.patch(`/hospitals/${h.id}/beds`, { availableBeds: h.availableBeds });
        restored.push(h.name);
      }
      return restored.length ? `Free beds restored at ${restored.join(" and ")}.` : "Nothing to restore.";
    },

    async transformerSpike(_params, ctx) {
      const d = ctx.disaster || {};
      const { markers = [] } = (await client.get("/power/map")) || {};
      const nearest = markers
        .filter((m) => (m.transformers || []).length)
        .map((m) => ({ ...m, km: haversineKm(d.latitude, d.longitude, m.latitude, m.longitude) }))
        .sort((a, b) => a.km - b.km)[0];
      if (!nearest) return "No substation with transformers found.";
      const id = nearest.transformers[0].transformerId;
      const res = await client.get(`/power/transformers/${id}`);
      const t = res?.transformer ?? res;
      ctx.transformerBackup.push({ id, code: t.code, ratedVoltageKv: t.ratedVoltageKv, ratedCurrentAmps: t.ratedCurrentAmps, lastLoadPercentage: t.lastLoadPercentage, lastTemperatureCelsius: t.lastTemperatureCelsius });
      // Overloaded and overheating: load 125 % (CRITICAL from 100 %), 95 °C (CRITICAL from 85 °C).
      const reading = { voltage: t.ratedVoltageKv, currentAmps: Math.round(t.ratedCurrentAmps * 1.2 * 10) / 10, loadPercentage: 125, temperatureCelsius: 95 };
      const result = await client.post(`/power/transformers/${id}/telemetry`, reading);
      return `Transformer ${t.code} at ${nearest.substationName}: load 125 %, 95 °C → ${telemetryStatus(result)}.`;
    },

    async transformerRecover(_params, ctx) {
      const done = [];
      for (const t of ctx.transformerBackup.splice(0)) {
        // Back to its own pre-spike level (normalReading walks it inside the normal band).
        const reading = normalReading({ ...t, lastLoadPercentage: t.lastLoadPercentage ?? 55, lastTemperatureCelsius: t.lastTemperatureCelsius ?? 50 });
        const result = await client.post(`/power/transformers/${t.id}/telemetry`, reading);
        done.push(`${t.code} → ${telemetryStatus(result)}`);
      }
      return done.length ? `Transformer back to normal: ${done.join(", ")}.` : "Nothing to restore.";
    },
  };
}

export function createRunner({ actions, ambient, scenarios, clock = realClock, log = console, sliceMs = 500 }) {
  let run = null;
  let stopRequested = false;

  const snapshot = () => (run ? JSON.parse(JSON.stringify({ ...run, ctx: undefined, disasterId: run.ctx.disasterId ?? null })) : null);

  async function sleepUntil(t) {
    while (!stopRequested && clock.now() < t) await clock.sleep(Math.min(sliceMs, t - clock.now()));
  }

  async function execute() {
    // Ambulances drive their calls during the scenario. Background mode stays
    // on afterwards, so they finish their trips; the page can switch it off.
    if (run.ambient) ambient?.setEnabled(true);
    for (const step of run.steps) {
      if (stopRequested && !step.cleanup) {
        step.status = "SKIPPED";
        continue;
      }
      if (!stopRequested) await sleepUntil(run.startedAtMs + step.at * 1000);
      if (stopRequested && !step.cleanup) {
        step.status = "SKIPPED";
        continue;
      }
      step.status = "RUNNING";
      step.startedAt = new Date(clock.now()).toISOString();
      try {
        step.detail = await actions[step.action](step.params || {}, run.ctx);
        step.status = "DONE";
      } catch (err) {
        step.status = "FAILED";
        step.detail = String(err.message).slice(0, 300);
        log.warn?.(`[simulator-service] step ${step.action} failed: ${err.message}`);
      }
    }
    run.status = stopRequested ? "STOPPED" : run.steps.some((s) => s.status === "FAILED") ? "COMPLETED_WITH_ERRORS" : "COMPLETED";
    run.finishedAt = new Date(clock.now()).toISOString();
    log.log?.(`[simulator-service] scenario ${run.scenarioId} ${run.status}`);
  }

  return {
    start(scenarioId, { startedBy } = {}) {
      if (run?.status === "RUNNING") throw new ConflictError("A scenario is already running. Stop it first.");
      const scenario = scenarios.find((s) => s.id === scenarioId);
      if (!scenario) throw new Error(`Unknown scenario '${String(scenarioId).slice(0, 60)}'.`);
      stopRequested = false;
      run = {
        id: randomUUID(),
        scenarioId: scenario.id,
        title: scenario.title,
        ambient: scenario.ambient,
        status: "RUNNING",
        startedBy: startedBy ?? null,
        startedAt: new Date(clock.now()).toISOString(),
        startedAtMs: clock.now(),
        finishedAt: null,
        steps: scenario.steps.map((s) => ({ ...s, status: "PENDING", detail: null, startedAt: null })),
        ctx: { disasterId: null, disaster: null, hospitalBackup: [], transformerBackup: [] },
      };
      run.done = execute().catch((err) => {
        run.status = "FAILED";
        run.finishedAt = new Date(clock.now()).toISOString();
        log.error?.(`[simulator-service] scenario crashed: ${err.message}`);
      });
      return snapshot();
    },
    stop() {
      if (run?.status !== "RUNNING") return false;
      stopRequested = true;
      return true;
    },
    current: snapshot,
    isRunning: () => run?.status === "RUNNING",
    /** For tests and shutdown: resolves when the current run has finished. */
    settled: () => run?.done ?? Promise.resolve(),
  };
}
