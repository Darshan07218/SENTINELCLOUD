import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isValidStatusTransition, getAllowedNextStatuses, AMBULANCE_STATUSES } from "../src/services/statusMachine.js";

describe("isValidStatusTransition — happy path", () => {
  const happyPath = ["AVAILABLE", "DISPATCHED", "EN_ROUTE", "AT_SCENE", "TRANSPORTING", "AT_HOSPITAL", "AVAILABLE"];

  test("every consecutive step of the full happy-path lifecycle is legal", () => {
    for (let i = 0; i < happyPath.length - 1; i++) {
      assert.equal(
        isValidStatusTransition(happyPath[i], happyPath[i + 1]),
        true,
        `${happyPath[i]} -> ${happyPath[i + 1]} should be legal`
      );
    }
  });
});

describe("isValidStatusTransition — illegal jumps", () => {
  test("cannot jump directly from AVAILABLE to AT_HOSPITAL", () => {
    assert.equal(isValidStatusTransition("AVAILABLE", "AT_HOSPITAL"), false);
  });

  test("cannot jump directly from AVAILABLE to TRANSPORTING", () => {
    assert.equal(isValidStatusTransition("AVAILABLE", "TRANSPORTING"), false);
  });

  test("cannot jump directly from EN_ROUTE to TRANSPORTING (must pass through AT_SCENE)", () => {
    assert.equal(isValidStatusTransition("EN_ROUTE", "TRANSPORTING"), false);
  });

  test("a status cannot transition to itself", () => {
    for (const status of AMBULANCE_STATUSES) {
      assert.equal(isValidStatusTransition(status, status), false);
    }
  });
});

describe("isValidStatusTransition — OUT_OF_SERVICE exception path", () => {
  test("every active status can transition to OUT_OF_SERVICE", () => {
    for (const status of AMBULANCE_STATUSES) {
      if (status === "OUT_OF_SERVICE") continue;
      assert.equal(isValidStatusTransition(status, "OUT_OF_SERVICE"), true, `${status} -> OUT_OF_SERVICE should be legal`);
    }
  });

  test("OUT_OF_SERVICE can only return to AVAILABLE", () => {
    assert.equal(isValidStatusTransition("OUT_OF_SERVICE", "AVAILABLE"), true);
    assert.equal(isValidStatusTransition("OUT_OF_SERVICE", "DISPATCHED"), false);
    assert.equal(isValidStatusTransition("OUT_OF_SERVICE", "EN_ROUTE"), false);
  });
});

describe("isValidStatusTransition — stand-down paths", () => {
  test("DISPATCHED can stand down back to AVAILABLE (call cancelled before rolling)", () => {
    assert.equal(isValidStatusTransition("DISPATCHED", "AVAILABLE"), true);
  });

  test("AT_SCENE can stand down back to AVAILABLE (patient refused transport)", () => {
    assert.equal(isValidStatusTransition("AT_SCENE", "AVAILABLE"), true);
  });

  test("EN_ROUTE cannot skip straight back to AVAILABLE (must go OUT_OF_SERVICE or continue to AT_SCENE)", () => {
    assert.equal(isValidStatusTransition("EN_ROUTE", "AVAILABLE"), false);
  });
});

describe("getAllowedNextStatuses", () => {
  test("returns the exact allowed set for AVAILABLE", () => {
    assert.deepEqual(getAllowedNextStatuses("AVAILABLE").sort(), ["DISPATCHED", "OUT_OF_SERVICE"].sort());
  });

  test("returns an empty array for an unknown status", () => {
    assert.deepEqual(getAllowedNextStatuses("NOT_A_REAL_STATUS"), []);
  });
});
