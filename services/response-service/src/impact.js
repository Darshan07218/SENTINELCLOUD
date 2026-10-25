/**
 * Phase 20 — impact estimate (docs/PHASE-20-SMARTER-RESPONSE.md §1).
 *
 * Pure functions, no I/O. From a disaster's type, severity, location and
 * radius: how many people live in the zone, how many are exposed, how many
 * casualties to expect, and what that means in hospital beds, ICU beds,
 * ambulance trips and blood. The playbook turns those numbers into actions.
 *
 * DEMO MODEL, not an emergency-management tool: the casualty rates are round
 * illustrative values (validated against past Indian disasters in
 * docs/PHASE-22-VALIDATION.md). Every number is in this file so it can be
 * read and argued with.
 *
 * Phase 21: people per km² come from the REAL WorldPop 2020 1 km grid for
 * about ±110 km around Pune (src/data/pune-population-worldpop-2020-1km.json;
 * WorldPop, CC BY 4.0). Outside that grid the zone model below (approximate
 * Census 2011 densities) is the fallback.
 */
import { readFileSync } from "node:fs";

/** A WorldPop grid: { north, west, cellDeg, rows, cols, values[] } (people per cell). */
export function loadPopulationGrid(url = new URL("./data/pune-population-worldpop-2020-1km.json", import.meta.url)) {
  try {
    const g = JSON.parse(readFileSync(url, "utf8"));
    if (!Array.isArray(g.values) || g.values.length !== g.rows * g.cols) return null;
    return g;
  } catch {
    return null; // no grid: the zone model alone
  }
}

export const POPULATION_GRID = loadPopulationGrid();

/**
 * Phase 22: the model's record against historical Indian disasters
 * (src/data/casualty-validation.json, written by
 * tools/validation/validate-casualty-model.mjs). Every plan quotes it, so an
 * operator reads the estimate for what it is: a lower bound for severe
 * sudden events.
 */
export function loadValidationRecord(url = new URL("./data/casualty-validation.json", import.meta.url)) {
  try {
    return JSON.parse(readFileSync(url, "utf8"));
  } catch {
    return null;
  }
}

export const VALIDATION_RECORD = loadValidationRecord();

/** The record for one disaster type: { events, actualOverEstimateMin, actualOverEstimateMax } or { events: 0 }. */
export function validationFor(type, record = VALIDATION_RECORD) {
  return record?.byType?.[type] || { events: 0 };
}

/** People per km² at a point from the grid, or null outside it. */
export function gridDensityAt(latitude, longitude, grid = POPULATION_GRID) {
  if (!grid) return null;
  const row = Math.floor((grid.north - latitude) / grid.cellDeg);
  const col = Math.floor((longitude - grid.west) / grid.cellDeg);
  if (row < 0 || col < 0 || row >= grid.rows || col >= grid.cols) return null;
  const cellKm2 = (grid.cellDeg * 111.32) ** 2 * Math.cos((latitude * Math.PI) / 180);
  return grid.values[row * grid.cols + col] / cellKm2;
}

/**
 * Population density zones, most specific first; a point takes the first
 * zone it falls in, else RURAL_DENSITY.
 *  - PMC: 3.12 M people in ~245 km² (Census 2011) ≈ 12,500 / km²
 *  - PCMC: 1.73 M in ~181 km² ≈ 9,500 / km²
 *  - old-city peths are far denser; the fringe and rural district far less
 */
export const POPULATION_ZONES = Object.freeze([
  { name: "Pune old city (peths)", latitude: 18.514, longitude: 73.857, radiusKm: 2.5, density: 30000 },
  { name: "Pune Municipal Corporation", latitude: 18.52, longitude: 73.855, radiusKm: 9, density: 12500 },
  { name: "Pimpri-Chinchwad", latitude: 18.628, longitude: 73.8, radiusKm: 7.5, density: 9500 },
  { name: "Pune urban fringe", latitude: 18.55, longitude: 73.85, radiusKm: 22, density: 2000 },
]);
export const RURAL_DENSITY = 350; // people / km²

/** Share of the people in the zone actually exposed to this kind of event. */
export const EXPOSURE = Object.freeze({
  FLOOD: 0.05, // low-lying areas and river banks, not the whole circle
  FIRE: 0.05, // the buildings and blocks around the fire
  EARTHQUAKE: 0.5, // shaking reaches most people, damage far fewer
  CYCLONE: 0.25,
  LANDSLIDE: 0.02, // the slope and the settlement below it
  INDUSTRIAL_ACCIDENT: 0.1, // downwind of the plant
});

/** Casualties per 10,000 exposed people at MEDIUM severity. */
export const CASUALTIES_PER_10K = Object.freeze({
  FLOOD: 3,
  FIRE: 2,
  EARTHQUAKE: 1,
  CYCLONE: 1,
  LANDSLIDE: 20,
  INDUSTRIAL_ACCIDENT: 4,
});

