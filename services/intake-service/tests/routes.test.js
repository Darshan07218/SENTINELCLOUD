import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";

process.env.JWT_ACCESS_SECRET = "routes-test-secret-0123456789-abcdefghij";
const jwt = (await import("jsonwebtoken")).default;
const { createIntakeRouter } = await import("../src/routes/intakeRoutes.js");
const { createIntakeService, IntakeError } = await import("../src/services/intakeService.js");
const { createMemoryRepository, createFakeGateway, PUNE, quiet } = await import("./fakes.js");

const token = (role) =>
  jwt.sign({ sub: randomUUID(), email: `${role.toLowerCase()}@example.com`, role, type: "access" }, process.env.JWT_ACCESS_SECRET, {
    expiresIn: "15m",
    issuer: "sentinelcloud-auth-service",
  });
const ADMIN = `Bearer ${token("SYSTEM_ADMIN")}`;
const OPERATOR = `Bearer ${token("EMERGENCY_OPERATOR")}`;
const CITIZEN = `Bearer ${token("CITIZEN")}`;

function buildApp() {
  const intakeService = createIntakeService({
    repository: createMemoryRepository(),
    gateway: createFakeGateway(),
    watch: PUNE,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ features: [], hourly: {} }) }),
    log: quiet,
  });
  const app = express();
  app.use(express.json());
  app.use("/", createIntakeRouter({ intakeService }));
  app.use((err, req, res, next) => {
    if (err instanceof IntakeError) return res.status(err.statusCode).json({ error: { code: err.code, message: err.message } });
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err.message } });
  });
  return app;
}

describe("intake routes", () => {
  let app;
  before(() => {
    app = buildApp();
  });

  test("everything needs a signed-in user", async () => {
    assert.equal((await request(app).get("/overview")).status, 401);
    assert.equal((await request(app).get("/detections")).status, 401);
  });

  test("any role can read the overview and the detections", async () => {
    const o = await request(app).get("/overview").set("Authorization", CITIZEN);
    assert.equal(o.status, 200);
    assert.equal(o.body.sources.length, 2);
    const l = await request(app).get("/detections?status=PENDING").set("Authorization", CITIZEN);
    assert.equal(l.status, 200);
    assert.ok(Array.isArray(l.body.detections));
  });

  test("demo injection is SYSTEM_ADMIN only and validated", async () => {
    assert.equal((await request(app).post("/demo").set("Authorization", OPERATOR).send({ type: "FLOOD", severity: "HIGH" })).status, 403);
    assert.equal((await request(app).post("/demo").set("Authorization", ADMIN).send({ type: "TSUNAMI", severity: "HIGH" })).status, 400);
    assert.equal((await request(app).post("/demo").set("Authorization", ADMIN).send({ type: "FLOOD", severity: "HIGH", extra: 1 })).status, 400);
    const res = await request(app).post("/demo").set("Authorization", ADMIN).send({ type: "FLOOD", severity: "HIGH" });
    assert.equal(res.status, 201);
    assert.equal(res.body.detection.status, "PENDING");
  });

  test("an operator confirms; a citizen can't; a second confirm is 409", async () => {
    const { body } = await request(app).post("/demo").set("Authorization", ADMIN).send({ type: "FIRE", severity: "MEDIUM" });
    const id = body.detection.id;
    assert.equal((await request(app).post(`/detections/${id}/confirm`).set("Authorization", CITIZEN).send({})).status, 403);
    const ok = await request(app).post(`/detections/${id}/confirm`).set("Authorization", OPERATOR).send({ note: "verified by phone" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.detection.status, "CONFIRMED");
    assert.ok(ok.body.detection.disasterId);
    assert.equal((await request(app).post(`/detections/${id}/confirm`).set("Authorization", OPERATOR).send({})).status, 409);
  });

  test("dismiss, 404 for unknown ids, 400 for non-UUIDs and bad query values", async () => {
    const { body } = await request(app).post("/demo").set("Authorization", ADMIN).send({ type: "LANDSLIDE", severity: "LOW" });
    const res = await request(app).post(`/detections/${body.detection.id}/dismiss`).set("Authorization", OPERATOR).send({ note: "false alarm" });
    assert.equal(res.body.detection.status, "DISMISSED");
    assert.equal((await request(app).get(`/detections/${randomUUID()}`).set("Authorization", CITIZEN)).status, 404);
    assert.equal((await request(app).post(`/detections/${randomUUID()}/confirm`).set("Authorization", OPERATOR).send({})).status, 404);
    assert.equal((await request(app).get(`/detections/not-a-uuid`).set("Authorization", CITIZEN)).status, 400);
    assert.equal((await request(app).get(`/detections?status=MAYBE`).set("Authorization", CITIZEN)).status, 400);
  });

  test("poll now is for operators", async () => {
    assert.equal((await request(app).post("/poll").set("Authorization", CITIZEN)).status, 403);
    const res = await request(app).post("/poll").set("Authorization", OPERATOR);
    assert.equal(res.status, 200);
    assert.equal(res.body.newDetections, 0);
  });
});
