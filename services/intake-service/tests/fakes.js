import { randomUUID } from "node:crypto";

/**
 * In-memory stand-in for detectionRepository.js with the same contract:
 * insertIfNew dedups on (source, externalId); transition only moves a row
 * that is in one of the expected statuses (atomic here because each call
 * runs to completion before another starts, like the single UPDATE in SQL).
 * The real SQL is exercised against PostgreSQL in tests/db/realPostgres.test.js.
 */
export function createMemoryRepository() {
  const rows = new Map();
  const sources = new Map();
  return {
    rows,
    async insertIfNew(d) {
      for (const r of rows.values()) if (r.source === d.source && r.externalId === d.externalId) return null;
      const row = { ...d, id: randomUUID(), detectedAt: new Date(), status: "PENDING", disasterId: null, decidedBy: null, decidedAt: null, note: null, error: null };
      rows.set(row.id, row);
      return { ...row };
    },
    async findById(id) {
      return rows.has(id) ? { ...rows.get(id) } : null;
    },
    async list({ status, limit = 50 } = {}) {
      return [...rows.values()].filter((r) => !status || r.status === status).slice(-limit).reverse().map((r) => ({ ...r }));
    },
    async transition(id, from, { status, disasterId = null, decidedBy = null, note = null, error = null }) {
      const r = rows.get(id);
      if (!r || !from.includes(r.status)) return null;
      Object.assign(r, { status, disasterId: disasterId ?? r.disasterId, decidedBy: decidedBy ?? r.decidedBy, note: note ?? r.note, error, decidedAt: new Date() });
      return { ...r };
    },
    async expirePending(hours) {
      let n = 0;
      for (const r of rows.values()) if (r.status === "PENDING" && Date.now() - r.detectedAt.getTime() > hours * 3600e3) (r.status = "EXPIRED"), n++;
      return n;
    },
    async failStuckConfirming() {
      return 0;
    },
    async countByStatus() {
      return [];
    },
    async recordPoll(source, { ok, error = null, found = 0, reading = null }) {
      const prev = sources.get(source) || {};
      sources.set(source, { source, lastPolledAt: new Date(), lastOkAt: ok ? new Date() : prev.lastOkAt, lastError: error, lastFound: ok ? found : prev.lastFound, reading: reading ?? prev.reading ?? {} });
    },
    async sources() {
      return [...sources.values()];
    },
  };
}

/** Records POST /disasters calls; `fail` makes the next call throw. */
export function createFakeGateway({ delayMs = 0 } = {}) {
  const calls = [];
  const gw = {
    calls,
    fail: null,
    async post(path, body) {
      calls.push({ path, body });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (gw.fail) {
        const err = gw.fail;
        gw.fail = null;
        throw err;
      }
      return { disaster: { id: randomUUID(), ...body }, eventPublished: true };
    },
  };
  return gw;
}

export const PUNE = { name: "Pune", latitude: 18.5204, longitude: 73.8567, radiusKm: 500, minMagnitude: 3.0 };

/** A USGS GeoJSON feature. */
export function quake({ id = "us7000test", mag = 4.8, lat = 17.4, lng = 73.75, depth = 10, place = "12 km S of Koyna, India", type = "earthquake" } = {}) {
  return { type: "Feature", id, properties: { mag, place, time: Date.parse("2026-10-25T06:00:00Z"), type, url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}` }, geometry: { type: "Point", coordinates: [lng, lat, depth] } };
}

/** An Open-Meteo hourly forecast with the given rain per hour and gusts. */
export function forecast({ rainPerHour = 0, gust = 20, hours = 24 } = {}) {
  return {
    hourly: {
      time: Array.from({ length: hours }, (_, i) => `2026-10-25T${String(i).padStart(2, "0")}:00`),
      precipitation: Array(hours).fill(rainPerHour),
      wind_gusts_10m: Array(hours).fill(gust),
    },
  };
}

export const quiet = { log: () => {}, warn: () => {} };
