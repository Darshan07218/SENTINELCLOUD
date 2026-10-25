/** Great-circle distance in km (same formula as hospital-service's capacity.js). */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
}

export const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

export function severityRank(s) {
  return SEVERITIES.indexOf(s);
}

/** One step less severe (LOW stays LOW). */
export function downgrade(s) {
  return SEVERITIES[Math.max(0, severityRank(s) - 1)];
}
