import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { newDb } from "pg-mem";
import { randomUUID } from "node:crypto";

process.env.JWT_ACCESS_SECRET = "test-only-hospital-service-secret";

const jwt = (await import("jsonwebtoken")).default;
const { createHospitalRepository } = await import("../src/repositories/hospitalRepository.js");
const { createHospitalService } = await import("../src/services/hospitalService.js");
const { createHospitalRouter } = await import("../src/routes/hospitalRoutes.js");

function makeToken({ id, role, email = "test@example.com" }) {
  return jwt.sign({ sub: id, email, role, type: "access" }, process.env.JWT_ACCESS_SECRET, {
    expiresIn: "15m",
    issuer: "sentinelcloud-auth-service",
  });
}

/**
 * Builds a fresh in-memory Postgres-backed hospital-service Express app.
 * Deliberate simplification vs. the real migration: the CHECK
 * constraints (available <= total, etc.) are omitted from this test
 * schema, since those invariants are independently enforced in
 * services/hospitalService.js (see updateAvailableBeds and friends) —
 * this suite exercises that application-level logic directly rather
 * than relying on the database to catch it, so re-declaring the same
 * constraints at the DB layer here wouldn't add test coverage, only
 * pg-mem compatibility risk.
 */
function buildTestApp() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.registerExtension("pgcrypto", (schema) => {
    schema.registerFunction({ name: "gen_random_uuid", returns: "uuid", implementation: () => randomUUID(), impure: true });
  });
  db.public.none(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

  db.public.none(`
    CREATE TABLE hospitals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(160) NOT NULL,
      address TEXT NOT NULL,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      emergency_contact_name VARCHAR(120) NOT NULL,
      emergency_contact_phone VARCHAR(32) NOT NULL,
      total_beds INTEGER NOT NULL,
      available_beds INTEGER NOT NULL,
      total_icu_beds INTEGER NOT NULL,
      available_icu_beds INTEGER NOT NULL,
      total_ventilators INTEGER NOT NULL,
      available_ventilators INTEGER NOT NULL,
      emergency_status VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
      managed_by_user_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  const hospitalRepository = createHospitalRepository(pool);
  const hospitalService = createHospitalService({ hospitalRepository, publishEvent: null });

  const app = express();
  app.use(express.json());
  app.use("/", createHospitalRouter({ hospitalService, hospitalRepository }));
  app.use((err, req, res, next) => {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: { code: err.code || "ERROR", message: err.message } });
    }
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err.message } });
  });

  return app;
}

const sampleHospital = {
  name: "Integration Test Hospital",
  address: "1 Test Way, Testville",
  latitude: 18.52,
  longitude: 73.85,
  emergencyContactName: "Dr. Test",
  emergencyContactPhone: "+91-20-1234-5678",
  totalBeds: 100,
  availableBeds: 40,
  totalIcuBeds: 10,
  availableIcuBeds: 3,
  totalVentilators: 5,
  availableVentilators: 2,
};

describe("Hospital Service HTTP API (in-memory DB)", () => {
  let app;
  const hospitalAdminId = randomUUID();
  const otherHospitalAdminId = randomUUID();
  const citizenId = randomUUID();
  const systemAdminId = randomUUID();

  const hospitalAdminToken = makeToken({ id: hospitalAdminId, role: "HOSPITAL_ADMIN" });
  const otherHospitalAdminToken = makeToken({ id: otherHospitalAdminId, role: "HOSPITAL_ADMIN" });
  const citizenToken = makeToken({ id: citizenId, role: "CITIZEN" });
  const systemAdminToken = makeToken({ id: systemAdminId, role: "SYSTEM_ADMIN" });

  before(() => {
    app = buildTestApp();
  });

  test("GET / requires authentication", async () => {
    const res = await request(app).get("/");
    assert.equal(res.status, 401);
  });

  test("POST / rejects a CITIZEN (wrong role)", async () => {
    const res = await request(app).post("/").set("Authorization", `Bearer ${citizenToken}`).send(sampleHospital);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "FORBIDDEN");
  });

  test("POST / rejects an invalid payload with 400", async () => {
    const res = await request(app)
      .post("/")
      .set("Authorization", `Bearer ${hospitalAdminToken}`)
      .send({ ...sampleHospital, availableBeds: 999 }); // exceeds totalBeds
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "VALIDATION_ERROR");
  });

  let createdHospitalId;

  test("POST / creates a hospital as HOSPITAL_ADMIN, owned by that admin", async () => {
    const res = await request(app)
      .post("/")
      .set("Authorization", `Bearer ${hospitalAdminToken}`)
      .send(sampleHospital);
    assert.equal(res.status, 201);
    assert.equal(res.body.hospital.name, sampleHospital.name);
    assert.equal(res.body.hospital.managedByUserId, hospitalAdminId);
    assert.equal(res.body.hospital.capacity.beds, 60); // 100 total, 40 available -> 60% occupied
    assert.deepEqual(res.body.hospital.alerts, []); // healthy hospital, no alerts
    createdHospitalId = res.body.hospital.id;
  });

  test("GET /:id is readable by any authenticated role (e.g. CITIZEN)", async () => {
    const res = await request(app).get(`/${createdHospitalId}`).set("Authorization", `Bearer ${citizenToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.hospital.id, createdHospitalId);
  });

  test("GET /:id returns 404 for an unknown id", async () => {
    const res = await request(app).get(`/${randomUUID()}`).set("Authorization", `Bearer ${citizenToken}`);
    assert.equal(res.status, 404);
  });

  test("GET / lists hospitals with pagination metadata", async () => {
    const res = await request(app).get("/?page=1&limit=10").set("Authorization", `Bearer ${citizenToken}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.hospitals));
    assert.equal(res.body.pagination.page, 1);
    assert.ok(res.body.pagination.total >= 1);
  });

  test("a different HOSPITAL_ADMIN cannot update a hospital they don't manage", async () => {
    const res = await request(app)
      .patch(`/${createdHospitalId}/beds`)
      .set("Authorization", `Bearer ${otherHospitalAdminToken}`)
      .send({ availableBeds: 10 });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "FORBIDDEN");
  });

  test("the owning HOSPITAL_ADMIN can update available beds", async () => {
    const res = await request(app)
      .patch(`/${createdHospitalId}/beds`)
      .set("Authorization", `Bearer ${hospitalAdminToken}`)
      .send({ availableBeds: 5 });
    assert.equal(res.status, 200);
    assert.equal(res.body.hospital.availableBeds, 5);
    assert.ok(res.body.hospital.alerts.some((a) => a.type === "LOW_BED_AVAILABILITY" && a.severity === "CRITICAL"));
  });

  test("SYSTEM_ADMIN can update any hospital regardless of ownership", async () => {
    const res = await request(app)
      .patch(`/${createdHospitalId}/icu`)
      .set("Authorization", `Bearer ${systemAdminToken}`)
      .send({ availableIcuBeds: 0 });
    assert.equal(res.status, 200);
    assert.equal(res.body.hospital.availableIcuBeds, 0);
    assert.ok(res.body.hospital.alerts.some((a) => a.type === "NO_ICU_AVAILABLE"));
  });

  test("updating availableBeds beyond totalBeds is rejected with 409", async () => {
    const res = await request(app)
      .patch(`/${createdHospitalId}/beds`)
      .set("Authorization", `Bearer ${hospitalAdminToken}`)
      .send({ availableBeds: 99999 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "CAPACITY_INVARIANT_VIOLATION");
  });

  test("PUT /:id cannot reduce totalBeds below the current availableBeds", async () => {
    const res = await request(app)
      .put(`/${createdHospitalId}`)
      .set("Authorization", `Bearer ${hospitalAdminToken}`)
      .send({ totalBeds: 2 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "CAPACITY_INVARIANT_VIOLATION");
  });

  test("PUT /:id accepts a valid profile update", async () => {
    const res = await request(app)
      .put(`/${createdHospitalId}`)
      .set("Authorization", `Bearer ${hospitalAdminToken}`)
      .send({ name: "Renamed Integration Test Hospital" });
    assert.equal(res.status, 200);
    assert.equal(res.body.hospital.name, "Renamed Integration Test Hospital");
  });

  test("POST /:id/overload marks a hospital overloaded", async () => {
    const res = await request(app)
      .post(`/${createdHospitalId}/overload`)
      .set("Authorization", `Bearer ${hospitalAdminToken}`)
      .send({ overloaded: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.hospital.emergencyStatus, "OVERLOADED");
    assert.ok(res.body.hospital.alerts.some((a) => a.type === "OVERLOADED"));
  });

  test("GET /alerts includes the now-overloaded hospital, CRITICAL sorted first", async () => {
    const res = await request(app).get("/alerts").set("Authorization", `Bearer ${citizenToken}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.alerts.some((a) => a.hospitalId === createdHospitalId && a.type === "OVERLOADED"));
    const severities = res.body.alerts.map((a) => a.severity);
    const firstWarningIndex = severities.indexOf("WARNING");
    const lastCriticalIndex = severities.lastIndexOf("CRITICAL");
    if (firstWarningIndex !== -1 && lastCriticalIndex !== -1) {
      assert.ok(lastCriticalIndex < firstWarningIndex, "CRITICAL alerts should sort before WARNING alerts");
    }
  });

  test("POST /:id/overload can clear the overloaded flag", async () => {
    const res = await request(app)
      .post(`/${createdHospitalId}/overload`)
      .set("Authorization", `Bearer ${hospitalAdminToken}`)
      .send({ overloaded: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.hospital.emergencyStatus, "NORMAL");
  });

  test("GET /icu-available excludes hospitals with zero available ICU beds", async () => {
    const res = await request(app).get("/icu-available").set("Authorization", `Bearer ${citizenToken}`);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hospitals.some((h) => h.id === createdHospitalId));
  });

  test("GET /near returns hospitals within radius, with a distanceKm field", async () => {
    const res = await request(app)
      .get("/near?lat=18.52&lng=73.85&radiusKm=50")
      .set("Authorization", `Bearer ${citizenToken}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.hospitals.length >= 1);
    assert.ok(typeof res.body.hospitals[0].distanceKm === "number");
  });

  test("GET /near excludes hospitals outside the radius", async () => {
    const res = await request(app)
      .get("/near?lat=28.6139&lng=77.2090&radiusKm=10")
      .set("Authorization", `Bearer ${citizenToken}`);
    assert.equal(res.status, 200);
    assert.ok(!res.body.hospitals.some((h) => h.id === createdHospitalId));
  });

  test("GET /stats/summary reflects the current data", async () => {
    const res = await request(app).get("/stats/summary").set("Authorization", `Bearer ${citizenToken}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.summary.totalHospitals >= 1);
    assert.ok(res.body.summary.totalBeds >= 100);
  });
});
