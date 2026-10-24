// Pure geo math, no dependencies — identical approach to
// hospital-service's/ambulance-service's own copies of the same three
// functions (see services/capacity.js and services/routing.js there
// for the full rationale on why this project computes distance in
// application code rather than requiring a geospatial DB extension).

const EARTH_RADIUS_KM = 6371;

export function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const h = Math.min(1, Math.max(0, a)); // float error can push a past 1 for antipodal points
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_KM * c;
}

export function boundingBoxForRadius(lat, lng, radiusKm) {
  const latDelta = radiusKm / 111;
  const minLat = Math.max(lat - latDelta, -90);
  const maxLat = Math.min(lat + latDelta, 90);
  // Near a pole, or when the box would cross the ±180° meridian, a single
  // [minLng, maxLng] range can't describe it: search every longitude (a
  // correct superset — the exact Haversine check filters afterwards).
  const lngDivisor = Math.cos((lat * Math.PI) / 180);
  const lngDelta = lngDivisor > 0.01 ? radiusKm / (111 * lngDivisor) : 360;
  if (minLat === -90 || maxLat === 90 || lng - lngDelta < -180 || lng + lngDelta > 180) {
    return { minLat, maxLat, minLng: -180, maxLng: 180 };
  }
  return { minLat, maxLat, minLng: lng - lngDelta, maxLng: lng + lngDelta };
}
