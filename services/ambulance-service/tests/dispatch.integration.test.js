import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { newDb } from "pg-mem";
import { randomUUID } from "node:crypto";

process.env.JWT_ACCESS_SECRET = "test-only-ambulance-service-secret";

const jwt = (await import("jsonwebtoken")).default;
const { createAmbulanceRepository } = await import("../src/repositories/ambulanceRepository.js");
const { createEmergencyRepository } = await import("../src/repositories/emergencyRepository.js");
const { createAmbulanceService } = await import("../src/services/ambulanceService.js");
const { createDispatchService } = await import("../src/services/dispatchService.js");
const { createEmergencyService } = await import("../src/services/emergencyService.js");
const { createAmbulanceRouter } = await import("../src/routes/ambulanceRoutes.js");
const { createEmergencyRouter } = await import("../src/routes/emergencyRoutes.js");

function makeToken({ id, role, email = "test@example.com" }) {
  return jwt.sign({ sub: id, email, role, type: "access" }, process.env.JWT_ACCESS_SECRET, {
    expiresIn: "15m",
    issuer: "sentinelcloud-auth-service",
  });
}

/**
 * Builds a fresh in-memory Postgres-backed ambulance-service Express
 * app, mirroring the real service's wiring in src/index.js. As in
 * hospital-service's integration tests, CHECK/FK constraints are
 * omitted from this test schema since the invariants they'd enforce
 * (status legality, etc.) are independently covered by
 * statusMachine.test.js and exercised end-to-end here through the
 * real service functions regardless.
 */
function buildTestApp() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.registerExtension("pgcrypto", (schema) => {
    schema.registerFunction({ name: "gen_random_uuid", returns: "uuid", implementation: () => randomUUID(), impure: true });
  });
  db.public.none(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

  db.public.none(`
    CREATE TABLE ambulances (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      vehicle_number VARCHAR(32) NOT NULL UNIQUE,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE',
      driver_name VARCHAR(120) NOT NULL,
      driver_phone VARCHAR(32) NOT NULL,
      equipment_level VARCHAR(20) NOT NULL DEFAULT 'BASIC',
      assigned_hospital_id UUID,
      assigned_emergency_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE emergencies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      description TEXT NOT NULL,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      severity VARCHAR(16) NOT NULL DEFAULT 'MEDIUM',
      status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
      assigned_ambulance_id UUID,
      assigned_hospital_id UUID,
      created_by_user_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ
    );
  `);

  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  const ambulanceRepository = createAmbulanceRepository(pool);
  const emergencyRepository = createEmergencyRepository(pool);
  const ambulanceService = createAmbulanceService({ ambulanceRepository });
  const dispatchService = createDispatchService({ ambulanceRepository, emergencyRepository, publishEvent: null });
  const emergencyService = createEmergencyService({ emergencyRepository, dispatchService });

  const app = express();
  app.use(express.json());
  app.use("/emergencies", createEmergencyRouter({ emergencyService }));
  app.use("/", createAmbulanceRouter({ ambulanceService, dispatchService }));
  app.use((err, req, res, next) => {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: { code: err.code || "ERROR", message: err.message } });
    }
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err.message } });
  });

  return app;
}

const operatorId = randomUUID();
const operatorToken = makeToken({ id: operatorId, role: "EMERGENCY_OPERATOR" });
const citizenToken = makeToken({ id: randomUUID(), role: "CITIZEN" });

function ambulancePayload(overrides) {
  return Object.assign(
    {
      vehicleNumber: `MH12-TEST-${Math.floor(Math.random() * 1000000)}`,
      latitude: 18.52,
      longitude: 73.85,
      driverName: "Test Driver",
      driverPhone: "+91-98765-43210",
      equipmentLevel: "ADVANCED",
    },
    overrides || {}
  );
}

