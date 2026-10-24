import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { newDb } from "pg-mem";
import { randomUUID } from "node:crypto";

process.env.JWT_ACCESS_SECRET = "test-only-access-secret-do-not-use-in-prod";
process.env.JWT_REFRESH_SECRET = "test-only-refresh-secret-do-not-use-in-prod";
process.env.JWT_ACCESS_EXPIRES_IN = "15m";
process.env.JWT_REFRESH_EXPIRES_IN = "7d";

const { createUserRepository } = await import("../src/repositories/userRepository.js");
const { createRefreshTokenRepository } = await import("../src/repositories/refreshTokenRepository.js");
const { createAuthRouter } = await import("../src/routes/authRoutes.js");

/**
 * Builds a fresh in-memory Postgres-compatible database and a minimal
 * schema equivalent to migrations 0001+0002, then mounts the real auth
 * router on top of it. This exercises the actual route handlers,
 * repositories, and SQL — not mocks of them — without needing Docker
 * or a real Postgres instance, so `npm test` works anywhere Node runs.
 *
 * Deliberate simplification vs. the real migrations: CITEXT (used in
 * production for case-insensitive email uniqueness at the DB layer) is
 * swapped for plain TEXT here, since pg-mem doesn't implement the
 * citext extension. This is safe for these tests because the Zod
 * schemas already normalize every email to lowercase before it reaches
 * the repository layer, so case-insensitivity is still exercised
 * end-to-end — just enforced one layer up from where production
 * enforces it twice (defense in depth that a unit test doesn't need to
 * re-prove).
 */
function buildTestApp() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.registerExtension("pgcrypto", (schema) => {
    schema.registerFunction({
      name: "gen_random_uuid",
      returns: "uuid",
      implementation: () => randomUUID(),
      impure: true,
    });
  });
  db.public.none(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

  db.public.none(`
    CREATE TABLE roles (
      id SERIAL PRIMARY KEY, -- SMALLSERIAL in the real migration; pg-mem 2.9 leaves SMALLSERIAL ids NULL
      name VARCHAR(32) NOT NULL UNIQUE,
      description TEXT NOT NULL
    );
    INSERT INTO roles (name, description) VALUES
      ('CITIZEN', 'x'), ('EMERGENCY_OPERATOR', 'x'), ('HOSPITAL_ADMIN', 'x'),
      ('INFRASTRUCTURE_ADMIN', 'x'), ('SYSTEM_ADMIN', 'x');

    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name VARCHAR(120) NOT NULL,
      role_id SMALLINT NOT NULL REFERENCES roles(id),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE refresh_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      replaced_by_hash TEXT,
      user_agent TEXT,
      ip_address TEXT
    );
  `);

  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  const app = express();
  app.use(express.json());
  app.use(
    "/",
    createAuthRouter({
      userRepository: createUserRepository(pool),
      refreshTokenRepository: createRefreshTokenRepository(pool),
      audit: (e) => auditLog.push(e),
      cookieOptions: { path: "/api/v1/auth", secure: false },
    })
  );
  app.use((err, req, res, next) => {
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err.message } });
  });

  return { app, pool };
}

const auditLog = [];
// Phase 12: the refresh token travels only in the httpOnly cookie.
function refreshCookieFrom(res) {
  const raw = [].concat(res.headers["set-cookie"] || []).find((c) => c.startsWith("sc_refresh=") && !c.startsWith("sc_refresh=;"));
  return raw ? raw.split(";")[0] : null;
}

