// Every Node service ships its own copy of the shared messaging modules
// (separate Docker build contexts). This test fails if any copy drifts from
// the canonical one — run scripts/sync-shared-broker.ps1 (or .sh) to fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const COPIES = {
  "broker.js": ["hospital-service", "ambulance-service", "disaster-service", "notification-service", "response-service"],
  "outbox.js": ["hospital-service", "ambulance-service", "disaster-service", "response-service"],
  "commands.js": ["ambulance-service", "disaster-service", "hospital-service"],
};

for (const [file, services] of Object.entries(COPIES)) {
  for (const svc of services) {
    test(`${svc} has an identical copy of shared/node-broker/${file}`, () => {
      const canonical = readFileSync(path.join(root, "shared/node-broker", file), "utf8");
      const copy = readFileSync(path.join(root, "services", svc, "src", file), "utf8");
      assert.equal(copy, canonical, `services/${svc}/src/${file} differs — run scripts/sync-shared-broker.ps1`);
    });
  }
}