describe("Ambulance Service HTTP API (in-memory DB)", () => {
  let app;

  before(() => {
    app = buildTestApp();
  });

  test("GET / requires authentication", async () => {
    const res = await request(app).get("/");
    assert.equal(res.status, 401);
  });

  test("POST / rejects a CITIZEN (wrong role)", async () => {
    const res = await request(app).post("/").set("Authorization", `Bearer ${citizenToken}`).send(ambulancePayload());
    assert.equal(res.status, 403);
  });

  let ambulanceId;

  test("POST / registers a new ambulance", async () => {
    const res = await request(app)
      .post("/")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send(ambulancePayload({ vehicleNumber: "MH12-DISPATCH-001", latitude: 18.5, longitude: 73.84 }));
    assert.equal(res.status, 201);
    assert.equal(res.body.ambulance.status, "AVAILABLE");
    ambulanceId = res.body.ambulance.id;
  });

  test("POST / rejects a duplicate vehicle number with 409", async () => {
    const res = await request(app)
      .post("/")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send(ambulancePayload({ vehicleNumber: "MH12-DISPATCH-001" }));
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "VEHICLE_NUMBER_TAKEN");
  });

  test("GET /:id retrieves the ambulance", async () => {
    const res = await request(app).get(`/${ambulanceId}`).set("Authorization", `Bearer ${citizenToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ambulance.id, ambulanceId);
  });

  test("PATCH /:id/location updates location", async () => {
    const res = await request(app)
      .patch(`/${ambulanceId}/location`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ latitude: 18.55, longitude: 73.88 });
    assert.equal(res.status, 200);
    assert.equal(res.body.ambulance.latitude, 18.55);
  });

  test("PATCH /:id/status rejects an illegal transition (AVAILABLE -> AT_HOSPITAL)", async () => {
    const res = await request(app)
      .patch(`/${ambulanceId}/status`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ status: "AT_HOSPITAL" });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "INVALID_STATUS_TRANSITION");
  });

  test("PATCH /:id/status accepts a legal round trip (AVAILABLE -> OUT_OF_SERVICE -> AVAILABLE)", async () => {
    const toOos = await request(app)
      .patch(`/${ambulanceId}/status`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ status: "OUT_OF_SERVICE" });
    assert.equal(toOos.status, 200);
    assert.equal(toOos.body.ambulance.status, "OUT_OF_SERVICE");

    const backToAvailable = await request(app)
      .patch(`/${ambulanceId}/status`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ status: "AVAILABLE" });
    assert.equal(backToAvailable.status, 200);
    assert.equal(backToAvailable.body.ambulance.status, "AVAILABLE");
  });

  test("GET /nearest returns the ambulance with distanceKm and etaMinutes", async () => {
    const res = await request(app)
      .get("/nearest?lat=18.55&lng=73.88&radiusKm=20")
      .set("Authorization", `Bearer ${citizenToken}`);
    assert.equal(res.status, 200);
    const found = res.body.ambulances.find((a) => a.id === ambulanceId);
    assert.ok(found, "seeded ambulance should be in range");
    assert.equal(found.distanceKm, 0);
    assert.ok(found.etaMinutes > 0);
  });

  test("POST /emergencies auto-dispatches the nearest available ambulance", async () => {
    const res = await request(app)
      .post("/emergencies")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ description: "Person collapsed near the market", latitude: 18.551, longitude: 73.881, severity: "HIGH" });

    assert.equal(res.status, 201);
    assert.equal(res.body.emergency.status, "ASSIGNED");
    assert.ok(res.body.recommendation, "should have recommended an ambulance");
    assert.equal(res.body.recommendation.ambulanceId, ambulanceId);
    assert.equal(res.body.ambulance.status, "DISPATCHED");
    assert.equal(res.body.ambulance.assignedEmergencyId, res.body.emergency.id);
  });

  test("the dispatched ambulance no longer appears in /nearest", async () => {
    const res = await request(app)
      .get("/nearest?lat=18.55&lng=73.88&radiusKm=20")
      .set("Authorization", `Bearer ${citizenToken}`);
    assert.equal(res.status, 200);
    assert.ok(!res.body.ambulances.some((a) => a.id === ambulanceId));
  });

  let secondEmergencyId;

  test("POST /emergencies with no ambulances in range leaves the emergency ACTIVE and unassigned", async () => {
    const res = await request(app)
      .post("/emergencies")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ description: "Remote area emergency report", latitude: -33.8688, longitude: 151.2093 });

    assert.equal(res.status, 201);
    assert.equal(res.body.emergency.status, "ACTIVE");
    assert.equal(res.body.recommendation, null);
    assert.equal(res.body.ambulance, null);
    secondEmergencyId = res.body.emergency.id;
  });

  test("GET /emergencies/active includes both the assigned and the still-active emergency", async () => {
    const res = await request(app).get("/emergencies/active").set("Authorization", `Bearer ${citizenToken}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.emergencies.some((e) => e.id === secondEmergencyId && e.status === "ACTIVE"));
    assert.ok(res.body.emergencies.some((e) => e.status === "ASSIGNED"));
  });

  test("POST /:id/dispatch rejects dispatching a non-AVAILABLE ambulance", async () => {
    const res = await request(app)
      .post(`/${ambulanceId}/dispatch`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ emergencyId: secondEmergencyId });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "AMBULANCE_NOT_AVAILABLE");
  });

  test("POST /:id/dispatch rejects dispatching to a non-ACTIVE emergency", async () => {
    const fresh = await request(app)
      .post("/")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send(ambulancePayload({ vehicleNumber: "MH12-DISPATCH-002" }));
    const freshId = fresh.body.ambulance.id;

    const alreadyAssignedRes = await request(app)
      .get("/emergencies?status=ASSIGNED")
      .set("Authorization", `Bearer ${operatorToken}`);
    const assignedEmergencyId = alreadyAssignedRes.body.emergencies[0].id;

    const res = await request(app)
      .post(`/${freshId}/dispatch`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ emergencyId: assignedEmergencyId });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "EMERGENCY_NOT_ACTIVE");
  });

  test("POST /:id/dispatch succeeds for a valid AVAILABLE ambulance + ACTIVE emergency pair", async () => {
    const fresh = await request(app)
      .post("/")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send(ambulancePayload({ vehicleNumber: "MH12-DISPATCH-003", latitude: -33.87, longitude: 151.2 }));
    const freshId = fresh.body.ambulance.id;

    const res = await request(app)
      .post(`/${freshId}/dispatch`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ emergencyId: secondEmergencyId });
    assert.equal(res.status, 200);
    assert.equal(res.body.ambulance.status, "DISPATCHED");
    assert.equal(res.body.emergency.status, "ASSIGNED");
  });

  test("PATCH /:id/assign-hospital assigns a hospital id", async () => {
    const hospitalId = randomUUID();
    const res = await request(app)
      .patch(`/${ambulanceId}/assign-hospital`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ hospitalId });
    assert.equal(res.status, 200);
    assert.equal(res.body.ambulance.assignedHospitalId, hospitalId);
  });

  test("POST /emergencies/:id/complete rejects completing an emergency with no assigned ambulance", async () => {
    const active = await request(app)
      .post("/emergencies")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ description: "Another remote report, still unassigned", latitude: -33.9, longitude: 151.3 });
    const res = await request(app)
      .post(`/emergencies/${active.body.emergency.id}/complete`)
      .set("Authorization", `Bearer ${operatorToken}`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "EMERGENCY_NOT_ASSIGNED");
  });

  test("POST /emergencies/:id/complete resolves the emergency and frees the ambulance", async () => {
    const emergencyRes = await request(app)
      .get(`/emergencies/${secondEmergencyId}`)
      .set("Authorization", `Bearer ${operatorToken}`);
    const ambulanceIdToFree = emergencyRes.body.emergency.assignedAmbulanceId;

    const res = await request(app)
      .post(`/emergencies/${secondEmergencyId}/complete`)
      .set("Authorization", `Bearer ${operatorToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.emergency.status, "RESOLVED");
    assert.ok(res.body.emergency.resolvedAt);
    assert.equal(res.body.ambulance.id, ambulanceIdToFree);
    assert.equal(res.body.ambulance.status, "AVAILABLE");
    assert.equal(res.body.ambulance.assignedEmergencyId, null);
  });

  test("POST /emergencies/:id/complete rejects completing an already-resolved emergency", async () => {
    const res = await request(app)
      .post(`/emergencies/${secondEmergencyId}/complete`)
      .set("Authorization", `Bearer ${operatorToken}`);
    assert.equal(res.status, 409);
  });

  test("POST /emergencies/:id/cancel cancels a still-active emergency", async () => {
    const created = await request(app)
      .post("/emergencies")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ description: "Reported in error, cancel me", latitude: 0, longitude: 0 });
    const res = await request(app)
      .post(`/emergencies/${created.body.emergency.id}/cancel`)
      .set("Authorization", `Bearer ${operatorToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.emergency.status, "CANCELLED");
  });

  test("GET /stats/summary reflects fleet status counts", async () => {
    const res = await request(app).get("/stats/summary").set("Authorization", `Bearer ${citizenToken}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.summary.totalAmbulances >= 3);
  });
});
