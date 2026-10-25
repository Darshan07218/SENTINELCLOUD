#!/usr/bin/env node
/**
 * Phase 21: the population grid the impact estimate uses
 * (docs/PHASE-21-REAL-DATA.md §2).
 *
 * Input: WorldPop "Global per-country 2000–2020, 1 km aggregated" for India,
 * year 2020 (ind_ppp_2020_1km_Aggregated.tif, people per ~1 km cell), cropped
 * to about ±1° around Pune with GDAL and written as an ESRI ASCII grid:
 *
 *   curl -o ind.tif https://data.worldpop.org/GIS/Population/Global_2000_2020_1km/2020/IND/ind_ppp_2020_1km_Aggregated.tif
 *   docker run --rm -v "$PWD:/data" ghcr.io/osgeo/gdal:alpine-small-3.9.2 \
 *     gdal_translate -projwin 72.85 19.52 74.86 17.51 -of AAIGrid /data/ind.tif /data/pune.asc
 *   node tools/real-data/build-population.mjs pune.asc
 *
 * Output: data/real/pune-population-worldpop-2020-1km.json (+ the copy
 * response-service loads): row-major whole-people counts per cell, north to
 * south, west to east, with the grid's origin and cell size.
 *
 * Data: WorldPop (www.worldpop.org), CC BY 4.0. Please cite: WorldPop and
 * CIESIN, Columbia University (2018). Global High Resolution Population
 * Denominators Project. doi:10.5258/SOTON/WP00671
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const input = process.argv[2];
if (!input) {
  console.error("usage: node tools/real-data/build-population.mjs <cropped .asc grid>");
  process.exit(2);
}

const lines = readFileSync(input, "utf8").split(/\r?\n/);
const header = {};
let i = 0;
for (; i < lines.length; i++) {
  const m = lines[i].match(/^\s*([a-zA-Z_]+)\s+(-?[\d.eE+-]+)\s*$/);
  if (!m) break;
  header[m[1].toLowerCase()] = Number(m[2]);
}
const cols = header.ncols;
const rows = header.nrows;
const cell = header.cellsize;
const noData = header.nodata_value ?? -99999;
const west = header.xllcorner ?? header.xllcenter - cell / 2;
const south = header.yllcorner ?? header.yllcenter - cell / 2;
if (!cols || !rows || !cell) throw new Error("not an ESRI ASCII grid");

const values = [];
for (; i < lines.length && values.length < rows * cols; i++) {
  for (const t of lines[i].trim().split(/\s+/)) {
    if (t === "") continue;
    const v = Number(t);
    values.push(!Number.isFinite(v) || v === noData || v < 0 ? 0 : Math.round(v));
  }
}
if (values.length !== rows * cols) throw new Error(`expected ${rows * cols} cells, read ${values.length}`);

const total = values.reduce((a, b) => a + b, 0);
const snapshot = {
  dataset: "Population per ~1 km cell, around Pune",
  source: "WorldPop, Global per-country 2000–2020 (1 km aggregated, unconstrained), India, year 2020",
  url: "https://data.worldpop.org/GIS/Population/Global_2000_2020_1km/2020/IND/ind_ppp_2020_1km_Aggregated.tif",
  license: "CC BY 4.0; WorldPop (www.worldpop.org) and CIESIN, Columbia University (2018), doi:10.5258/SOTON/WP00671",
  builtAt: new Date().toISOString(),
  north: Math.round((south + rows * cell) * 1e6) / 1e6,
  west: Math.round(west * 1e6) / 1e6,
  cellDeg: cell,
  rows,
  cols,
  totalPeople: total,
  values,
};

for (const f of ["data/real/pune-population-worldpop-2020-1km.json", "services/response-service/src/data/pune-population-worldpop-2020-1km.json"]) {
  const full = path.join(ROOT, f);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(snapshot) + "\n");
  console.log(`wrote ${f}: ${rows} × ${cols} cells of ${cell}°, ${total.toLocaleString("en-IN")} people`);
}
