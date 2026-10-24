/**
 * Realistic demo data, idempotent on every startup. Coordinates spread
 * around the same Pune, India area as hospital-service's seed data so
 * cross-service demos (e.g. "nearest ambulance to this hospital")
 * produce sensible distances rather than ambulances scattered on
 * another continent.
 */
const SAMPLE_AMBULANCES = [
  { vehicleNumber: "MH12-AB-1001", latitude: 18.5236, longitude: 73.8737, driverName: "Rakesh Pawar", driverPhone: "+91-98220-10001", equipmentLevel: "ADVANCED" },
  { vehicleNumber: "MH12-AB-1002", latitude: 18.5308, longitude: 73.8794, driverName: "Sunita More", driverPhone: "+91-98220-10002", equipmentLevel: "CRITICAL_CARE" },
  { vehicleNumber: "MH12-AB-1003", latitude: 18.5279, longitude: 73.8781, driverName: "Ganesh Jadhav", driverPhone: "+91-98220-10003", equipmentLevel: "BASIC" },
  { vehicleNumber: "MH12-AB-1004", latitude: 18.5018, longitude: 73.8288, driverName: "Priyanka Salunkhe", driverPhone: "+91-98220-10004", equipmentLevel: "ADVANCED" },
  { vehicleNumber: "MH12-AB-1005", latitude: 18.6298, longitude: 73.7997, driverName: "Vishal Shinde", driverPhone: "+91-98220-10005", equipmentLevel: "BASIC" },
  { vehicleNumber: "MH12-AB-1006", latitude: 18.4901, longitude: 73.9003, driverName: "Neha Kadam", driverPhone: "+91-98220-10006", equipmentLevel: "CRITICAL_CARE" },
  { vehicleNumber: "MH12-AB-1007", latitude: 18.5089, longitude: 73.9260, driverName: "Amit Gaikwad", driverPhone: "+91-98220-10007", equipmentLevel: "ADVANCED" },
  { vehicleNumber: "MH12-AB-1008", latitude: 18.5030, longitude: 73.8262, driverName: "Snehal Bhosale", driverPhone: "+91-98220-10008", equipmentLevel: "BASIC" },
  { vehicleNumber: "MH12-AB-1009", latitude: 18.5150, longitude: 73.8450, driverName: "Omkar Deshpande", driverPhone: "+91-98220-10009", equipmentLevel: "ADVANCED", status: "OUT_OF_SERVICE" },
  { vehicleNumber: "MH12-AB-1010", latitude: 18.5400, longitude: 73.8600, driverName: "Kiran Chavan", driverPhone: "+91-98220-10010", equipmentLevel: "BASIC", status: "AT_HOSPITAL" },
];

export async function seedSampleAmbulances(pool) {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM ambulances");
  if (rows[0].count > 0) {
    console.log("[ambulance-service] ambulances table already has data — skipping seed");
    return;
  }

  for (const a of SAMPLE_AMBULANCES) {
    await pool.query(
      `INSERT INTO ambulances (vehicle_number, latitude, longitude, driver_name, driver_phone, equipment_level, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [a.vehicleNumber, a.latitude, a.longitude, a.driverName, a.driverPhone, a.equipmentLevel, a.status || "AVAILABLE"]
    );
  }
  console.log(`[ambulance-service] seeded ${SAMPLE_AMBULANCES.length} sample ambulances`);
}

/**
 * One seeded emergency, left ACTIVE (unassigned) on purpose — rather
 * than auto-dispatching during seeding — so a fresh `docker compose
 * up` has something visible under "track active emergencies" (feature
 * 9) immediately, while leaving the actual dispatch workflow for the
 * demoer to trigger and observe (see docs/PHASE-4-AMBULANCE.md).
 *
 * created_by_user_id has no FK (auth_db and ambulance_db are separate
 * databases — see the identical rationale on hospitals.
 * managed_by_user_id in hospital-service's migration), so a fixed,
 * clearly-fake placeholder UUID is fine here — this seed doesn't
 * depend on any specific real user existing in auth-service.
 */
const SEED_EMERGENCY_CREATOR_ID = "00000000-0000-0000-0000-000000000000";

export async function seedSampleEmergency(pool) {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM emergencies");
  if (rows[0].count > 0) {
    console.log("[ambulance-service] emergencies table already has data — skipping seed");
    return;
  }

  await pool.query(
    `INSERT INTO emergencies (description, latitude, longitude, severity, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5)`,
    ["Multi-vehicle collision reported near Karve Road", 18.505, 73.828, "HIGH", SEED_EMERGENCY_CREATOR_ID]
  );
  console.log("[ambulance-service] seeded 1 demo emergency (ACTIVE, unassigned)");
}
