// Phase 21: the real-data snapshots (tools/real-data). The services are
// separate Docker build contexts, so each ships its own copy; these tests
// fail if a copy drifts from the canonical one in data/real/, or if a record
// breaks an invariant the seeders rely on.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

const COPIES = {
  "data/real/pune-hospitals.json": [
    "services/hospital-service/src/data/pune-hospitals.json",
    "services/ambulance-service/src/data/pune-hospitals.json",
    "services/blood-bank-service/src/main/resources/data/pune-hospitals.json",
  ],
  "data/real/pune-substations.json": ["services/power-service/src/main/resources/data/pune-substations.json"],
  "data/real/pune-population-worldpop-2020-1km.json": ["services/response-service/src/data/pune-population-worldpop-2020-1km.json"],
};

describe("snapshot copies", () => {
  for (const [canonical, copies] of Object.entries(COPIES)) {
    for (const copy of copies) {
      test(`${copy} is identical to ${canonical}`, () => {
        assert.ok(existsSync(path.join(root, canonical)), `${canonical} is missing; run tools/real-data`);
        assert.equal(read(copy), read(canonical), `${copy} differs; re-run tools/real-data/build-snapshots.mjs`);
      });
    }
  }
});

const inPune = (x) => x.latitude > 18.2 && x.latitude < 18.9 && x.longitude > 73.5 && x.longitude < 74.2;

describe("hospital snapshot", () => {
  const snap = JSON.parse(read("data/real/pune-hospitals.json"));

  test("is attributed and dated", () => {
    assert.match(snap.license, /ODbL/);
    assert.ok(!Number.isNaN(Date.parse(snap.retrievedAt)));
    assert.match(snap.estimates, /ESTIMATES/);
  });

  test("every hospital is a real OSM element in Pune with consistent capacity", () => {
    assert.ok(snap.items.length >= 50, `${snap.items.length} hospitals`);
    const ids = new Set();
    for (const h of snap.items) {
      assert.match(h.osmId, /^(node|way|relation)\/\d+$/);
      assert.ok(!ids.has(h.osmId), `duplicate ${h.osmId}`);
      ids.add(h.osmId);
      assert.ok(h.name && h.address, h.osmId);
      assert.ok(inPune(h), `${h.name} outside Pune`);
      for (const [total, available] of [["totalBeds", "availableBeds"], ["totalIcuBeds", "availableIcuBeds"], ["totalVentilators", "availableVentilators"]]) {
        assert.ok(Number.isInteger(h[total]) && h[total] > 0, `${h.name} ${total}`);
        assert.ok(Number.isInteger(h[available]) && h[available] >= 0 && h[available] <= h[total], `${h.name} ${available}`);
      }
      assert.match(h.capacitySource, /^(osm:beds|estimated:(footprint|point|major-point))$/);
    }
  });

  test("the major hospitals the demo relies on are present", () => {
    for (const name of ["Sassoon", "KEM Hospital", "Deenanath Mangeshkar", "Jehangir"]) {
      assert.ok(snap.items.some((h) => h.name.includes(name)), name);
    }
  });
});

describe("substation snapshot", () => {
  const snap = JSON.parse(read("data/real/pune-substations.json"));
  test("real OSM substations in Pune, nearest first, at least three", () => {
    assert.ok(snap.items.length >= 3);
    snap.items.forEach((s, i) => {
      assert.match(s.osmId, /^(node|way|relation)\/\d+$/);
      assert.ok(inPune(s), s.name);
      if (i > 0) assert.ok(s.distanceKm >= snap.items[i - 1].distanceKm);
    });
  });
});
