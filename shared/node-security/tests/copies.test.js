// Every Node service ships its own copy of the shared security modules
// (separate Docker build contexts). This test fails if any copy drifts
// from the canonical one — run scripts/sync-shared-security.sh to fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FILES = ["secrets.js", "audit.js", "jwt.js"];
const SERVICES = ["gateway", "auth-service", "hospital-service", "ambulance-service", "disaster-service", "notification-service", "resilience-service", "response-service", "simulator-service"];

for (const svc of SERVICES) {
  test(`${svc} has identical copies of the shared security modules`, () => {
    for (const f of FILES) {
      const canonical = readFileSync(path.join(root, "shared/node-security", f), "utf8");
      const copy = readFileSync(path.join(root, "services", svc, "src/security", f), "utf8");
      assert.equal(copy, canonical, `services/${svc}/src/security/${f} differs — run scripts/sync-shared-security.sh`);
    }
  });
}
