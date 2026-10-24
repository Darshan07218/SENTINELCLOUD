// Phase 14: at-least-once delivery means the same event can arrive twice;
// the live feed and the history list must show it once.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRecentIds } from "../src/recentIds.js";

describe("createRecentIds (live feed de-duplication)", () => {
  test("lets an id through once", () => {
    const ids = createRecentIds(10);
    assert.equal(ids.firstTime("e1"), true);
    assert.equal(ids.firstTime("e1"), false);
    assert.equal(ids.firstTime("e2"), true);
  });

  test("events without an id are never suppressed", () => {
    const ids = createRecentIds(10);
    assert.equal(ids.firstTime(undefined), true);
    assert.equal(ids.firstTime(undefined), true);
    assert.equal(ids.firstTime(null), true);
  });

  test("memory is bounded: the oldest id is forgotten first", () => {
    const ids = createRecentIds(3);
    for (const id of ["a", "b", "c", "d"]) ids.firstTime(id);
    assert.equal(ids.size, 3);
    assert.equal(ids.firstTime("a"), true, "a was evicted, so it counts as new");
    assert.equal(ids.firstTime("d"), false, "d is still remembered");
  });
});
