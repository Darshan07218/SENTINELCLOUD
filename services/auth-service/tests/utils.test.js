import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Test-only secrets — never used outside this process. Set before
// importing utils/jwt.js, since that module throws at import time if
// the secrets are missing (see the rationale in utils/jwt.js itself).
process.env.JWT_ACCESS_SECRET = "test-only-access-secret-do-not-use-in-prod";
process.env.JWT_REFRESH_SECRET = "test-only-refresh-secret-do-not-use-in-prod";
process.env.JWT_ACCESS_EXPIRES_IN = "2s";
process.env.JWT_REFRESH_EXPIRES_IN = "10s";

const { hashPassword, verifyPassword } = await import("../src/utils/password.js");
const {
  signAccessToken,
  verifyAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  getAccessTokenExpirySeconds,
} = await import("../src/utils/jwt.js");

describe("password hashing", () => {
  test("hashes a password and verifies the correct plaintext against it", async () => {
    const hash = await hashPassword("Sup3rSecret!");
    assert.notEqual(hash, "Sup3rSecret!", "hash must never equal the plaintext");
    assert.equal(await verifyPassword("Sup3rSecret!", hash), true);
  });

  test("rejects an incorrect password", async () => {
    const hash = await hashPassword("Sup3rSecret!");
    assert.equal(await verifyPassword("WrongPassword!", hash), false);
  });

  test("two hashes of the same password are different (salted)", async () => {
    const hash1 = await hashPassword("Sup3rSecret!");
    const hash2 = await hashPassword("Sup3rSecret!");
    assert.notEqual(hash1, hash2);
  });
});

describe("JWT access tokens", () => {
  const user = { id: "11111111-1111-1111-1111-111111111111", email: "citizen@example.com", role: "CITIZEN" };

  test("signs and verifies an access token, round-tripping claims", () => {
    const token = signAccessToken(user);
    const payload = verifyAccessToken(token);
    assert.equal(payload.sub, user.id);
    assert.equal(payload.email, user.email);
    assert.equal(payload.role, user.role);
    assert.equal(payload.type, "access");
  });

  test("rejects a token signed with a different secret", async () => {
    const jwt = (await import("jsonwebtoken")).default;
    const forgedToken = jwt.sign({ sub: user.id, email: user.email, role: "SYSTEM_ADMIN", type: "access" }, "wrong-secret");
    assert.throws(() => verifyAccessToken(forgedToken));
  });

  test("expired access tokens fail verification", async () => {
    const token = signAccessToken(user);
    await new Promise((r) => setTimeout(r, 2100)); // JWT_ACCESS_EXPIRES_IN=2s above
    assert.throws(() => verifyAccessToken(token), /jwt expired/i);
  });

  test("getAccessTokenExpirySeconds reflects JWT_ACCESS_EXPIRES_IN", () => {
    assert.equal(getAccessTokenExpirySeconds(), 2);
  });
});

describe("JWT refresh tokens", () => {
  const user = { id: "22222222-2222-2222-2222-222222222222" };

  test("signs and verifies a refresh token", () => {
    const token = signRefreshToken(user, "some-jti");
    const payload = verifyRefreshToken(token);
    assert.equal(payload.sub, user.id);
    assert.equal(payload.jti, "some-jti");
    assert.equal(payload.type, "refresh");
  });

  test("hashToken is deterministic and collision-resistant for different inputs", () => {
    const tokenA = signRefreshToken(user, "jti-a");
    const tokenB = signRefreshToken(user, "jti-b");
    assert.equal(hashToken(tokenA), hashToken(tokenA));
    assert.notEqual(hashToken(tokenA), hashToken(tokenB));
  });

  test("an access token cannot be verified as a refresh token", () => {
    const accessToken = signAccessToken({ id: user.id, email: "a@b.com", role: "CITIZEN" });
    assert.throws(() => verifyRefreshToken(accessToken));
  });
});
