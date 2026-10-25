import { nextTripStep, chooseHospital } from "./trips.js";
import { ApiError, BudgetExceeded } from "./gatewayClient.js";

/**
 * Phase 16 — background activity, the "living city"
 * (docs/PHASE-16-SIMULATOR.md §3). Off by default. Every tick:
 *   1. every ambulance on a call takes its next trip step (trips.js);
 *   2. one transformer (round robin) reports a normal reading.
 * All of it through the gateway as the simulator account, within the
 * background write budget (gatewayClient.js).
 */
export const TICK_SECONDS = 10;
export const NORMAL_LOAD = [40, 75];
export const NORMAL_TEMP = [40, 60];

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;

/** The calm operating point background readings settle around. */
export const CALM_LOAD = 55;
export const CALM_TEMP = 45;

/**
 * A normal reading close to the transformer's last one, so the power
 * dashboard moves without raising alarms. Besides fixed thresholds, the
 * power service flags a reading more than ~2.5 standard deviations from the
 * transformer's OWN recent mean, and the seeded history is very steady. So:
 * very small noise, and load/temperature pulled 15 % of the way back to a
 * calm point each time instead of wandering (a first version with ±2–3 %
 * noise drifted and set healthy transformers to WARNING on the cluster).
 * A transformer left hot by a scenario is walked back down in steps.
 */
export function normalReading({ ratedVoltageKv, ratedCurrentAmps, lastLoadPercentage, lastTemperatureCelsius }, random = Math.random) {
  const jitter = (spread) => (random() - 0.5) * 2 * spread;
  const settle = (last, calm, [lo, hi], hotStep, noise) => {
    if (last == null) return calm + jitter(noise);
    if (last > hi) return Math.max(hi, last - hotStep); // cool down from a spike, not snap
    return clamp(last + (calm - last) * 0.15 + jitter(noise), [lo, hi]);
  };
  return {
    voltage: round1(ratedVoltageKv * (1 + jitter(0.003))),
    currentAmps: round1(ratedCurrentAmps * (1 + jitter(0.006))),
    loadPercentage: round1(settle(lastLoadPercentage, CALM_LOAD, NORMAL_LOAD, 10, 0.8)),
    temperatureCelsius: round1(settle(lastTemperatureCelsius, CALM_TEMP, NORMAL_TEMP, 8, 0.4)),
  };
}

export function createAmbient({ client, log = console, random = Math.random, tickSeconds = TICK_SECONDS }) {
  let enabled = false;
  let timer = null;
  let ticking = false;
  let transformerCursor = 0;
  let transformerCache = { at: 0, list: [] };
  const dwell = new Map(); // ambulanceId → { status, ticks }
  const stats = { ticks: 0, statusChanges: 0, moves: 0, completedCalls: 0, readings: 0, skippedForBudget: 0, errors: 0, lastTickAt: null, lastError: null };

  function note(err) {
    if (err instanceof BudgetExceeded) {
      stats.skippedForBudget++;
      return "budget";
    }
    stats.errors++;
    stats.lastError = String(err.message).slice(0, 200);
    if (!(err instanceof ApiError && err.status === 409)) log.warn?.(`[simulator-service] background step failed: ${err.message}`);
    return "error";
  }

  async function advanceTrips() {
    const { ambulances = [] } = (await client.get("/ambulances?limit=100", { priority: "ambient" })) || {};
    const onCall = ambulances.filter((a) => a.assignedEmergencyId);
    for (const a of ambulances) {
      const d = dwell.get(a.id);
      dwell.set(a.id, d && d.status === a.status ? { status: a.status, ticks: d.ticks + 1 } : { status: a.status, ticks: 0 });
    }
    if (onCall.length === 0) return;
    const { emergencies = [] } = (await client.get("/ambulances/emergencies/active", { priority: "ambient" })) || {};
    const byId = new Map(emergencies.map((e) => [e.id, e]));
    let hospitals = null;
    const hospitalList = async () => (hospitals ??= ((await client.get("/hospitals?limit=200", { priority: "ambient" })) || {}).hospitals || []);

    for (const a of onCall) {
      const emergency = byId.get(a.assignedEmergencyId) || null;
      const hospital = a.assignedHospitalId ? (await hospitalList()).find((h) => h.id === a.assignedHospitalId) || null : null;
      const step = nextTripStep({ ambulance: a, emergency, hospital, dwell: dwell.get(a.id)?.ticks ?? 0, tickSeconds });
      if (!step || step.type === "wait") continue;
      try {
        if (step.type === "status") {
          await client.patch(`/ambulances/${a.id}/status`, { status: step.status }, { priority: "ambient" });
          stats.statusChanges++;
        } else if (step.type === "move") {
          await client.patch(`/ambulances/${a.id}/location`, { latitude: step.latitude, longitude: step.longitude }, { priority: "ambient" });
          stats.moves++;
        } else if (step.type === "chooseHospital") {
          const target = chooseHospital(await hospitalList(), a);
          if (target) await client.patch(`/ambulances/${a.id}/assign-hospital`, { hospitalId: target.id }, { priority: "ambient" });
        } else if (step.type === "complete") {
          await client.post(`/ambulances/emergencies/${step.emergencyId}/complete`, {}, { priority: "ambient" });
          stats.completedCalls++;
        }
      } catch (err) {
        if (note(err) === "budget") return; // no room left this minute: carry on next tick
      }
    }
  }

  async function sendReading() {
    if (Date.now() - transformerCache.at > 5 * 60_000 || transformerCache.list.length === 0) {
      const map = (await client.get("/power/map", { priority: "ambient" })) || {};
      transformerCache = { at: Date.now(), list: (map.markers || []).flatMap((m) => (m.transformers || []).map((t) => t.transformerId)) };
    }
    if (transformerCache.list.length === 0) return;
    const id = transformerCache.list[transformerCursor++ % transformerCache.list.length];
    const res = await client.get(`/power/transformers/${id}`, { priority: "ambient" });
    const t = res?.transformer ?? res;
    if (!t?.ratedVoltageKv) return;
    await client.post(`/power/transformers/${id}/telemetry`, normalReading(t, random), { priority: "ambient" });
    stats.readings++;
  }

  async function tick() {
    if (!enabled || ticking) return;
    ticking = true;
    try {
      stats.ticks++;
      stats.lastTickAt = new Date().toISOString();
      try {
        await advanceTrips();
      } catch (err) {
        note(err);
      }
      try {
        await sendReading();
      } catch (err) {
        note(err);
      }
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    setEnabled(on) {
      enabled = Boolean(on);
      if (enabled && !timer) {
        timer = setInterval(tick, tickSeconds * 1000);
        timer.unref?.();
        tick();
      } else if (!enabled && timer) {
        clearInterval(timer);
        timer = null;
      }
      return enabled;
    },
    isEnabled: () => enabled,
    status: () => ({ enabled, tickSeconds, ...stats }),
  };
}
