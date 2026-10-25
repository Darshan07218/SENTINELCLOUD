/**
 * Phase 22: what the casualty model is given for a historical event, by the
 * fixed rules in events.json ("rules"), never the outcome. Earthquakes use
 * the very functions intake-service uses for live USGS detections.
 */
import { earthquakeSeverity, feltRadiusKm } from "../../services/intake-service/src/sources/usgs.js";

export function eventInputs(ev) {
  if (ev.type === "EARTHQUAKE") {
    // Distance 0: the impact estimate is centred on the epicentre.
    return { severity: earthquakeSeverity(ev.magnitude, 0), radiusKm: feltRadiusKm(ev.magnitude) };
  }
  return { severity: ev.severity, radiusKm: ev.radiusKm };
}

/** Population at the time of the event: WorldPop 2020 scaled by India's population growth. */
export function populationAtEvent(ev, indiaMillions) {
  const year = String(new Date(ev.date).getUTCFullYear());
  const factor = (indiaMillions[year] ?? indiaMillions["2020"]) / indiaMillions["2020"];
  return Math.round(ev.population2020 * factor);
}