describe("Auth Service HTTP flow (in-memory DB)", () => {
  let app;
  let pool;

  before(() => {
    ({ app, pool } = buildTestApp());
  });

  const citizen = {
    email: "citizen@example.com",
    password: "Str0ngPassword",
    fullName: "Casey Citizen",
    // Phase 12: ignored — sign-up always creates a CITIZEN.
    role: "SYSTEM_ADMIN",
  };

  test("POST /register creates a user and never returns the password", async () => {
    const res = await request(app).post("/register").send(citizen);
    assert.equal(res.status, 201);
    assert.equal(res.body.user.email, citizen.email);
    assert.equal(res.body.user.password, undefined);
    assert.equal(res.body.user.passwordHash, undefined);
    assert.equal(res.body.user.role, "CITIZEN", "a role sent at sign-up is ignored");
  });

  test("POST /register rejects a duplicate email with 409", async () => {
    const res = await request(app).post("/register").send(citizen);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "EMAIL_ALREADY_REGISTERED");
  });

  test("POST /register rejects an invalid payload with 400", async () => {
    const res = await request(app)
      .post("/register")
      .send({ email: "not-an-email", password: "short", fullName: "" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "VALIDATION_ERROR");
  });

  test("POST /login rejects wrong password with 401", async () => {
    const res = await request(app).post("/login").send({ email: citizen.email, password: "WrongPassword1" });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "INVALID_CREDENTIALS");
  });

  test("POST /login rejects an unknown email with the same 401 (no enumeration)", async () => {
    const res = await request(app).post("/login").send({ email: "nobody@example.com", password: "whatever123" });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "INVALID_CREDENTIALS");
  });

  test("POST /login returns an access token in the body and the refresh token ONLY as an httpOnly cookie", async () => {
    const res = await request(app).post("/login").send({ email: citizen.email, password: citizen.password });
    assert.equal(res.status, 200);
    assert.ok(res.body.accessToken);
    assert.equal(res.body.refreshToken, undefined, "never readable by page JavaScript");
    const setCookie = [].concat(res.headers["set-cookie"]).join("\n");
    assert.match(setCookie, /sc_refresh=[^;]+; Path=\/api\/v1\/auth; Max-Age=\d+; HttpOnly; SameSite=Strict/);
    assert.equal(res.body.user.role, "CITIZEN");
    assert.ok(auditLog.some((e) => e.action === "auth.login" && e.outcome === "success"));
    assert.ok(auditLog.some((e) => e.action === "auth.login" && e.outcome === "failure" && e.details.reason === "unknown email"));
  });

  test("GET /me requires a Bearer token", async () => {
    const res = await request(app).get("/me");
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHENTICATED");
  });

  test("GET /me succeeds with a valid access token", async () => {
    const login = await request(app).post("/login").send({ email: citizen.email, password: citizen.password });
    const res = await request(app).get("/me").set("Authorization", `Bearer ${login.body.accessToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, citizen.email);
  });

  test("GET /me rejects a malformed Authorization header", async () => {
    const res = await request(app).get("/me").set("Authorization", "NotBearer sometoken");
    assert.equal(res.status, 401);
  });

  test("full refresh + logout lifecycle with the cookie: rotate, refuse the old one, logout revokes the new one", async () => {
    const login = await request(app).post("/login").send({ email: citizen.email, password: citizen.password });
    const original = refreshCookieFrom(login);
    assert.ok(original);

    const refreshed = await request(app).post("/refresh").set("Cookie", original).send({});
    assert.equal(refreshed.status, 200);
    assert.ok(refreshed.body.accessToken);
    const rotated = refreshCookieFrom(refreshed);
    assert.ok(rotated);
    assert.notEqual(rotated, original, "refresh token must rotate");

    // Seconds later, the old token is answered as a benign race (two tabs).
    const race = await request(app).post("/refresh").set("Cookie", original).send({});
    assert.equal(race.status, 401);
    assert.equal(race.body.error.code, "REFRESH_TOKEN_ROTATED");

    // Logout needs no access token: the refresh cookie proves the session.
    const logoutRes = await request(app).post("/logout").set("Cookie", rotated).send({});
    assert.equal(logoutRes.status, 204);
    assert.match([].concat(logoutRes.headers["set-cookie"]).join(), /sc_refresh=; .*Max-Age=0/);

    const useAfterLogout = await request(app).post("/refresh").set("Cookie", rotated).send({});
    assert.equal(useAfterLogout.status, 401);
  });

  test("reusing a rotated refresh token later ends EVERY session of the account (stolen-token detection)", async () => {
    const a = refreshCookieFrom(await request(app).post("/login").send({ email: citizen.email, password: citizen.password }));
    const b = refreshCookieFrom(await request(app).post("/login").send({ email: citizen.email, password: citizen.password }));
    const aNext = refreshCookieFrom(await request(app).post("/refresh").set("Cookie", a).send({}));
    // Pretend the rotation happened minutes ago (outside the two-tab grace period).
    await pool.query(`UPDATE refresh_tokens SET revoked_at = now() - interval '5 minutes' WHERE replaced_by_hash IS NOT NULL`);

    const replay = await request(app).post("/refresh").set("Cookie", a).send({});
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, "INVALID_REFRESH_TOKEN");
    assert.ok(auditLog.some((e) => e.action === "auth.refresh_reuse" && e.outcome === "denied"));
    // Both the attacker's chain and the user's other session are gone.
    assert.equal((await request(app).post("/refresh").set("Cookie", aNext).send({})).status, 401);
    assert.equal((await request(app).post("/refresh").set("Cookie", b).send({})).status, 401);
  });

  test("non-browser clients may still send the refresh token in the body", async () => {
    const login = await request(app).post("/login").send({ email: citizen.email, password: citizen.password });
    const token = refreshCookieFrom(login).slice("sc_refresh=".length);
    const res = await request(app).post("/refresh").send({ refreshToken: token });
    assert.equal(res.status, 200);
  });

  test("user management: only SYSTEM_ADMIN may list users or grant roles; a role change ends the user's sessions", async () => {
    const { hashPassword } = await import("../src/utils/password.js");
    await pool.query(
      `INSERT INTO users (email, password_hash, full_name, role_id) SELECT $1, $2, 'Ada Admin', id FROM roles WHERE name = 'SYSTEM_ADMIN'`,
      ["ada@example.com", await hashPassword("Adm1nPassword")]
    );
    const admin = await request(app).post("/login").send({ email: "ada@example.com", password: "Adm1nPassword" });
    const citizenLogin = await request(app).post("/login").send({ email: citizen.email, password: citizen.password });
    const citizenCookie = refreshCookieFrom(citizenLogin);
    const asAdmin = (r) => r.set("Authorization", `Bearer ${admin.body.accessToken}`);
    const asCitizen = (r) => r.set("Authorization", `Bearer ${citizenLogin.body.accessToken}`);

    assert.equal((await asCitizen(request(app).get("/users"))).status, 403);
    const list = await asAdmin(request(app).get("/users?limit=10"));
    assert.equal(list.status, 200);
    const target = list.body.users.find((u) => u.email === citizen.email);
    assert.equal(target.role, "CITIZEN");

    assert.equal((await asCitizen(request(app).patch(`/users/${target.id}`).send({ role: "SYSTEM_ADMIN" }))).status, 403, "no self-promotion");
    assert.equal((await asAdmin(request(app).patch("/users/not-a-uuid").send({ role: "HOSPITAL_ADMIN" }))).status, 400);

    const promoted = await asAdmin(request(app).patch(`/users/${target.id}`).send({ role: "HOSPITAL_ADMIN" }));
    assert.equal(promoted.status, 200);
    assert.equal(promoted.body.user.role, "HOSPITAL_ADMIN");
    assert.equal((await request(app).post("/refresh").set("Cookie", citizenCookie).send({})).status, 401, "old session ended");
    assert.ok(auditLog.some((e) => e.action === "user.update" && e.details.roleAfter === "HOSPITAL_ADMIN"));

    const self = list.body.users.find((u) => u.email === "ada@example.com");
    const selfDemote = await asAdmin(request(app).patch(`/users/${self.id}`).send({ role: "CITIZEN" }));
    assert.equal(selfDemote.status, 400);
    assert.equal(selfDemote.body.error.code, "SELF_LOCKOUT");
  });
});
