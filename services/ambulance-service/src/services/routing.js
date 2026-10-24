const EARTH_RADIUS_KM = 6371;

// Real road networks are longer than a straight line between two
// points — this factor approximates that gap for a typical mixed
// urban/suburban road network. 1.3 (i.e. "roads are ~30% longer than
// straight-line distance") is a commonly cited rule-of-thumb detour
// index for city routing; a real system would replace this with an
// actual routing engine (OSRM, Google Directions, etc.) querying live
// road geometry, but that requires a paid API or a substantial map-data
// dependency this project deliberately avoids (see docs/ARCHITECTURE.md
// "no paid cloud services" principle) — this is documented here as the
// approximation it is, not presented as precise routing.
const ROAD_DISTANCE_FACTOR = 1.3;

// Average achievable speed for an emergency vehicle with lights/sirens
// active, net of traffic, stops, and turns — faster than ordinary
// urban traffic (~25-30 km/h) but well short of open-road speed.
const EMERGENCY_AVERAGE_SPEED_KMPH = 55;

// Fixed "turnout time": the average time between a dispatch order
// being issued and the ambulance actually pulling out (crew getting to
// the vehicle, confirming the call, pulling out of the bay). This is a
// real, well-documented component of total EMS response time that a
// pure distance/speed calculation would otherwise ignore entirely.
const DISPATCH_TURNOUT_SECONDS = 90;

/**
 * Great-circle distance between two lat/lng points, in kilometers.
 */
export function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  // Floating-point error can push `a` a hair above 1 for antipodal
  // points, which would make Math.sqrt(1 - a) NaN.
  const clamped = Math.min(1, Math.max(0, a));
  const c = 2 * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));
  return EARTH_RADIUS_KM * c;
}

/**
 * Estimated on-road distance between two points — the straight-line
 * (Haversine) distance adjusted by ROAD_DISTANCE_FACTOR. This is the
 * "realistic route-distance algorithm" this service uses in place of a
 * full routing engine: documented, explainable, and good enough to
 * rank candidate ambulances sensibly without an external dependency.
 */
export function calculateRoadDistanceKm(lat1, lng1, lat2, lng2) {
  return haversineDistanceKm(lat1, lng1, lat2, lng2) * ROAD_DISTANCE_FACTOR;
}

/**
 * Estimated response time in minutes: turnout time plus drive time at
 * the assumed emergency-vehicle average speed, for the given road
 * distance.
 */
export function calculateEstimatedResponseTimeMinutes(roadDistanceKm) {
  const driveTimeMinutes = (roadDistanceKm / EMERGENCY_AVERAGE_SPEED_KMPH) * 60;
  const turnoutMinutes = DISPATCH_TURNOUT_SECONDS / 60;
  return Math.round((driveTimeMinutes + turnoutMinutes) * 10) / 10;
}

/**
 * Combines the two functions above into one call — what the dispatch
 * ranking and "nearest ambulance" search actually use.
 */
export function estimateRoute(fromLat, fromLng, toLat, toLng) {
  const roadDistanceKm = Math.round(calculateRoadDistanceKm(fromLat, fromLng, toLat, toLng) * 10) / 10;
  return {
    distanceKm: roadDistanceKm,
    etaMinutes: calculateEstimatedResponseTimeMinutes(roadDistanceKm),
  };
}

/**
 * A generous bounding box (in degrees) around (lat, lng) guaranteed to
 * contain every point within radiusKm — same coarse-prefilter pattern
 * used in hospital-service's capacity.js, kept independent here since
 * each microservice in this project owns its own code rather than
 * sharing a library across service boundaries.
 */
export function boundingBoxForRadius(lat, lng, radiusKm) {
  const latDelta = radiusKm / 111;
  const minLat = Math.max(lat - latDelta, -90);
  const maxLat = Math.min(lat + latDelta, 90);
  // Near a pole, or when the box would cross the ±180° meridian, a
  // simple [minLng, maxLng] range can't describe it — fall back to every
  // longitude. Still a correct (superset) prefilter: the exact Haversine
  // check that follows does the real filtering.
  const lngDivisor = Math.cos((lat * Math.PI) / 180);
  const lngDelta = lngDivisor > 0.01 ? radiusKm / (111 * lngDivisor) : 360;
  if (minLat === -90 || maxLat === 90 || lng - lngDelta < -180 || lng + lngDelta > 180) {
    return { minLat, maxLat, minLng: -180, maxLng: 180 };
  }
  return { minLat, maxLat, minLng: lng - lngDelta, maxLng: lng + lngDelta };
}

