import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createIntakeService } from "../src/services/intakeService.js";
import { createMemoryRepository, createFakeGateway, PUNE, quake, forecast, quiet } from "./fakes.js";

const operator = { id: "op-1", email: "operator@example.com", role: "EMERGENCY_OPERATOR" };

function setup({ autoConfirmMinSeverity = "CRITICAL", feeds = {}, gatewayDelayMs = 0 } = {}) {
  const repository = createMemoryRepository();
  const gateway = createFakeGateway({ delayMs: gatewayDelayMs });
  const fetchImpl = async (url) => {
    const body = url.includes("earthquake") ? feeds.usgs : feeds.weather;
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body };
  };
  const seen = [];
  const service = createIntakeService({ repository, gateway, watch: PUNE, autoConfirmMinSeverity, fetchImpl, onDetection: (d) => seen.push(d), log: quiet });
  return { repository, gateway, service, seen };
}

describe("polling and dedup", () => {
  test("a new quake becomes one PENDING detection; polling again finds nothing new", async () => {
    const { service, repository, gateway, seen } = setup({ feeds: { usgs: { features: [quake({ mag: 4.8 })] } } });
    const first = await service.pollUsgs();
    assert.equal(first.length, 1);
    assert.equal(first[0].status, "PENDING");
    assert.equal((await service.pollUsgs()).length, 0);
    assert.equal(repository.rows.size, 1);
    assert.equal(seen.length, 1);
    assert.equal(gateway.calls.length, 0, "MEDIUM is not auto-confirmed");
    const [usgs] = await repository.sources();
    assert.equal(usgs.lastFound, 1);
    assert.equal(usgs.lastError, null);
  });

  test("unset source settings (undefined, as from an empty env var) keep the default feed URLs", async () => {
    // Regression: { url: undefined } used to replace the default and every poll failed with "Failed to parse URL from undefined".
    const urls = [];
    const service = createIntakeService({
      repository: createMemoryRepository(),
      gateway: createFakeGateway(),
      watch: PUNE,
      sources: { usgs: { enabled: true, url: undefined, intervalSeconds: undefined }, openMeteo: { url: undefined } },
      fetchImpl: async (url) => (urls.push(url), { ok: true, status: 200, json: async () => ({ features: [], hourly: {} }) }),
      log: quiet,
    });
    await service.pollUsgs();
    await service.pollOpenMeteo();
    assert.match(urls[0], /^https:\/\/earthquake\.usgs\.gov\//);
    assert.match(urls[1], /^https:\/\/api\.open-meteo\.com\//);
    assert.equal((await service.overview()).sources[0].intervalSeconds, 120);
  });

  test("a failing feed is recorded on the source, not thrown", async () => {
    const { service, repository } = setup({ feeds: { usgs: new Error("ECONNRESET") } });
    assert.deepEqual(await service.pollUsgs(), []);
    const [usgs] = await repository.sources();
    assert.equal(usgs.lastError, "ECONNRESET");
  });

  test("the weather poll stores its 24 h reading even when nothing is detected", async () => {
    const { service, repository } = setup({ feeds: { weather: forecast({ rainPerHour: 1, gust: 35 }) } });
    await service.pollOpenMeteo();
    const [om] = await repository.sources();
    assert.equal(om.reading.rain24hMm, 24);
    assert.equal(om.reading.maxGustKmh, 35);
  });
});

describe("auto-confirm policy", () => {
  test("CRITICAL is confirmed automatically; the disaster is created through the gateway", async () => {
    const { service, repository, gateway } = setup({ feeds: { weather: forecast({ rainPerHour: 9 }) } }); // 216 mm
    const [d] = await service.pollOpenMeteo();
    const stored = await repository.findById(d.id);
    assert.equal(stored.status, "AUTO_CONFIRMED");
    assert.ok(stored.disasterId);
    assert.equal(stored.decidedBy, "auto");
    assert.equal(gateway.calls.length, 1);
    const body = gateway.calls[0].body;
    assert.equal(gateway.calls[0].path, "/disasters");
    assert.equal(body.type, "FLOOD");
    assert.equal(body.severity, "CRITICAL");
    assert.match(body.description, /^\[Auto-detected · OPEN_METEO · auto-confirmed\]/);
  });

  test("NONE never auto-confirms; LOW auto-confirms everything", async () => {
    const none = setup({ autoConfirmMinSeverity: "NONE" });
    assert.equal(none.service.shouldAutoConfirm("CRITICAL"), false);
    const low = setup({ autoConfirmMinSeverity: "LOW" });
    assert.equal(low.service.shouldAutoConfirm("LOW"), true);
    const high = setup({ autoConfirmMinSeverity: "HIGH" });
    assert.equal(high.service.shouldAutoConfirm("MEDIUM"), false);
    assert.equal(high.service.shouldAutoConfirm("CRITICAL"), true);
  });
});

describe("operator decisions", () => {
  test("confirm creates exactly one disaster, even with two simultaneous clicks", async () => {
    const { service, gateway } = setup({ gatewayDelayMs: 20 });
    const d = await service.injectDemo({ type: "FLOOD", severity: "HIGH" });
    assert.equal(d.status, "PENDING");
    const results = await Promise.allSettled([service.confirm(d.id, operator), service.confirm(d.id, operator)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const conflict = results.filter((r) => r.status === "rejected");
    assert.equal(ok.length, 1);
    assert.equal(ok[0].value.status, "CONFIRMED");
    assert.equal(ok[0].value.decidedBy, "operator@example.com");
    assert.equal(conflict[0].reason.statusCode, 409);
    assert.equal(gateway.calls.length, 1);
  });

  test("a failed disaster API call leaves the detection FAILED, and it can be confirmed again", async () => {
    const { service, gateway } = setup();
    const d = await service.injectDemo({ type: "FIRE", severity: "MEDIUM" });
    gateway.fail = new Error("gateway timeout");
    await assert.rejects(service.confirm(d.id, operator), (err) => err.statusCode === 502 && err.code === "DISASTER_NOT_CREATED");
    assert.equal((await service.get(d.id)).status, "FAILED");
    assert.equal((await service.get(d.id)).error, "gateway timeout");
    const again = await service.confirm(d.id, operator);
    assert.equal(again.status, "CONFIRMED");
    assert.equal(again.error, null);
  });

  test("dismiss; then confirming or dismissing again is 409; an unknown id is 404", async () => {
    const { service, gateway } = setup();
    const d = await service.injectDemo({ type: "LANDSLIDE", severity: "LOW" });
    assert.equal((await service.dismiss(d.id, operator, { note: "false alarm" })).status, "DISMISSED");
    await assert.rejects(service.confirm(d.id, operator), (err) => err.statusCode === 409);
    await assert.rejects(service.dismiss(d.id, operator), (err) => err.statusCode === 409);
    await assert.rejects(service.confirm("00000000-0000-4000-8000-000000000000", operator), (err) => err.statusCode === 404);
    assert.equal(gateway.calls.length, 0);
  });

  test("a CRITICAL demo detection goes through the same auto-confirm policy", async () => {
    const { service } = setup();
    const d = await service.injectDemo({ type: "EARTHQUAKE", severity: "CRITICAL" });
    assert.equal(d.status, "AUTO_CONFIRMED");
    assert.equal(d.source, "DEMO");
    assert.ok(Math.abs(d.latitude - PUNE.latitude) < 0.05);
  });

  test("overview lists both sources with their polling settings", async () => {
    const { service } = setup({ feeds: { usgs: { features: [] } } });
    await service.pollUsgs();
    const o = await service.overview();
    assert.equal(o.watch.name, "Pune");
    assert.equal(o.policy.autoConfirmMinSeverity, "CRITICAL");
    assert.deepEqual(o.sources.map((s) => s.source), ["USGS", "OPEN_METEO"]);
    assert.equal(o.sources[0].intervalSeconds, 120);
    assert.ok(o.sources[0].lastPolledAt);
  });
});
