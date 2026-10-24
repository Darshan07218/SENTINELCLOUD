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
