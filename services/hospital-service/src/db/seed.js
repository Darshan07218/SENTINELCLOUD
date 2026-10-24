/**
 * Realistic demo data so the service is immediately useful after
 * `docker compose up` — a hospital dashboard with zero hospitals in it
 * doesn't demonstrate much. Idempotent: re-running on every startup is
 * safe because it only inserts when the table is empty.
 *
 * Coordinates are real Pune, India locations (matching this project's
 * dev context) spread widely enough to meaningfully exercise the
 * GET /hospitals/near radius search.
 */
const SAMPLE_HOSPITALS = [
  {
    name: "Sassoon General Hospital",
    address: "Sassoon Rd, Pune, Maharashtra 411001",
    latitude: 18.5236,
    longitude: 73.8737,
    emergencyContactName: "Dr. Anjali Deshmukh",
    emergencyContactPhone: "+91-20-2612-8000",
    totalBeds: 400,
    availableBeds: 62,
    totalIcuBeds: 40,
    availableIcuBeds: 3,
    totalVentilators: 25,
    availableVentilators: 4,
  },
  {
    name: "Ruby Hall Clinic",
    address: "40, Sassoon Rd, Pune, Maharashtra 411001",
    latitude: 18.5308,
    longitude: 73.8794,
    emergencyContactName: "Dr. Vikram Rao",
    emergencyContactPhone: "+91-20-6645-5100",
    totalBeds: 550,
    availableBeds: 210,
    totalIcuBeds: 60,
    availableIcuBeds: 18,
    totalVentilators: 40,
    availableVentilators: 22,
  },
  {
    name: "Jehangir Hospital",
    address: "32, Sassoon Rd, Pune, Maharashtra 411001",
    latitude: 18.5279,
    longitude: 73.8781,
    emergencyContactName: "Dr. Meera Iyer",
    emergencyContactPhone: "+91-20-6681-9999",
    totalBeds: 320,
    availableBeds: 8,
    totalIcuBeds: 30,
    availableIcuBeds: 0,
    totalVentilators: 18,
    availableVentilators: 0,
  },
  {
    name: "Deenanath Mangeshkar Hospital",
    address: "Erandwane, Pune, Maharashtra 411004",
    latitude: 18.5018,
    longitude: 73.8288,
    emergencyContactName: "Dr. Suresh Patil",
    emergencyContactPhone: "+91-20-4015-1000",
    totalBeds: 470,
    availableBeds: 155,
    totalIcuBeds: 55,
    availableIcuBeds: 12,
    totalVentilators: 35,
    availableVentilators: 14,
  },
  {
    name: "Aditya Birla Memorial Hospital",
    address: "Chinchwad, Pune, Maharashtra 411033",
    latitude: 18.6298,
    longitude: 73.7997,
    emergencyContactName: "Dr. Kavita Joshi",
    emergencyContactPhone: "+91-20-3071-6300",
    totalBeds: 260,
    availableBeds: 140,
    totalIcuBeds: 25,
    availableIcuBeds: 9,
    totalVentilators: 15,
    availableVentilators: 8,
  },
  {
    name: "Command Hospital Southern Command",
    address: "Wanowrie, Pune, Maharashtra 411040",
    latitude: 18.4901,
    longitude: 73.9003,
    emergencyContactName: "Col. Dr. Ashok Nair",
    emergencyContactPhone: "+91-20-2669-2000",
    totalBeds: 600,
    availableBeds: 310,
    totalIcuBeds: 70,
    availableIcuBeds: 41,
    totalVentilators: 45,
    availableVentilators: 30,
  },
  {
    name: "Noble Hospital",
    address: "Magarpatta Rd, Hadapsar, Pune, Maharashtra 411013",
    latitude: 18.5089,
    longitude: 73.9260,
    emergencyContactName: "Dr. Priya Kulkarni",
    emergencyContactPhone: "+91-20-6721-8000",
    totalBeds: 200,
    availableBeds: 4,
    totalIcuBeds: 20,
    availableIcuBeds: 1,
    totalVentilators: 12,
    availableVentilators: 1,
  },
  {
    name: "Sahyadri Super Speciality Hospital",
    address: "Karve Rd, Pune, Maharashtra 411004",
    latitude: 18.5030,
    longitude: 73.8262,
    emergencyContactName: "Dr. Rahul Bhosale",
    emergencyContactPhone: "+91-20-6721-2000",
    totalBeds: 180,
    availableBeds: 95,
    totalIcuBeds: 18,
    availableIcuBeds: 7,
    totalVentilators: 10,
    availableVentilators: 6,
  },
];

/**
 * The overloaded-hospital demo needs at least one hospital explicitly
 * flagged OVERLOADED, on top of the ones that are merely
 * algorithmically low on capacity — this is the difference the
 * capacity.js comment describes between computed alerts and an
 * operator's explicit declaration.
 */
const OVERLOADED_HOSPITAL_NAME = "Jehangir Hospital";

export async function seedSampleHospitals(pool) {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM hospitals");
  if (rows[0].count > 0) {
    console.log("[hospital-service] hospitals table already has data — skipping seed");
    return;
  }

  for (const h of SAMPLE_HOSPITALS) {
    await pool.query(
      `INSERT INTO hospitals (
         name, address, latitude, longitude,
         emergency_contact_name, emergency_contact_phone,
         total_beds, available_beds,
         total_icu_beds, available_icu_beds,
         total_ventilators, available_ventilators,
         emergency_status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        h.name,
        h.address,
        h.latitude,
        h.longitude,
        h.emergencyContactName,
        h.emergencyContactPhone,
        h.totalBeds,
        h.availableBeds,
        h.totalIcuBeds,
        h.availableIcuBeds,
        h.totalVentilators,
        h.availableVentilators,
        h.name === OVERLOADED_HOSPITAL_NAME ? "OVERLOADED" : "NORMAL",
      ]
    );
  }

  console.log(`[hospital-service] seeded ${SAMPLE_HOSPITALS.length} sample hospitals`);
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
