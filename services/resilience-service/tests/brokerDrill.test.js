import test from "node:test";
import assert from "node:assert/strict";
import { BrokerDrill } from "../src/probes.js";

// Regression (found on a real k3s run): a 1s restore check phase-locked to
// the 1s consumer always sampled right before a consume, saw depth ≈ 5 and
// never declared the backlog drained. isDrained() must hold at ANY phase.
test("isDrained holds in steady state whatever moment it samples", () => {
  const drill = new BrokerDrill({ rabbit: {}, produceEveryMs: 200, consumePerSec: 10, consumeEveryMs: 1000 });
  assert.equal(drill.steadyStateDepth, 6);
  // Steady state: 5 events arrive per consume interval, the consumer takes them all.
  for (let phase = 0; phase <= 5; phase += 1) {
    drill.published = 1000 + phase; // `phase` events published since the last consume
    drill.consumed = 1000;
    drill.outbox = phase % 2 ? [{ seq: 1 }] : []; // sometimes one publish is in flight
    assert.equal(drill.isDrained(), true, `phase ${phase}`);
  }
});

test("isDrained is false while a backlog or outbox remains, or the consumer is paused", () => {
  const drill = new BrokerDrill({ rabbit: {}, produceEveryMs: 200, consumeEveryMs: 1000 });
  drill.published = 40; drill.consumed = 0;
  assert.equal(drill.isDrained(), false, "backlog");
  drill.consumed = 40; drill.outbox = [{}, {}, {}];
  assert.equal(drill.isDrained(), false, "outbox still flushing");
  drill.outbox = []; drill.pauseConsumer();
  assert.equal(drill.isDrained(), false, "consumer paused");
  drill.resumeConsumer();
  assert.equal(drill.isDrained(), true);
});
