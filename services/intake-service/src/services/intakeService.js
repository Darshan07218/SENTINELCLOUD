/**
 * Phase 19: the detection engine (docs/PHASE-19-AUTO-DETECTION.md §2).
 *
 *   poll a source → candidate detections → stored once each (dedup on the
 *   source's own id) → auto-confirmed if severe enough, otherwise PENDING
 *   for an operator → on confirm, the disaster is created THROUGH THE
 *   GATEWAY with intake's own service account, exactly as an operator's
 *   click would, and from there the normal flow runs (disaster.detected,
 *   the four services react, the response engine proposes a plan).
 */
import { randomUUID } from "node:crypto";
import { parseUsgsFeed, USGS_DEFAULT_FEED } from "../sources/usgs.js";
import { parseOpenMeteo, openMeteoUrl, OPEN_METEO_DEFAULT_URL } from "../sources/openMeteo.js";
import { severityRank, SEVERITIES } from "../sources/geo.js";

export const DISASTER_TYPES = ["FLOOD", "FIRE", "EARTHQUAKE", "CYCLONE", "LANDSLIDE", "INDUSTRIAL_ACCIDENT"];
export const DETECTION_STATUSES = ["PENDING", "CONFIRMING", "CONFIRMED", "AUTO_CONFIRMED", "DISMISSED", "EXPIRED", "FAILED"];
const FETCH_TIMEOUT_MS = 15_000;

/** A conflict the API reports as 409 (already decided). */
export class IntakeError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** Plain-words texts for injected demo detections, per type. */
const DEMO_TEXT = {
  FLOOD: "DEMO: river level rising fast after a cloudburst upstream; low-lying wards at risk.",
  FIRE: "DEMO: large fire reported in an industrial estate; smoke spreading over residential blocks.",
  EARTHQUAKE: "DEMO: shallow earthquake felt across the city; reports of cracked buildings.",
  CYCLONE: "DEMO: severe cyclonic storm approaching; damaging gusts expected within hours.",
  LANDSLIDE: "DEMO: landslide on a hillside settlement after continuous rain.",
  INDUSTRIAL_ACCIDENT: "DEMO: chemical leak at a plant; evacuation of the surrounding area advised.",
};

