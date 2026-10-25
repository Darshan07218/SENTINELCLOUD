import { readFileSync } from "node:fs";

/**
 * Phase 21: the hospitals are REAL Pune hospitals from OpenStreetMap
 * (src/data/pune-hospitals.json, built by tools/real-data/build-snapshots.mjs;
 * © OpenStreetMap contributors, ODbL). Names, locations, addresses and
 * phone numbers come from OSM. Bed, ICU and ventilator totals are ESTIMATES
 * unless capacity_source is osm:beds (OSM almost never records them), and
 * the starting availability is synthetic. Each row keeps its osm_id and
 * capacity_source so the API and the dashboard can say so.
 *
 * Idempotent: only inserts when the table is empty.
 */
const SNAPSHOT_URL = new URL("../data/pune-hospitals.json", import.meta.url);

export function loadHospitalSnapshot() {
  return JSON.parse(readFileSync(SNAPSHOT_URL, "utf8"));
}

/**
 * One hospital starts flagged OVERLOADED, so the overloaded-hospital views
 * have something to show: an operator's explicit declaration, distinct from
 * the computed low-capacity alerts (see capacity.js). Demo state, not a claim
 * about the real hospital.
 */
export const OVERLOADED_DEMO_NAME_PATTERN = /Jehangir/i;

export async function seedSampleHospitals(pool) {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM hospitals");
  if (rows[0].count > 0) {
    console.log("[hospital-service] hospitals table already has data — skipping seed");
    return;
  }

  const snapshot = loadHospitalSnapshot();
  let overloadedSet = false;
  for (const h of snapshot.items) {
    const overloaded = !overloadedSet && OVERLOADED_DEMO_NAME_PATTERN.test(h.name);
    if (overloaded) overloadedSet = true;
    await pool.query(
      `INSERT INTO hospitals (
         name, address, latitude, longitude,
         emergency_contact_name, emergency_contact_phone,
         total_beds, available_beds,
         total_icu_beds, available_icu_beds,
         total_ventilators, available_ventilators,
         emergency_status, osm_id, capacity_source
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        h.name,
        h.address,
        h.latitude,
        h.longitude,
        h.emergencyDepartment ? "Emergency department" : "Front desk",
        h.phone || "not listed in OSM",
        h.totalBeds,
        overloaded ? Math.min(h.availableBeds, Math.floor(h.totalBeds * 0.03)) : h.availableBeds,
        h.totalIcuBeds,
        overloaded ? 0 : h.availableIcuBeds,
        h.totalVentilators,
        h.availableVentilators,
        overloaded ? "OVERLOADED" : "NORMAL",
        h.osmId,
        h.capacitySource,
      ]
    );
  }

  console.log(`[hospital-service] seeded ${snapshot.items.length} real Pune hospitals from OpenStreetMap (retrieved ${snapshot.retrievedAt.slice(0, 10)}; capacities estimated)`);
}

// ---------------------------------------------------------------------
// Phase 18: demo capacity history
// ---------------------------------------------------------------------
const BACKFILL_HOURS = 72;
const HISTORY_RETENTION_DAYS = 30;

/** Small deterministic PRNG (mulberry32), seeded per hospital so a demo looks the same every time. */
function seededRandom(text) {
  let seed = 0;
  for (const ch of text) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) | 0;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Hourly occupancy for the `hours` before now, ending at the current
 * occupancy: walked backwards from now with a per-hospital drift (busy
 * hospitals have been filling up, quiet ones drift either way) and noise.
 */
export function syntheticOccupancyPath(name, currentPct, hours, kind) {
  const rand = seededRandom(`${name}:${kind}`);
  const drift = currentPct >= 75 ? 0.08 + rand() * 0.22 : -0.1 + rand() * 0.25; // % per hour
  const path = [];
  let noise = 0;
  for (let k = 1; k <= hours; k++) {
    noise = noise * 0.8 + (rand() - 0.5) * 1.6;
    path.push({ hoursAgo: k, pct: Math.min(100, Math.max(0, currentPct - drift * k + noise)) });
  }
  return path;
}

/**
 * Gives every hospital without history (a fresh install, or one that
 * predates Phase 18) 72 hours of synthetic hourly history, so the
 * forecast has something to work on in a demo. Rows are marked
 * source='backfill'; the forecast reports how many it used. Real changes
 * are recorded by the trigger from then on. Also trims history older
 * than 30 days.
 */
export async function backfillCapacityHistory(pool, { nowMs = Date.now() } = {}) {
  await pool.query(`DELETE FROM hospital_capacity_history WHERE recorded_at < now() - interval '${HISTORY_RETENTION_DAYS} days'`);
  const { rows } = await pool.query(
    `SELECT h.id, h.name, h.total_beds, h.available_beds, h.total_icu_beds, h.available_icu_beds
       FROM hospitals h
      WHERE (SELECT COUNT(*) FROM hospital_capacity_history c WHERE c.hospital_id = h.id) <= 1`
  );
  for (const h of rows) {
    const occ = (total, available) => (total > 0 ? ((total - available) / total) * 100 : 0);
    const beds = syntheticOccupancyPath(h.name, occ(h.total_beds, h.available_beds), BACKFILL_HOURS, "beds");
    const icu = syntheticOccupancyPath(h.name, occ(h.total_icu_beds, h.available_icu_beds), BACKFILL_HOURS, "icu");
    const available = (total, pct) => Math.min(total, Math.max(0, Math.round(total * (1 - pct / 100))));
    const values = [];
    const params = [];
    beds.forEach((b, i) => {
      const n = params.length;
      values.push(`($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}, $${n + 6}, 'backfill')`);
      params.push(
        h.id,
        new Date(nowMs - b.hoursAgo * 3600 * 1000),
        h.total_beds,
        available(h.total_beds, b.pct),
        h.total_icu_beds,
        available(h.total_icu_beds, icu[i].pct)
      );
    });
    await pool.query(
      `INSERT INTO hospital_capacity_history
         (hospital_id, recorded_at, total_beds, available_beds, total_icu_beds, available_icu_beds, source)
       VALUES ${values.join(", ")}`,
      params
    );
  }
  if (rows.length > 0) console.log(`[hospital-service] backfilled ${BACKFILL_HOURS} h of demo capacity history for ${rows.length} hospital(s)`);
}
