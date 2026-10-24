import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { requireSecret, requireEnv, isPlaceholder, SecretConfigError } from "../secrets.js";
import { createAuditLogger, sanitize } from "../audit.js";
import { verifyAccessToken, bearerToken, TokenError } from "../jwt.js";

describe("requireSecret", () => {
  const good = "f3a1c9e07b5d42a8b6c1d0e9f8a7b6c5d4e3f2a1";
  test("returns a strong secret", () => {
    assert.equal(requireSecret("X", { env: { X: good } }), good);
  });
  test("rejects missing, short and placeholder values", () => {
    assert.throws(() => requireSecret("X", { env: {} }), SecretConfigError);
    assert.throws(() => requireSecret("X", { env: { X: "" } }), /not set/);
    assert.throws(() => requireSecret("X", { env: { X: "short" } }), /too short/);
    for (const v of [
      "change_me_dev_only_access_secret_please_change",
      "dev_only_resilience_chaos_token_change_me",
      "CHANGE_ME_generate_with_scripts_generate_secrets",
    ]) {
      assert.throws(() => requireSecret("X", { env: { X: v } }), /placeholder/, v);
    }
    assert.throws(() => requireSecret("DB", { minLength: 16, env: { DB: "sentinel_dev_password" } }), /placeholder/);
    assert.throws(() => requireSecret("G", { minLength: 16, env: { G: "sentinel_grafana_dev" } }), /placeholder/);
  });
  test("minLength is configurable", () => {
    assert.equal(requireSecret("X", { minLength: 8, env: { X: "k3Jd92Lq" } }), "k3Jd92Lq");
  });
  test("isPlaceholder", () => {
    assert.equal(isPlaceholder("password"), true);
    assert.equal(isPlaceholder("Q9x!pAssw0rd-but-long-and-random"), false);
  });
  test("requireEnv", () => {
    assert.equal(requireEnv("U", { env: { U: "auth_svc" } }), "auth_svc");
    assert.throws(() => requireEnv("U", { env: {} }), /not set/);
  });
});

describe("audit log", () => {
  test("writes one JSON line with actor, ip and resource", () => {
    const lines = [];
    const audit = createAuditLogger({ service: "gateway", write: (l) => lines.push(l), now: () => new Date("2026-10-02T00:00:00Z") });
    audit({ action: "auth.login", outcome: "failure", actor: { id: "u1", role: "CITIZEN", email: "a@b.c" }, ip: "10.0.0.1", requestId: "r1", resource: { type: "user" } });
    assert.equal(lines.length, 1);
    const e = JSON.parse(lines[0]);
    assert.equal(e.log, "audit");
    assert.equal(e.ts, "2026-10-02T00:00:00.000Z");
    assert.equal(e.action, "auth.login");
    assert.equal(e.outcome, "failure");
    assert.deepEqual(e.actor, { id: "u1", role: "CITIZEN", email: "a@b.c" });
    assert.equal(e.ip, "10.0.0.1");
  });
  test("never logs secrets and neutralises control characters", () => {
    const out = sanitize({
      password: "hunter2",
      refreshToken: "abc",
      Authorization: "Bearer x",
      cookie: "sc_refresh=1",
      passwordHash: "$2a$",
      note: "line1\nFAKE AUDIT LINE",
      nested: { apiKey: "k", ok: 1 },
    });
    assert.deepEqual(out, { note: "line1 FAKE AUDIT LINE", nested: { ok: 1 } });
  });
  test("truncates long strings and deep objects", () => {
    assert.ok(sanitize("x".repeat(1000)).length < 310);
    assert.equal(sanitize({ a: { b: { c: { d: { e: 1 } } } } }).a.b.c.d, "[truncated]");
  });
  test("a failing writer never throws", () => {
    const audit = createAuditLogger({ service: "s", write: () => { throw new Error("disk full"); } });
    assert.doesNotThrow(() => audit({ action: "x" }));
  });
});

describe("verifyAccessToken (zero-dependency HS256)", () => {
  const SECRET = "test-secret-0123456789abcdef0123456789";
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const sign = (payload, { alg = "HS256", secret = SECRET } = {}) => {
    const h = b64({ alg, typ: "JWT" });
    const p = b64(payload);
    return `${h}.${p}.${createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
  };
  const now = Date.parse("2026-10-02T00:00:00Z");
  const valid = { sub: "u1", role: "CITIZEN", type: "access", iss: "sentinelcloud-auth-service", exp: now / 1000 + 600 };

  test("accepts a valid token", () => {
    assert.equal(verifyAccessToken(sign(valid), SECRET, { now }).sub, "u1");
  });
  test("rejects alg none, other algs, bad signature, wrong secret", () => {
    const [h, p] = sign(valid).split(".");
    const none = `${b64({ alg: "none" })}.${p}.`;
    assert.throws(() => verifyAccessToken(none, SECRET, { now }), TokenError);
    assert.throws(() => verifyAccessToken(sign(valid, { alg: "HS512" }), SECRET, { now }), /alg/);
    assert.throws(() => verifyAccessToken(`${h}.${p}.AAAA`, SECRET, { now }), /signature/);
    assert.throws(() => verifyAccessToken(sign(valid, { secret: "other-secret-xxxxxxxxxxxxxxxxxxxxxxxx" }), SECRET, { now }), /signature/);
  });
  test("requires exp, iss, type=access and sub", () => {
    const { exp, ...noExp } = valid;
    assert.throws(() => verifyAccessToken(sign(noExp), SECRET, { now }), /expiry/);
    assert.throws(() => verifyAccessToken(sign({ ...valid, exp: now / 1000 - 1 }), SECRET, { now }), /expired/);
    assert.throws(() => verifyAccessToken(sign({ ...valid, iss: "evil" }), SECRET, { now }), /issuer/);
    assert.throws(() => verifyAccessToken(sign({ ...valid, type: "refresh" }), SECRET, { now }), /access/);
    const { type, ...noType } = valid;
    assert.throws(() => verifyAccessToken(sign(noType), SECRET, { now }), /access/);
    const { sub, ...noSub } = valid;
    assert.throws(() => verifyAccessToken(sign(noSub), SECRET, { now }), /subject/);
  });
  test("malformed input", () => {
    for (const t of ["", "a.b", "a.b.c.d", "!!!.###.$$$", null, undefined]) {
      assert.throws(() => verifyAccessToken(t, SECRET, { now }), TokenError);
    }
  });
  test("bearerToken", () => {
    assert.equal(bearerToken("Bearer abc"), "abc");
    assert.equal(bearerToken("bearer abc"), null);
    assert.equal(bearerToken("Basic abc"), null);
    assert.equal(bearerToken(undefined), null);
  });
});
