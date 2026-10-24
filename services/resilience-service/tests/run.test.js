import test from "node:test";
import assert from "node:assert/strict";
import { Run } from "../src/runner.js";

const scenario = { id: "x", title: "X", target: "t", demonstrates: [] };

test("each stage stays on screen for minStageDisplayMs even when the next one is instant", () => {
  let t = 1_000_000;
  const run = new Run(scenario, { now: () => t, minStageDisplayMs: 5000 });
  run.setStage("NORMAL", { summary: "ok" });
  t += 10_000;
  run.setStage("FAILURE", { summary: "broke", banner: { level: "failed", headline: "SERVICE FAILED" } });
  t += 200;
  run.setStage("DETECTION", { summary: "seen", banner: { level: "detecting", headline: "FAILURE DETECTED" } });
  run.log("detail");

  let v = run.toJSON();
  assert.equal(v.stage, "FAILURE");
  assert.equal(v.banner.headline, "SERVICE FAILED");
  assert.equal(v.stages.find((s) => s.stage === "DETECTION").enteredAt, null);
  assert.ok(v.timeline.every((e) => e.message !== "seen" && e.message !== "detail"));
  assert.equal(run.stage, "DETECTION", "the real stage is not delayed");

  t += 5000;
  v = run.toJSON();
  assert.equal(v.stage, "DETECTION");
  assert.equal(v.banner.headline, "FAILURE DETECTED");
  const det = v.stages.find((s) => s.stage === "DETECTION");
  assert.equal(Date.parse(det.enteredAt) - Date.parse(v.stages.find((s) => s.stage === "FAILURE").enteredAt), 200, "real timestamp revealed");
  assert.ok(v.timeline.some((e) => e.message === "detail"));
});

test("no hold when detection takes longer than minStageDisplayMs, or when disabled", () => {
  let t = 0;
  const run = new Run(scenario, { now: () => t, minStageDisplayMs: 5000 });
  run.setStage("FAILURE", { summary: "broke" });
  t += 6000;
  run.setStage("DETECTION", { summary: "seen" });
  assert.equal(run.toJSON().stage, "DETECTION");

  const off = new Run(scenario, { now: () => t });
  off.setStage("FAILURE", {});
  off.setStage("DETECTION", {});
  assert.equal(off.toJSON().stage, "DETECTION");
});

test("pacing chains: a burst of stages is shown one after another", () => {
  let t = 0;
  const run = new Run(scenario, { now: () => t, minStageDisplayMs: 4000 });
  run.setStage("NORMAL", {});
  t = 10_000;
  run.setStage("FAILURE", {});
  t = 10_100;
  run.setStage("DETECTION", {});
  t = 10_200;
  run.setStage("RECOVERY", {});
  const at = (ms) => { t = ms; return run.toJSON().stage; };
  assert.equal(at(10_300), "FAILURE");
  assert.equal(at(14_050), "DETECTION");
  assert.equal(at(18_050), "RECOVERY");
  run.status = "completed";
  t = 10_300;
  assert.equal(run.toJSON().stage, "RECOVERY", "a finished run is never held back");
});

test("engine stays busy (409) until cleanup has finished, not just until status changes", async () => {
  const { ResilienceEngine, ConflictError } = await import("../src/runner.js");
  let releaseCleanup;
  const slowCleanup = new Promise((r) => (releaseCleanup = r));
  const scenario = {
    id: "s", title: "S", target: "t", demonstrates: [],
    async run() { throw new Error("boom"); },
    async observe() { return null; },
    async cleanup() { await slowCleanup; },
  };
  const engine = new ResilienceEngine({ scenarios: [scenario], k8s: {}, rabbit: {}, request: async () => ({}), cfg: { chaosToken: "t", sampleMs: 1000 } });
  engine.availability = () => ({ available: true });
  engine.start("s");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(engine.current().status, "failed", "status already final");
  assert.equal(engine.isRunning(), true, "but cleanup still running");
  assert.throws(() => engine.start("s"), ConflictError);
  releaseCleanup();
  await engine.settled();
  assert.equal(engine.isRunning(), false);
});
