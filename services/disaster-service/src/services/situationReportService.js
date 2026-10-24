import { REACTION_ROUTING_KEYS, ROUTING_KEYS } from "../events/eventTypes.js";

/**
 * Builds a disaster_situation_report (per docs/ARCHITECTURE.md
 * section 3, Disaster/Event Intelligence Service responsibilities) by
 * reading whatever reaction rows the aggregator consumer has stored so
 * far for this disaster — see consumers/reactionConsumer.js for how
 * those rows get there. This function is pure given its inputs (no DB
 * access itself), which makes it directly unit-testable — see
 * tests/situationReport.test.js.
 *
 * A disaster with zero reactions yet (e.g. queried the instant after
 * creation, before any service has had a chance to react) still
 * produces a valid report — every section just reports
 * `respondedAt: null` and empty data, which the frontend renders as
 * "awaiting response" rather than an error.
 */
export function buildSituationReport(disaster, reactions) {
  const bySourceAndType = new Map(reactions.map((r) => [`${r.eventType}::${r.sourceService}`, r]));

  const hospital = bySourceAndType.get(`${ROUTING_KEYS.HOSPITAL_CAPACITY_UPDATED}::hospital-service`);
  const ambulance = bySourceAndType.get(`${ROUTING_KEYS.AMBULANCE_STATUS_UPDATED}::ambulance-service`);
  const bloodBank = bySourceAndType.get(`${ROUTING_KEYS.BLOOD_SHORTAGE_DETECTED}::blood-bank-service`);
  const power = bySourceAndType.get(`${ROUTING_KEYS.POWER_INFRASTRUCTURE_AT_RISK}::power-service`);

  const sections = { hospital, ambulance, bloodBank, power };
  const respondedCount = Object.values(sections).filter(Boolean).length;
  const totalExpected = REACTION_ROUTING_KEYS.length;

  return {
    disasterId: disaster.id,
    disasterType: disaster.type,
    severity: disaster.severity,
    status: disaster.status,
    statusNote: disaster.statusNote ?? null,
    location: { latitude: disaster.latitude, longitude: disaster.longitude, radiusKm: disaster.radiusKm },
    respondedServices: respondedCount,
    totalExpectedServices: totalExpected,
    fullyReported: respondedCount === totalExpected,
    hospital: hospital
      ? { respondedAt: hospital.receivedAt, ...hospital.payload }
      : { respondedAt: null, message: "Awaiting response from Hospital Service." },
    ambulance: ambulance
      ? { respondedAt: ambulance.receivedAt, ...ambulance.payload }
      : { respondedAt: null, message: "Awaiting response from Ambulance Service." },
    bloodBank: bloodBank
      ? { respondedAt: bloodBank.receivedAt, ...bloodBank.payload }
      : { respondedAt: null, message: "Awaiting response from Blood Bank Service." },
    power: power
      ? { respondedAt: power.receivedAt, ...power.payload }
      : { respondedAt: null, message: "Awaiting response from Power Service." },
  };
}
