#!/usr/bin/env node
/**
 * Phase 21: real-data snapshots (docs/PHASE-21-REAL-DATA.md).
 *
 * Downloads Pune's hospitals and power substations from OpenStreetMap
 * (Overpass API) ONCE, applies the selection rules below, and writes dated,
 * attributed snapshot files:
 *
 *   data/real/pune-hospitals.json      canonical copy (the repository's record)
 *   data/real/pune-substations.json
 *   + the copies each service seeds from (they are separate Docker build
 *     contexts, so each needs its own; tests/data/copies.test.js checks they match)
 *
 * The services never call OpenStreetMap at runtime: a fresh install seeds the
 * same data every time, offline. Re-run this script to refresh the snapshot.
 *
 *   node tools/real-data/build-snapshots.mjs
 *
 * Data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).
 * What is NOT in OpenStreetMap is estimated, and every record says which
 * fields are estimates (capacitySource).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OVERPASS = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
const CENTRE = { lat: 18.5204, lng: 73.8567 }; // Pune
const RADIUS_M = 20000;

// Specialist facilities that don't take disaster casualties.
const NOT_ACUTE = /\b(veterinary|animal|eye|netra|dental|dentist|ayurved|homoeo|homeo|unani|physiotherap|ivf|fertility|skin|derma|psychiatr|de-?addiction|rehab|diagnostic|pathology|scan|imaging)\b/i;

/**
 * Major public / teaching hospitals that OpenStreetMap maps only as a point
 * without an emergency tag, so the rules above would miss them. Listed by OSM
 * id, with the reason. With no building footprint to go on they get a fixed
 * estimate (MAJOR_POINT_BEDS), labelled estimated:major-point.
 */
const MAJOR_POINTS = new Map([
  ["node/7068194960", "B. J. Medical College and Sassoon Hospital: Pune's main government teaching hospital"],
  ["node/678341812", "Command Hospital (Southern Command): the Army's referral hospital for the region"],
]);
const MAJOR_POINT_BEDS = 300;
const SAME_PLACE_KM = 0.12; // two records this close are one facility (e.g. English + Marathi names)

// The public Overpass servers return 429/502/504 under load: retry with
// backoff, alternating between the main server and a mirror.
const MIRRORS = [OVERPASS, "https://overpass.kumi.systems/api/interpreter"];

async function overpass(query) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "SentinelCloud coursework (real-data snapshot)" },
        body: new URLSearchParams({ data: query }),
      });
      if (res.ok) return await res.json();
      lastError = new Error(`Overpass HTTP ${res.status} from ${url}`);
    } catch (err) {
      lastError = err;
    }
    const waitS = 5 * 2 ** Math.min(attempt, 3);
    console.warn(`${lastError.message}; retrying in ${waitS} s`);
    await new Promise((r) => setTimeout(r, waitS * 1000));
  }
  throw lastError;
}