/**
 * Steep on purpose: casualties grow much faster than linearly with intensity
 * (an M6.5 quake is not 2.5 × an M5). Calibrated so a MEDIUM (≈ M5) quake
 * under the city gives a few hundred casualties and a CRITICAL one thousands.
 */
export const SEVERITY_MULTIPLIER = Object.freeze({ LOW: 0.2, MEDIUM: 1, HIGH: 4, CRITICAL: 15 });

/** What casualties need. */
export const SHARES = Object.freeze({
  hospitalised: 0.4, // need a hospital bed
  icu: 0.1, // of those, need intensive care (counted within the casualties)
  transport: 0.25, // need an ambulance (the rest are walking wounded)
});
export const TRIPS_PER_AMBULANCE = 4; // in the first hours, one patient per trip
export const FIRST_WAVE_MAX_AMBULANCES = 10; // most one dispatch command may ask for
export const BLOOD_UNITS_PER_ICU_PATIENT = 2; // red-cell units, split over O- and O+
export const MAX_BLOOD_UNITS_PER_TYPE = 40;

const KM_PER_DEG_LAT = 111.32;

function distanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
}

/** People per km²: the WorldPop grid where it covers the point, else the zone model. */
export function densityAt(latitude, longitude, zones = POPULATION_ZONES, grid = POPULATION_GRID) {
  const fromGrid = gridDensityAt(latitude, longitude, grid);
  if (fromGrid !== null) return fromGrid;
  for (const z of zones) if (distanceKm(latitude, longitude, z.latitude, z.longitude) <= z.radiusKm) return z.density;
  return RURAL_DENSITY;
}

/**
 * People living within radiusKm of the point: the density model summed over
 * a grid of cells (about 30 across the circle, 0.25–2 km each).
 */
export function populationWithin(latitude, longitude, radiusKm, zones = POPULATION_ZONES, grid = POPULATION_GRID) {
  const r = Math.min(Math.max(radiusKm, 0.1), 100);
  const step = Math.min(2, Math.max(0.25, r / 30));
  const kmPerDegLng = KM_PER_DEG_LAT * Math.cos((latitude * Math.PI) / 180);
  let people = 0;
  for (let dy = -r + step / 2; dy < r; dy += step) {
    for (let dx = -r + step / 2; dx < r; dx += step) {
      if (dx * dx + dy * dy > r * r) continue;
      people += densityAt(latitude + dy / KM_PER_DEG_LAT, longitude + dx / kmPerDegLng, zones, grid) * step * step;
    }
  }
  return Math.round(people);
}

/**
 * The impact estimate the playbook plans with.
 * disaster: { type, severity, latitude, longitude, radiusKm }
 */
/**
 * The population → casualties step on its own (Phase 22: the validation
 * against historical disasters feeds it each event's population directly).
 */
export function casualtiesFor({ type, severity, population }) {
  const exposure = EXPOSURE[type] ?? 0.1;
  const exposed = Math.round(population * exposure);
  const rate = (CASUALTIES_PER_10K[type] ?? 10) * (SEVERITY_MULTIPLIER[severity] ?? 1);
  return { exposure, exposed, rate, casualties: Math.round((exposed * rate) / 10000) };
}

export function estimateImpact({ type, severity, latitude, longitude, radiusKm }, { grid = POPULATION_GRID } = {}) {
  const population = populationWithin(latitude, longitude, radiusKm, POPULATION_ZONES, grid);
  const { exposure, exposed, rate, casualties } = casualtiesFor({ type, severity, population });
  const hospitalBeds = Math.ceil(casualties * SHARES.hospitalised);
  const icuBeds = Math.ceil(casualties * SHARES.icu);
  const transport = Math.ceil(casualties * SHARES.transport);
  return {
    population,
    exposed,
    casualties,
    hospitalBeds,
    icuBeds,
    transport,
    ambulances: Math.min(FIRST_WAVE_MAX_AMBULANCES, Math.ceil(transport / TRIPS_PER_AMBULANCE)),
    bloodUnitsPerType: Math.min(MAX_BLOOD_UNITS_PER_TYPE, Math.ceil((icuBeds * BLOOD_UNITS_PER_ICU_PATIENT) / 2)),
    assumptions: {
      exposure,
      casualtiesPer10kExposed: rate,
      shares: SHARES,
      tripsPerAmbulance: TRIPS_PER_AMBULANCE,
      model: grid
        ? "Population: WorldPop 2020 1 km grid (CC BY 4.0); illustrative casualty rates (demo model)."
        : "Population: approximate Census 2011 density zones for Pune; illustrative casualty rates (demo model).",
      populationSource: grid ? "worldpop-2020-1km" : "census-2011-zones",
      validation: validationFor(type),
    },
  };
}
