import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { registerSchema, loginSchema, updateUserSchema, listUsersQuerySchema, SELF_REGISTERABLE_ROLES } from "../src/schemas/authSchemas.js";

describe("registerSchema", () => {
  test("accepts a valid registration payload", () => {
    const result = registerSchema.safeParse({
      email: "Citizen@Example.com",
      password: "Str0ngPassword",
      fullName: "Jamie Rivera",
      role: "CITIZEN",
    });
    assert.equal(result.success, true);
    // email is normalized to lowercase
    assert.equal(result.data.email, "citizen@example.com");
  });

  // Phase 12: sign-up can no longer choose a role. Whatever "role" a client
  // sends is stripped by the schema; auth-service always creates a CITIZEN.
  test("ignores any role sent at sign-up, including privileged ones", () => {
    for (const role of ["SYSTEM_ADMIN", "EMERGENCY_OPERATOR", "HOSPITAL_ADMIN", "INFRASTRUCTURE_ADMIN", "CITIZEN"]) {
      const result = registerSchema.safeParse({ email: "a@example.com", password: "Str0ngPassword", fullName: "Jamie Rivera", role });
      assert.equal(result.success, true, role);
      assert.equal("role" in result.data, false, `${role} must not survive validation`);
    }
  });

  test("rejects passwords longer than bcrypt's 72-byte limit (multi-byte characters count as bytes)", () => {
    const base = { email: "a@example.com", fullName: "Jamie Rivera" };
    assert.equal(registerSchema.safeParse({ ...base, password: "Aa1" + "x".repeat(69) }).success, true, "72 bytes is fine");
    assert.equal(registerSchema.safeParse({ ...base, password: "Aa1" + "x".repeat(70) }).success, false, "73 bytes is not");
    assert.equal(registerSchema.safeParse({ ...base, password: "Aa1" + "é".repeat(35) }).success, false, "73 bytes in 38 characters");
  });

  test("rejects a password without an uppercase letter", () => {
    const result = registerSchema.safeParse({
      email: "a@example.com",
      password: "weakpassword1",
      fullName: "Jamie Rivera",
    });
    assert.equal(result.success, false);
  });

  test("rejects a password shorter than 10 characters", () => {
    const result = registerSchema.safeParse({
      email: "a@example.com",
      password: "Sh0rt",
      fullName: "Jamie Rivera",
    });
    assert.equal(result.success, false);
  });

  test("rejects an invalid email", () => {
    const result = registerSchema.safeParse({
      email: "not-an-email",
      password: "Str0ngPassword",
      fullName: "Jamie Rivera",
    });
    assert.equal(result.success, false);
  });

  test("rejects a missing fullName", () => {
    const result = registerSchema.safeParse({
      email: "a@example.com",
      password: "Str0ngPassword",
    });
    assert.equal(result.success, false);
  });
});

describe("loginSchema", () => {
  test("accepts a valid login payload and lowercases the email", () => {
    const result = loginSchema.safeParse({ email: "User@Example.com", password: "anything" });
    assert.equal(result.success, true);
    assert.equal(result.data.email, "user@example.com");
  });

  test("rejects an empty password", () => {
    const result = loginSchema.safeParse({ email: "a@example.com", password: "" });
    assert.equal(result.success, false);
  });
});

describe("Phase 12: user-management schemas", () => {
  test("only CITIZEN is self-registerable", () => {
    assert.deepEqual(SELF_REGISTERABLE_ROLES, ["CITIZEN"]);
  });
  test("updateUserSchema accepts a known role and/or isActive, nothing else", () => {
    assert.equal(updateUserSchema.safeParse({ role: "HOSPITAL_ADMIN" }).success, true);
    assert.equal(updateUserSchema.safeParse({ isActive: false }).success, true);
    assert.equal(updateUserSchema.safeParse({}).success, false, "empty change");
    assert.equal(updateUserSchema.safeParse({ role: "ROOT" }).success, false, "unknown role");
    assert.equal(updateUserSchema.safeParse({ role: "CITIZEN", email: "x@y.z" }).success, false, "no other fields (strict)");
  });
  test("listUsersQuerySchema bounds page and limit", () => {
    assert.deepEqual(listUsersQuerySchema.parse({}), { page: 1, limit: 25 });
    assert.equal(listUsersQuerySchema.safeParse({ limit: "1000" }).success, false);
    assert.equal(listUsersQuerySchema.safeParse({ page: "0" }).success, false);
  });
});
