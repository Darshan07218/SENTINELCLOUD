import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.JWT_ACCESS_SECRET = "test-only-gateway-secret-0123456789abcdef";

const jwt = (await import("jsonwebtoken")).default;
const { requireAuth, requireRole } = await import("../src/middleware/auth.js");
const { isPublicPath, WRITE_METHODS, WRITE_ROLES_BY_PREFIX } = await import("../src/routeAccessRules.js");

function makeToken(overrides = {}) {
  return jwt.sign(
    {
      sub: "user-1",
      email: "test@example.com",
      role: "CITIZEN",
      type: "access",
      ...overrides,
    },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: "15m", issuer: "sentinelcloud-auth-service" }
  );
}

function mockReqRes(headers = {}) {
  const req = { headers, method: "GET", path: "/", user: undefined };
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return { req, res };
}

describe("requireAuth", () => {
  test("rejects a request with no Authorization header", () => {
    const { req, res } = mockReqRes();
    let nextCalled = false;
    requireAuth(req, res, () => (nextCalled = true));
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error.code, "UNAUTHENTICATED");
    assert.equal(nextCalled, false);
  });

  test("rejects a malformed Authorization header (missing 'Bearer')", () => {
    const { req, res } = mockReqRes({ authorization: "Token abc123" });
    requireAuth(req, res, () => {});
    assert.equal(res.statusCode, 401);
  });

  test("rejects an invalid/garbage token", () => {
    const { req, res } = mockReqRes({ authorization: "Bearer not-a-real-jwt" });
    requireAuth(req, res, () => {});
    assert.equal(res.statusCode, 401);
  });

  test("rejects a token signed with the wrong secret", () => {
    const forged = jwt.sign({ sub: "x", role: "SYSTEM_ADMIN", type: "access" }, "wrong-secret", {
      expiresIn: "15m",
    });
    const { req, res } = mockReqRes({ authorization: `Bearer ${forged}` });
    requireAuth(req, res, () => {});
    assert.equal(res.statusCode, 401);
  });

  test("rejects an expired token", () => {
    const expired = jwt.sign(
      { sub: "x", role: "CITIZEN", type: "access" },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: -10, issuer: "sentinelcloud-auth-service" }
    );
    const { req, res } = mockReqRes({ authorization: `Bearer ${expired}` });
    requireAuth(req, res, () => {});
    assert.equal(res.statusCode, 401);
  });

  test("rejects a token signed with another algorithm (alg pinned to HS256)", () => {
    const hs512 = jwt.sign({ sub: "x", role: "SYSTEM_ADMIN", type: "access" }, process.env.JWT_ACCESS_SECRET, {
      expiresIn: "15m",
      issuer: "sentinelcloud-auth-service",
      algorithm: "HS512",
    });
    const { req, res } = mockReqRes({ authorization: `Bearer ${hs512}` });
    requireAuth(req, res, () => {});
    assert.equal(res.statusCode, 401);
  });

  test("accepts a valid token and attaches req.user", () => {
    const token = makeToken({ role: "EMERGENCY_OPERATOR" });
    const { req, res } = mockReqRes({ authorization: `Bearer ${token}` });
    let nextCalled = false;
    requireAuth(req, res, () => (nextCalled = true));
    assert.equal(nextCalled, true);
    assert.equal(req.user.role, "EMERGENCY_OPERATOR");
    assert.equal(req.user.email, "test@example.com");
  });
});

describe("requireRole", () => {
  test("403s when the authenticated user's role is not in the allowed list", () => {
    const { req, res } = mockReqRes();
    req.user = { id: "1", role: "CITIZEN" };
    requireRole("EMERGENCY_OPERATOR", "SYSTEM_ADMIN")(req, res, () => {});
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error.code, "FORBIDDEN");
  });

  test("401s if called without req.user set (auth not run first)", () => {
    const { req, res } = mockReqRes();
    requireRole("SYSTEM_ADMIN")(req, res, () => {});
    assert.equal(res.statusCode, 401);
  });

  test("passes through when the role is allowed", () => {
    const { req, res } = mockReqRes();
    req.user = { id: "1", role: "SYSTEM_ADMIN" };
    let nextCalled = false;
    requireRole("EMERGENCY_OPERATOR", "SYSTEM_ADMIN")(req, res, () => (nextCalled = true));
    assert.equal(nextCalled, true);
  });
});

describe("routeAccessRules", () => {
  // Phase 12: paths are relative to /api/v1 and already normalised by security/pathGuard.js.
  test("isPublicPath matches login/register/refresh/logout exactly", () => {
    assert.equal(isPublicPath("/auth/login"), true);
    assert.equal(isPublicPath("/auth/register"), true);
    assert.equal(isPublicPath("/auth/refresh"), true);
    assert.equal(isPublicPath("/auth/logout"), true, "logout works with only the refresh cookie");
    assert.equal(isPublicPath("/auth/docs"), true);
    assert.equal(isPublicPath("/auth/docs/swagger-ui.css"), true, "subpaths of /docs are public too");
  });

  test("isPublicPath rejects protected auth paths", () => {
    assert.equal(isPublicPath("/auth/me"), false);
    assert.equal(isPublicPath("/auth/users"), false);
  });

  test("isPublicPath rejects domain service paths", () => {
    assert.equal(isPublicPath("/hospitals"), false);
    assert.equal(isPublicPath("/disasters/123"), false);
  });

  test("write roles are configured for every domain prefix", () => {
    for (const prefix of ["hospitals", "ambulances", "blood-banks", "power", "disasters"]) {
      assert.ok(Array.isArray(WRITE_ROLES_BY_PREFIX[prefix]), `${prefix} should have write roles configured`);
      assert.ok(WRITE_ROLES_BY_PREFIX[prefix].includes("SYSTEM_ADMIN"), `${prefix} should always allow SYSTEM_ADMIN`);
    }
  });

  test("WRITE_METHODS includes mutating verbs and excludes GET/HEAD/OPTIONS", () => {
    assert.equal(WRITE_METHODS.has("POST"), true);
    assert.equal(WRITE_METHODS.has("PUT"), true);
    assert.equal(WRITE_METHODS.has("PATCH"), true);
    assert.equal(WRITE_METHODS.has("DELETE"), true);
    assert.equal(WRITE_METHODS.has("GET"), false);
  });
});