function distanceKm(a, b) {
  const t = (x) => (x * Math.PI) / 180;
  const h = Math.sin(t(b.lat - a.lat) / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(t(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** Area in m² of a closed way's geometry (shoelace on a local flat projection). */
function polygonAreaM2(geometry) {
  if (!Array.isArray(geometry) || geometry.length < 4) return null;
  const lat0 = geometry[0].lat;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  let sum = 0;
  for (let i = 0; i < geometry.length - 1; i++) {
    const a = geometry[i];
    const b = geometry[i + 1];
    sum += a.lon * mPerDegLng * (b.lat * mPerDegLat) - b.lon * mPerDegLng * (a.lat * mPerDegLat);
  }
  return Math.round(Math.abs(sum) / 2);
}

function centroid(e) {
  if (Number.isFinite(e.lat)) return { lat: e.lat, lng: e.lon };
  if (e.center) return { lat: e.center.lat, lng: e.center.lon };
  if (Array.isArray(e.geometry) && e.geometry.length) {
    const g = e.geometry;
    return { lat: g.reduce((s, p) => s + p.lat, 0) / g.length, lng: g.reduce((s, p) => s + p.lon, 0) / g.length };
  }
  if (e.bounds) return { lat: (e.bounds.minlat + e.bounds.maxlat) / 2, lng: (e.bounds.minlon + e.bounds.maxlon) / 2 };
  return null;
}

/** Deterministic 0..1 from a string (so estimates are the same on every run). */
function unit(text) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

const round5 = (x) => Math.round(x * 1e5) / 1e5;
const norm = (s) => s.toLowerCase().replace(/hospital|hosp\.?|and|&|the|[^a-z0-9]/g, "");

function address(tags) {
  const parts = [tags["addr:housenumber"], tags["addr:street"], tags["addr:suburb"] || tags["addr:place"], tags["addr:city"] || "Pune", tags["addr:postcode"]].filter(Boolean);
  return parts.length > 1 ? parts.join(", ") : `${tags["addr:suburb"] ? tags["addr:suburb"] + ", " : ""}Pune, Maharashtra`;
}

/**
 * Bed estimate. OpenStreetMap almost never records beds, so:
 *  - a `beds` tag wins;
 *  - otherwise the mapped footprint: floor area ≈ footprint × ~3–4 storeys at
 *    ~100 m² of floor per bed → beds ≈ footprint / 30, clamped to 40–1000
 *    (mapped areas are often the whole campus, not one building);
 *  - a listed major hospital mapped only as a point: MAJOR_POINT_BEDS;
 *  - a hospital mapped only as a point: 40–90 beds, more if it has an emergency department.
 */
export function estimateBeds({ tags, footprintM2, key }) {
  const tagged = parseInt(tags.beds, 10);
  if (Number.isFinite(tagged) && tagged > 0) return { beds: tagged, source: "osm:beds" };
  if (MAJOR_POINTS.has(key) && !footprintM2) return { beds: MAJOR_POINT_BEDS, source: "estimated:major-point" };
  if (footprintM2) return { beds: Math.min(1000, Math.max(40, Math.round(footprintM2 / 30))), source: "estimated:footprint" };
  const base = tags.emergency === "yes" ? 70 : 40;
  return { beds: base + Math.round(unit(key) * 20), source: "estimated:point" };
}

async function buildHospitals() {
  const q = `[out:json][timeout:120];(nwr["amenity"="hospital"](around:${RADIUS_M},${CENTRE.lat},${CENTRE.lng}););out tags geom;`;
  const j = await overpass(q);
  const candidates = [];
  for (const e of j.elements) {
    const tags = e.tags || {};
    if (!tags.name) continue;
    const isBuilding = e.type !== "node";
    const major = MAJOR_POINTS.has(`${e.type}/${e.id}`);
    if (!isBuilding && !major && tags.emergency !== "yes" && !tags.beds) continue;
    if (NOT_ACUTE.test(tags.name) || NOT_ACUTE.test(tags["healthcare:speciality"] || "")) continue;
    const c = centroid(e);
    if (!c || distanceKm(CENTRE, c) > RADIUS_M / 1000) continue;
    const footprintM2 = e.type === "way" ? polygonAreaM2(e.geometry) : null;
    candidates.push({ e, tags, c, footprintM2, isBuilding });
  }
  // The same hospital mapped twice (a point and a building): keep the building.
  candidates.sort((a, b) => Number(b.isBuilding) - Number(a.isBuilding) || (b.footprintM2 || 0) - (a.footprintM2 || 0));
  const kept = [];
  for (const c of candidates) {
    if (kept.some((k) => distanceKm(k.c, c.c) < SAME_PLACE_KM || (norm(k.tags.name) === norm(c.tags.name) && distanceKm(k.c, c.c) < 0.5))) continue;
    kept.push(c);
  }
  return kept
    .map(({ e, tags, c, footprintM2 }) => {
      const key = `${e.type}/${e.id}`;
      const { beds, source } = estimateBeds({ tags, footprintM2, key });
      const icu = Math.max(2, Math.round(beds * 0.08));
      const ventilators = Math.max(1, Math.round(icu * 0.6));
      // A plausible starting occupancy (55–92 %), the same on every install.
      const occupancy = 0.55 + unit(`${key}:occ`) * 0.37;
      const icuOccupancy = Math.min(1, occupancy + 0.05);
      return {
        osmId: key,
        name: tags.name.trim().slice(0, 160),
        latitude: round5(c.lat),
        longitude: round5(c.lng),
        address: address(tags).slice(0, 300),
        phone: (tags.phone || tags["contact:phone"] || "").split(";")[0].trim().slice(0, 32) || null,
        emergencyDepartment: tags.emergency === "yes",
        operator: tags.operator || null,
        footprintM2,
        totalBeds: beds,
        availableBeds: Math.round(beds * (1 - occupancy)),
        totalIcuBeds: icu,
        availableIcuBeds: Math.round(icu * (1 - icuOccupancy)),
        totalVentilators: ventilators,
        availableVentilators: Math.round(ventilators * (1 - icuOccupancy)),
        capacitySource: source,
        ...(MAJOR_POINTS.has(key) ? { listedBecause: MAJOR_POINTS.get(key) } : {}),
      };
    })
    .sort((a, b) => b.totalBeds - a.totalBeds || a.name.localeCompare(b.name));
}

async function buildSubstations() {
  const q = `[out:json][timeout:120];(nwr["power"="substation"](around:${RADIUS_M},${CENTRE.lat},${CENTRE.lng}););out tags geom;`;
  const j = await overpass(q);
  const out = [];
  for (const e of j.elements) {
    const tags = e.tags || {};
    const c = centroid(e);
    if (!c) continue;
    const kv = String(tags.voltage || "")
      .split(/[;,]/)
      .map((v) => parseInt(v, 10))
      .filter((v) => Number.isFinite(v) && v > 0);
    const maxKv = kv.length ? Math.max(...kv) / 1000 : null;
    // Distribution kiosks and unnamed transformer pads aren't grid substations.
    if (!tags.name && !(maxKv && maxKv >= 22)) continue;
    if (tags.substation && /^(minor_distribution|industrial)$/.test(tags.substation) && !tags.name) continue;
    const key = `${e.type}/${e.id}`;
    out.push({
      osmId: key,
      name: (tags.name || `${maxKv ? `${maxKv} kV ` : ""}substation ${tags.ref || e.id}`).trim().slice(0, 160),
      latitude: round5(c.lat),
      longitude: round5(c.lng),
      operator: tags.operator || null,
      voltageKv: kv.map((v) => v / 1000),
      maxVoltageKv: maxKv,
      distanceKm: Math.round(distanceKm(CENTRE, c) * 10) / 10,
    });
  }
  return out.sort((a, b) => a.distanceKm - b.distanceKm);
}

function write(file, payload) {
  const full = path.join(ROOT, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(payload, null, 1) + "\n");
  console.log(`wrote ${file} (${payload.items.length} items)`);
}

const meta = (what, query) => ({
  dataset: what,
  source: "OpenStreetMap via the Overpass API",
  license: "Open Database License (ODbL) 1.0; © OpenStreetMap contributors, https://www.openstreetmap.org/copyright",
  retrievedAt: new Date().toISOString(),
  area: `within ${RADIUS_M / 1000} km of Pune (${CENTRE.lat}, ${CENTRE.lng})`,
  selection: query,
});

const hospitals = await buildHospitals();
const hospitalSnapshot = {
  ...meta("Pune hospitals", "amenity=hospital, named, mapped as a building/campus or with emergency=yes or beds, plus listed major hospitals mapped only as points (MAJOR_POINTS); specialist facilities (eye, dental, veterinary, AYUSH, diagnostics…) excluded; records within 120 m merged"),
  estimates: "Bed, ICU and ventilator counts are ESTIMATES unless capacitySource is osm:beds (see tools/real-data/build-snapshots.mjs, estimateBeds). Starting availability is synthetic.",
  items: hospitals,
};
const substations = await buildSubstations();
const substationSnapshot = {
  ...meta("Pune power substations", "power=substation, named or rated 22 kV and above"),
  estimates: "Locations, names, operators and voltages are from OpenStreetMap; transformers and their telemetry are synthetic (not public).",
  items: substations,
};

for (const f of ["data/real/pune-hospitals.json", "services/hospital-service/src/data/pune-hospitals.json", "services/ambulance-service/src/data/pune-hospitals.json", "services/blood-bank-service/src/main/resources/data/pune-hospitals.json"]) {
  write(f, hospitalSnapshot);
}
for (const f of ["data/real/pune-substations.json", "services/power-service/src/main/resources/data/pune-substations.json"]) {
  write(f, substationSnapshot);
}