export function createIntakeService({
  repository,
  gateway,
  watch, // { latitude, longitude, radiusKm, minMagnitude, name }
  autoConfirmMinSeverity = "CRITICAL", // or "NONE"
  expireHours = 12,
  sources = {}, // { usgs: { enabled, url, intervalSeconds }, openMeteo: { enabled, url, intervalSeconds } }
  fetchImpl = globalThis.fetch,
  onDetection = () => {},
  log = console,
}) {
  // Settings left unset (undefined, e.g. an empty env var) keep the default.
  const defined = (o = {}) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const usgs = { enabled: true, url: USGS_DEFAULT_FEED, intervalSeconds: 120, ...defined(sources.usgs) };
  const openMeteo = { enabled: true, url: OPEN_METEO_DEFAULT_URL, intervalSeconds: 1800, ...defined(sources.openMeteo) };
  const timers = [];

  function shouldAutoConfirm(severity) {
    return autoConfirmMinSeverity !== "NONE" && severityRank(severity) >= severityRank(autoConfirmMinSeverity);
  }

  async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: "application/json", "User-Agent": "SentinelCloud intake-service" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Stores each candidate once; new ones are counted and auto-confirmed if the policy says so. */
  async function ingest(candidates) {
    const created = [];
    for (const c of candidates) {
      const detection = await repository.insertIfNew(c);
      if (!detection) continue; // seen before
      created.push(detection);
      onDetection(detection);
      log.log?.(`[intake-service] new ${detection.source} detection: ${detection.type} ${detection.severity}: ${detection.title}`);
      if (shouldAutoConfirm(detection.severity)) {
        await confirm(detection.id, { email: "auto" }, { auto: true }).catch((err) =>
          log.warn?.(`[intake-service] auto-confirm of ${detection.id} failed: ${err.message}`)
        );
      }
    }
    return created;
  }

  async function pollUsgs() {
    try {
      const candidates = parseUsgsFeed(await fetchJson(usgs.url), watch);
      const created = await ingest(candidates);
      await repository.recordPoll("USGS", { ok: true, found: candidates.length, reading: { inRange: candidates.length, watchRadiusKm: watch.radiusKm, minMagnitude: watch.minMagnitude } });
      return created;
    } catch (err) {
      await repository.recordPoll("USGS", { ok: false, error: err.message }).catch(() => {});
      log.warn?.(`[intake-service] USGS poll failed: ${err.message}`);
      return [];
    }
  }

  async function pollOpenMeteo() {
    try {
      const { summary, detections } = parseOpenMeteo(await fetchJson(openMeteoUrl(openMeteo.url, watch)), watch);
      const created = await ingest(detections);
      await repository.recordPoll("OPEN_METEO", { ok: true, found: detections.length, reading: summary });
      return created;
    } catch (err) {
      await repository.recordPoll("OPEN_METEO", { ok: false, error: err.message }).catch(() => {});
      log.warn?.(`[intake-service] Open-Meteo poll failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Creates the disaster for a detection. The detection is first claimed
   * (PENDING/FAILED → CONFIRMING) in one UPDATE, so of two simultaneous
   * confirms exactly one creates a disaster and the other gets 409.
   */
  async function confirm(id, user, { auto = false, note } = {}) {
    const claimed = await repository.transition(id, ["PENDING", "FAILED"], { status: "CONFIRMING", decidedBy: auto ? "auto" : user?.email || user?.id || "unknown", note });
    if (!claimed) {
      const existing = await repository.findById(id);
      if (!existing) throw new IntakeError(404, "NOT_FOUND", "Detection not found.");
      throw new IntakeError(409, "ALREADY_DECIDED", `Detection is already ${existing.status}.`);
    }
    try {
      const body = {
        type: claimed.type,
        severity: claimed.severity,
        latitude: claimed.latitude,
        longitude: claimed.longitude,
        radiusKm: claimed.radiusKm,
        description: `[Auto-detected · ${claimed.source}${auto ? " · auto-confirmed" : ""}] ${claimed.description}`.slice(0, 2000),
        occurredAt: new Date(claimed.observedAt).toISOString(),
      };
      const result = await gateway.post("/disasters", body);
      const disasterId = result?.disaster?.id;
      if (!disasterId) throw new Error("the disaster API returned no id");
      const done = await repository.transition(id, ["CONFIRMING"], { status: auto ? "AUTO_CONFIRMED" : "CONFIRMED", disasterId });
      log.log?.(`[intake-service] detection ${id} ${auto ? "auto-confirmed" : "confirmed"} → disaster ${disasterId}`);
      return done;
    } catch (err) {
      await repository.transition(id, ["CONFIRMING"], { status: "FAILED", error: err.message.slice(0, 500) });
      if (auto) throw err;
      throw new IntakeError(502, "DISASTER_NOT_CREATED", `The disaster could not be created: ${err.message}. The detection is FAILED and can be confirmed again.`);
    }
  }

  async function dismiss(id, user, { note } = {}) {
    const done = await repository.transition(id, ["PENDING", "FAILED"], { status: "DISMISSED", decidedBy: user?.email || user?.id || "unknown", note });
    if (done) return done;
    const existing = await repository.findById(id);
    if (!existing) throw new IntakeError(404, "NOT_FOUND", "Detection not found.");
    throw new IntakeError(409, "ALREADY_DECIDED", `Detection is already ${existing.status}.`);
  }

  /** A clearly labelled DEMO detection near the city centre, through the same pipeline. */
  async function injectDemo({ type, severity }) {
    const offset = () => (Math.random() - 0.5) * 0.06; // up to ~3 km from the centre
    const [created] = await ingest([
      {
        source: "DEMO",
        externalId: `demo:${randomUUID()}`,
        type,
        severity,
        latitude: Math.round((watch.latitude + offset()) * 1e5) / 1e5,
        longitude: Math.round((watch.longitude + offset()) * 1e5) / 1e5,
        radiusKm: 15,
        title: `DEMO ${type.toLowerCase().replace(/_/g, " ")} (${severity})`,
        description: DEMO_TEXT[type],
        observedAt: new Date().toISOString(),
        details: { demo: true },
      },
    ]);
    return repository.findById(created.id);
  }

  async function sweep() {
    const expired = await repository.expirePending(expireHours);
    const unstuck = await repository.failStuckConfirming(5);
    if (expired) log.log?.(`[intake-service] ${expired} pending detection(s) expired after ${expireHours} h without a decision`);
    if (unstuck) log.warn?.(`[intake-service] ${unstuck} interrupted confirm(s) marked FAILED`);
  }

  async function overview() {
    const status = Object.fromEntries((await repository.sources()).map((s) => [s.source, s]));
    return {
      watch,
      policy: { autoConfirmMinSeverity, expireHours, severities: SEVERITIES },
      sources: [
        { source: "USGS", label: "USGS earthquakes", enabled: usgs.enabled, intervalSeconds: usgs.intervalSeconds, ...status.USGS },
        { source: "OPEN_METEO", label: "Open-Meteo rain & wind", enabled: openMeteo.enabled, intervalSeconds: openMeteo.intervalSeconds, ...status.OPEN_METEO },
      ],
    };
  }

  async function pollNow() {
    const [a, b] = await Promise.all([usgs.enabled ? pollUsgs() : [], openMeteo.enabled ? pollOpenMeteo() : []]);
    return [...a, ...b];
  }

  function start() {
    const every = (fn, seconds, firstDelayMs) => {
      const first = setTimeout(fn, firstDelayMs);
      const repeat = setInterval(fn, seconds * 1000);
      first.unref?.();
      repeat.unref?.();
      timers.push(first, repeat);
    };
    if (usgs.enabled) every(pollUsgs, usgs.intervalSeconds, 5_000);
    if (openMeteo.enabled) every(pollOpenMeteo, openMeteo.intervalSeconds, 8_000);
    every(() => sweep().catch((err) => log.warn?.(`[intake-service] sweep failed: ${err.message}`)), 60, 30_000);
  }

  function stop() {
    for (const t of timers) {
      clearTimeout(t);
      clearInterval(t);
    }
  }

  return { pollUsgs, pollOpenMeteo, pollNow, ingest, confirm, dismiss, injectDemo, sweep, overview, shouldAutoConfirm, start, stop, list: (q) => repository.list(q), get: (id) => repository.findById(id) };
}
