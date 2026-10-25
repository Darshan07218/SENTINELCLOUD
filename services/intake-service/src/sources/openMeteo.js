/**
 * Phase 19: rain and wind from the Open-Meteo forecast API (free, no key):
 * https://open-meteo.com/en/docs
 *
 * Every poll reads the next 24 hours for the city centre and applies the
 * India Meteorological Department's rainfall categories and the Beaufort
 * wind bands:
 *
 *   rain in 24 h  ≥ 64.5 mm heavy → FLOOD MEDIUM, ≥ 115.6 very heavy → HIGH,
 *                 ≥ 204.5 extremely heavy → CRITICAL
 *   gusts         ≥ 62 km/h gale → CYCLONE MEDIUM, ≥ 89 storm → HIGH,
 *                 ≥ 118 hurricane force → CRITICAL
 *
 * One detection per kind, day and severity (the external id carries all
 * three): a worsening forecast raises a new, more severe detection; the
 * same forecast polled again is a duplicate and ignored.
 */
export const OPEN_METEO_DEFAULT_URL = "https://api.open-meteo.com/v1/forecast";
export const WEATHER_RADIUS_KM = 25;

export const RAIN_BANDS = [
  { mm: 204.5, severity: "CRITICAL", label: "extremely heavy" },
  { mm: 115.6, severity: "HIGH", label: "very heavy" },
  { mm: 64.5, severity: "MEDIUM", label: "heavy" },
];
export const GUST_BANDS = [
  { kmh: 118, severity: "CRITICAL", label: "hurricane-force" },
  { kmh: 89, severity: "HIGH", label: "storm-force" },
  { kmh: 62, severity: "MEDIUM", label: "gale-force" },
];

export function openMeteoUrl(base, { latitude, longitude }) {
  const qs = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    hourly: "precipitation,wind_gusts_10m",
    forecast_hours: "24",
    timezone: "UTC",
  });
  return `${base}?${qs}`;
}

/** The 24-hour totals the page shows even when nothing is detected. */
export function summarise(forecast) {
  const hourly = forecast?.hourly || {};
  const rain = (hourly.precipitation || []).filter(Number.isFinite);
  const gusts = (hourly.wind_gusts_10m || []).filter(Number.isFinite);
  return {
    rain24hMm: Math.round(rain.reduce((a, b) => a + b, 0) * 10) / 10,
    maxGustKmh: gusts.length ? Math.round(Math.max(...gusts)) : 0,
    hours: rain.length,
    startsAt: Array.isArray(hourly.time) && hourly.time[0] ? `${hourly.time[0]}Z`.replace("ZZ", "Z") : null,
  };
}

/** Forecast JSON → { summary, detections }. watch: { latitude, longitude, name } */
export function parseOpenMeteo(forecast, watch, { now = new Date() } = {}) {
  const summary = summarise(forecast);
  const day = (summary.startsAt ? new Date(summary.startsAt) : now).toISOString().slice(0, 10);
  const where = watch.name || "the city";
  const detections = [];

  const rain = RAIN_BANDS.find((b) => summary.rain24hMm >= b.mm);
  if (rain) {
    detections.push({
      source: "OPEN_METEO",
      externalId: `flood:${day}:${rain.severity}`,
      type: "FLOOD",
      severity: rain.severity,
      latitude: watch.latitude,
      longitude: watch.longitude,
      radiusKm: WEATHER_RADIUS_KM,
      title: `${summary.rain24hMm} mm of rain forecast in 24 h (${rain.label})`,
      description: `Forecast: ${summary.rain24hMm} mm of rain over ${where} in the next 24 hours, ${rain.label} rainfall by IMD categories; flooding likely (Open-Meteo).`,
      observedAt: now.toISOString(),
      details: { rain24hMm: summary.rain24hMm, thresholdMm: rain.mm },
    });
  }

  const gust = GUST_BANDS.find((b) => summary.maxGustKmh >= b.kmh);
  if (gust) {
    detections.push({
      source: "OPEN_METEO",
      externalId: `wind:${day}:${gust.severity}`,
      type: "CYCLONE",
      severity: gust.severity,
      latitude: watch.latitude,
      longitude: watch.longitude,
      radiusKm: WEATHER_RADIUS_KM,
      title: `Gusts up to ${summary.maxGustKmh} km/h forecast (${gust.label})`,
      description: `Forecast: wind gusts up to ${summary.maxGustKmh} km/h over ${where} in the next 24 hours, ${gust.label} (Open-Meteo).`,
      observedAt: now.toISOString(),
      details: { maxGustKmh: summary.maxGustKmh, thresholdKmh: gust.kmh },
    });
  }

  return { summary, detections };
}
