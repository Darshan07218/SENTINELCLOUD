// Phase 15: the shared command processor (commands.js) — commands run once,
// always get a reply, and only response-service may send them.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const { createCommandProcessor, CommandError } = await import("../../../services/ambulance-service/src/commands.js");

const CMD = "11111111-1111-1111-1111-111111111111";
const PLAN = "22222222-2222-2222-2222-222222222222";

function harness() {
  const processed = new Map();
  const replies = [];
  let kicks = 0;
  const query = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("SELECT outcome, result FROM processed_commands")) {
      const row = processed.get(params[0]);
      return { rows: row ? [row] : [] };
    }
    if (s.startsWith("INSERT INTO processed_commands")) {
      if (processed.has(params[0])) return { rowCount: 0, rows: [] };
      processed.set(params[0], { outcome: params[2], result: params[3] });
      return { rowCount: 1, rows: [] };
    }
    return { rows: [] }; // BEGIN / COMMIT / ROLLBACK
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const outbox = { enqueue: async (_q, key, payload, cid) => replies.push({ key, payload, cid }), kick: () => kicks++ };
  const processCommand = createCommandProcessor({ pool, outbox, log: { warn() {} } });
  const envelope = (source = "response-service", payload = { commandId: CMD, planId: PLAN, count: 2 }) => ({
    eventType: "command.ambulance.dispatch",
    sourceService: source,
    payload,
  });
  return { processCommand, envelope, processed, replies, kicks: () => kicks };
}

describe("createCommandProcessor", () => {
  test("runs a command once, stores the outcome, replies command.succeeded", async () => {
    const h = harness();
    let runs = 0;
    const out = await h.processCommand(h.envelope(), async (p) => { runs++; return { dispatchedCount: p.count }; });
    assert.equal(runs, 1);
    assert.equal(out.outcome, "succeeded");
    assert.deepEqual(h.replies, [{ key: "command.succeeded", cid: CMD, payload: { commandId: CMD, command: "command.ambulance.dispatch", planId: PLAN, result: { dispatchedCount: 2 } } }]);
    assert.equal(h.processed.get(CMD).outcome, "succeeded");
    assert.ok(h.kicks() >= 1, "the outbox relay is kicked so the reply goes out now");
  });

  test("a redelivered command doesn't run again; the stored reply is sent again", async () => {
    const h = harness();
    let runs = 0;
    const execute = async () => { runs++; return { ok: true }; };
    await h.processCommand(h.envelope(), execute);
    const second = await h.processCommand(h.envelope(), execute);
    assert.equal(runs, 1);
    assert.equal(second.duplicate, true);
    assert.equal(h.replies.length, 2);
    assert.deepEqual(h.replies[1].payload.result, { ok: true });
  });

  test("a business failure (CommandError or a service's 4xx) is replied as command.failed and stored", async () => {
    for (const err of [new CommandError("INVALID_COMMAND", "count must be 1..10"), Object.assign(new Error("Disaster not found."), { statusCode: 404, code: "NOT_FOUND" })]) {
      const h = harness();
      const out = await h.processCommand(h.envelope(), async () => { throw err; });
      assert.equal(out.outcome, "failed");
      assert.equal(h.replies[0].key, "command.failed");
      assert.equal(h.replies[0].payload.error.code, err.code);
      assert.equal(h.processed.get(CMD).outcome, "failed");
    }
  });

  test("our own fault (e.g. database down) propagates, so the message is retried; nothing is stored", async () => {
    const h = harness();
    await assert.rejects(h.processCommand(h.envelope(), async () => { throw new Error("connection refused"); }), /connection refused/);
    assert.equal(h.processed.size, 0);
    assert.equal(h.replies.length, 0);
  });

  test("only response-service may send commands", async () => {
    const h = harness();
    let runs = 0;
    const out = await h.processCommand(h.envelope("hospital-service"), async () => { runs++; });
    assert.equal(out.ignored, true);
    assert.equal(runs, 0);
    assert.equal(h.replies.length, 0);
  });

  test("a command without a UUID commandId is ignored", async () => {
    const h = harness();
    const out = await h.processCommand(h.envelope("response-service", { commandId: "nope" }), async () => {});
    assert.equal(out.ignored, true);
  });
});
