/**
 * Phase 16 — the scripted scenarios (docs/PHASE-16-SIMULATOR.md §2).
 *
 * Each step: `at` (seconds from the start), an `action` with its params
 * (runner.js knows how to carry each one out through the gateway) and `say`,
 * the line of narration the Simulator page shows. Steps marked `cleanup`
 * still run when a run is stopped early, so a demo never leaves hospitals
 * short of beds, a transformer hot or a test disaster open.
 *
 * Locations are in Pune, where the seed data (hospitals, ambulances, blood
 * banks, substations) lives.
 */
const PUNE_CENTRE = { latitude: 18.52, longitude: 73.85 };

export const SCENARIOS = Object.freeze([
  {
    id: "monsoon-flood",
    title: "Monsoon flood",
    summary: "A HIGH flood in central Pune: hospitals fill up, a transformer overheats, the response plan is approved and ambulances drive to the scene and back, severity rises, then contained and resolved.",
    durationSeconds: 215,
    ambient: true,
    steps: [
      { at: 0, action: "report", params: { type: "FLOOD", severity: "HIGH", ...PUNE_CENTRE, radiusKm: 15, description: "Monsoon flooding: the Mutha river has burst its banks near the city centre." },
        say: "A HIGH flood is reported in central Pune. Watch the live feed: hospital, ambulance, blood-bank and power services each react within a second." },
      { at: 15, action: "hospitalSurge", params: { count: 2, fraction: 0.6 },
        say: "Casualties start arriving: the two nearest hospitals lose most of their free beds, and the Hospitals page shows the alerts." },
      { at: 25, action: "approvePlan", params: { revision: 1 },
        say: "The response engine turned the situation report into a plan. The operator approves it: ambulances are dispatched and blood is reserved." },
      { at: 45, action: "transformerSpike", params: {},
        say: "A transformer near the flood overheats: the Power Grid raises a CRITICAL alert and records a failure episode." },
      { at: 75, action: "updateDisaster", params: { severity: "CRITICAL", description: "Water still rising; low-lying wards cut off." },
        say: "The water keeps rising: severity goes to CRITICAL and every service re-assesses its surroundings." },
      { at: 150, action: "setStatus", params: { status: "CONTAINED", note: "Embankments holding; water receding." },
        say: "Embankments hold: the disaster is marked CONTAINED. The services check again in case anything changed." },
      { at: 195, action: "transformerRecover", params: {}, cleanup: true,
        say: "Repair crews bring the transformer back to normal: the failure episode closes." },
      { at: 200, action: "hospitalRecover", params: {}, cleanup: true,
        say: "Patients are discharged or transferred: the hospitals' free beds return to normal." },
      { at: 210, action: "setStatus", params: { status: "RESOLVED", note: "Flood over; scenario finished." }, cleanup: true,
        say: "The flood is RESOLVED. That record is final; every step is in the audit log under the simulator account." },
    ],
  },
  {
    id: "earthquake-escalation",
    title: "Earthquake, with escalation",
    summary: "A CRITICAL earthquake needs more ambulances than are in range: the plan sends what's close and widens the search, a follow-up plan sends the rest, then it's resolved.",
    durationSeconds: 180,
    ambient: true,
    steps: [
      { at: 0, action: "report", params: { type: "EARTHQUAKE", severity: "CRITICAL", ...PUNE_CENTRE, radiusKm: 15, description: "Magnitude 6.1 earthquake; collapsed buildings reported across the old city." },
        say: "A CRITICAL earthquake: the playbook calls for 9 ambulances, more than are free within 15 km." },
      { at: 25, action: "approvePlan", params: { revision: 1 },
        say: "The plan sends every ambulance in range and widens the search to 30 km. The operator approves it." },
      { at: 45, action: "approvePlan", params: { revision: 2, timeoutSeconds: 60 },
        say: "The services re-checked at 30 km and the engine proposed a follow-up for the shortfall only. Approved." },
      { at: 140, action: "setStatus", params: { status: "CONTAINED", note: "Search and rescue complete in the worst-hit wards." },
        say: "Search and rescue is complete: CONTAINED." },
      { at: 175, action: "setStatus", params: { status: "RESOLVED", note: "Earthquake response finished; scenario over." }, cleanup: true,
        say: "RESOLVED. Ambulances keep finishing their trips in the background." },
    ],
  },
  {
    id: "industrial-fire",
    title: "Industrial fire, operator decides",
    summary: "A fire at an industrial site: the engine proposes a plan, but the operator knows the fire brigade has it covered and rejects it with a note.",
    durationSeconds: 95,
    ambient: false,
    steps: [
      { at: 0, action: "report", params: { type: "INDUSTRIAL_ACCIDENT", severity: "HIGH", latitude: 18.56, longitude: 73.81, radiusKm: 12, description: "Chemical store fire at an industrial estate; smoke drifting over homes." },
        say: "A HIGH industrial fire is reported. The engine will propose a plan, as always." },
      { at: 25, action: "rejectPlan", params: { revision: 1, note: "Fire brigade on scene with its own paramedics; keep ambulances available for the city." },
        say: "The operator rejects the plan with a reason. Automation proposes; a person decides." },
      { at: 60, action: "setStatus", params: { status: "CONTAINED", note: "Fire under control." },
        say: "The fire is under control: CONTAINED." },
      { at: 90, action: "setStatus", params: { status: "RESOLVED", note: "Site safe; scenario over." }, cleanup: true,
        say: "RESOLVED. Nothing was dispatched, and the rejection and its reason are on record." },
    ],
  },
]);

export function findScenario(id) {
  return SCENARIOS.find((s) => s.id === id) || null;
}
