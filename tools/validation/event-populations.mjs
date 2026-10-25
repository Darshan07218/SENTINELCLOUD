#!/usr/bin/env node
/**
 * Phase 22: population inside each historical event's circle, from the
 * WorldPop 2020 1 km grid for all of India, counted with the SAME
 * populationWithin() the live impact estimate uses. Writes population2020
 * into tools/validation/events.json, so the validation itself
 * (validate-casualty-model.mjs) needs neither GDAL nor the 19 MB file.
 *
 *   node tools/validation/event-populations.mjs <path to ind_ppp_2020_1km_Aggregated.tif>
 *
 * Needs Docker (GDAL runs in ghcr.io/osgeo/gdal:alpine-small-3.9.2).
 */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { populationWithin, POPULATION_ZONES } from "../../services/response-service/src/impact.js";
import { eventInputs } from "./model.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVENTS = path.join(HERE, "events.json");
const tif = process.argv[2];
if (!tif) {
  console.error("usage: node tools/validation/event-populations.mjs <ind_ppp_2020_1km_Aggregated.tif>");
  process.exit(2);
}
const dir = path.dirname(path.resolve(tif)).replace(/\\/g, "/");
const file = path.basename(tif);

function readAscGrid(p) {
  const lines = readFileSync(p, "utf8").split(/\r?\n/);
  const h = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const m = lines[i].match(/^\s*([a-zA-Z_]+)\s+(-?[\d.eE+-]+)\s*$/);
    if (!m) break;
    h[m[1].toLowerCase()] = Number(m[2]);
  }
  const values = [];
  for (; i < lines.length; i++) for (const t of lines[i].trim().split(/\s+/)) if (t !== "") values.push(Number(t) > 0 ? Number(t) : 0);
  return { north: h.yllcorner + h.nrows * h.cellsize, west: h.xllcorner, cellDeg: h.cellsize, rows: h.nrows, cols: h.ncols, values };
}

const doc = JSON.parse(readFileSync(EVENTS, "utf8"));
for (const ev of doc.events) {
  const { radiusKm } = eventInputs(ev);
  const dLat = radiusKm / 111 + 0.05;
  const dLng = radiusKm / (111 * Math.cos((ev.latitude * Math.PI) / 180)) + 0.05;
  const out = `ev-${ev.id}.asc`;
  const r = spawnSync(
    "docker",
    ["run", "--rm", "-v", `${dir}:/data`, "ghcr.io/osgeo/gdal:alpine-small-3.9.2", "gdal_translate", "-q", "-projwin",
      String(ev.longitude - dLng), String(ev.latitude + dLat), String(ev.longitude + dLng), String(ev.latitude - dLat),
      "-of", "AAIGrid", `/data/${file}`, `/data/${out}`],
    { encoding: "utf8" }
  );
  if (r.status !== 0) throw new Error(`gdal_translate failed for ${ev.id}: ${r.stderr}`);
  const grid = readAscGrid(path.join(dir, out));
  ev.population2020 = populationWithin(ev.latitude, ev.longitude, radiusKm, POPULATION_ZONES, grid);
  for (const f of [out, out.replace(/\.asc$/, ".prj"), `${out}.aux.xml`]) {
    try {
      unlinkSync(path.join(dir, f));
    } catch {
      /* not created */
    }
  }
  console.log(`${ev.id.padEnd(22)} radius ${String(radiusKm).padStart(5)} km  population (2020) ${ev.population2020.toLocaleString("en-IN")}`);
}
doc.populationMethod = "WorldPop 2020 1 km grid for India (CC BY 4.0), counted with services/response-service/src/impact.js populationWithin() inside each event's radius";
writeFileSync(EVENTS, JSON.stringify(doc, null, 2) + "\n");
console.log("updated tools/validation/events.json");
