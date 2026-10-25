/**
 * Phase 19: earthquakes from the USGS real-time feed (GeoJSON, free, no key):
 * https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php
 *
 * Every quake in the feed within the watch radius of the city and at least
 * the minimum magnitude becomes a candidate EARTHQUAKE detection:
 *
 *   severity by magnitude: ≥ 6.5 CRITICAL, ≥ 5.5 HIGH, ≥ 4.5 MEDIUM, else LOW;
 *            one step lower when the epicentre is more than 250 km away.
 *   affected radius: roughly where it is felt, 15 km at M3 doubling per
 *            magnitude (60 km at M5, 240 km at M7), capped at 500 km.
 *
 * The detection is placed at the epicentre: a quake far from the city then
 * correctly finds few or no facilities inside its radius.
 */
import { haversineKm, downgrade } from "./geo.js";

export const USGS_DEFAULT_FEED = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson";

export function earthquakeSeverity(magnitude, distanceKm) {
  let severity = magnitude >= 6.5 ? "CRITICAL" : magnitude >= 5.5 ? "HIGH" : magnitude >= 4.5 ? "MEDIUM" : "LOW";
  if (distanceKm > 250) severity = downgrade(severity);
  return severity;
}

export function feltRadiusKm(magnitude) {
  return Math.round(Math.min(500, Math.max(5, 15 * 2 ** (magnitude - 3))));
}

/**
 * GeoJSON FeatureCollection → candidate detections.
 * watch: { latitude, longitude, radiusKm, minMagnitude }
 */
export function parseUsgsFeed(geojson, watch) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const detections = [];
  for (const f of features) {
    const [lng, lat, depthKm] = f?.geometry?.coordinates || [];
    const mag = f?.properties?.mag;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(mag) || typeof f.id !== "string") continue;
    if (f.properties.type && f.properties.type !== "earthquake") continue; // quarry blasts, explosions…
    if (mag < watch.minMagnitude) continue;
    const distanceKm = haversineKm(watch.latitude, watch.longitude, lat, lng);
    if (distanceKm > watch.radiusKm) continue;
    const place = String(f.properties.place || "unknown location").slice(0, 160);
    detections.push({
      source: "USGS",
      externalId: f.id.slice(0, 100),
      type: "EARTHQUAKE",
      severity: earthquakeSeverity(mag, distanceKm),
      latitude: lat,
      longitude: lng,
      radiusKm: feltRadiusKm(mag),
      title: `M${mag.toFixed(1)} earthquake, ${place}`,
      description: `M${mag.toFixed(1)} earthquake ${place}, ${Math.round(distanceKm)} km from the city centre, depth ${Number.isFinite(depthKm) ? Math.round(depthKm) : "?"} km (USGS ${f.id}).`,
      observedAt: Number.isFinite(f.properties.time) ? new Date(f.properties.time).toISOString() : new Date().toISOString(),
      details: { magnitude: mag, depthKm: Number.isFinite(depthKm) ? depthKm : null, distanceKm: Math.round(distanceKm), url: f.properties.url || null },
    });
  }
  return detections;
}
