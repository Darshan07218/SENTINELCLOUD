import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildSituationReport } from "../src/services/situationReportService.js";
import { ROUTING_KEYS } from "../src/events/eventTypes.js";

const disaster = {
  id: "d1",
  type: "FLOOD",
  severity: "HIGH",
  status: "ACTIVE",
  latitude: 18.52,
  longitude: 73.85,
  radiusKm: 15,
};

describe("buildSituationReport", () => {
  test("with no reactions yet, every section reports awaiting response", () => {
    const report = buildSituationReport(disaster, []);
    assert.equal(report.respondedServices, 0);
    assert.equal(report.fullyReported, false);
    assert.equal(report.hospital.respondedAt, null);
    assert.equal(report.ambulance.respondedAt, null);
    assert.equal(report.bloodBank.respondedAt, null);
    assert.equal(report.power.respondedAt, null);
  });

  test("merges each service's reaction payload into its own section", () => {
    const reactions = [
      {
        eventType: ROUTING_KEYS.HOSPITAL_CAPACITY_UPDATED,
        sourceService: "hospital-service",
        receivedAt: "2026-01-01T00:00:00.000Z",
        payload: { nearbyHospitals: [{ id: "h1" }], totalAvailableBeds: 42 },
      },
      {
        eventType: ROUTING_KEYS.BLOOD_SHORTAGE_DETECTED,
        sourceService: "blood-bank-service",
        receivedAt: "2026-01-01T00:00:05.000Z",
        payload: { shortageAlerts: [{ bloodType: "O_NEGATIVE" }] },
      },
    ];

    const report = buildSituationReport(disaster, reactions);

    assert.equal(report.respondedServices, 2);
    assert.equal(report.fullyReported, false);
    assert.equal(report.hospital.totalAvailableBeds, 42);
    assert.equal(report.hospital.respondedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(report.bloodBank.shortageAlerts[0].bloodType, "O_NEGATIVE");
    assert.equal(report.ambulance.respondedAt, null, "ambulance hasn't reacted yet in this scenario");
  });

  test("fullyReported is true once all four services have reacted", () => {
    const reactions = [
      { eventType: ROUTING_KEYS.HOSPITAL_CAPACITY_UPDATED, sourceService: "hospital-service", receivedAt: "t", payload: {} },
      { eventType: ROUTING_KEYS.AMBULANCE_STATUS_UPDATED, sourceService: "ambulance-service", receivedAt: "t", payload: {} },
      { eventType: ROUTING_KEYS.BLOOD_SHORTAGE_DETECTED, sourceService: "blood-bank-service", receivedAt: "t", payload: {} },
      { eventType: ROUTING_KEYS.POWER_INFRASTRUCTURE_AT_RISK, sourceService: "power-service", receivedAt: "t", payload: {} },
    ];

    const report = buildSituationReport(disaster, reactions);
    assert.equal(report.fullyReported, true);
    assert.equal(report.respondedServices, 4);
  });
});
