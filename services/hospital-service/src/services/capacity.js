// Below this fraction of available beds, a hospital is alert-worthy
// even if nobody has explicitly marked it OVERLOADED.
const LOW_BED_AVAILABILITY_RATIO = 0.1;
// Beds between LOW and this ratio are "watch" — not yet an alert, but
// surfaced distinctly in the capacity percentage the frontend shows.
const ELEVATED_BED_AVAILABILITY_RATIO = 0.25;

const EARTH_RADIUS_KM = 6371;

/**
 * Occupancy percentage for beds — the single number the dashboard's
 * "capacity percentage" stat is built from. 0% = empty, 100% = full.
 * A hospital with totalBeds = 0 is treated as 0% occupied rather than
 * dividing by zero (an unopened/decommissioned bed category isn't
 * "full").
 */
export function calculateOccupancyPercentage(total, available) {
  if (total <= 0) return 0;
  const occupied = total - available;
  return Math.round((occupied / total) * 1000) / 10; // one decimal place
}

export function calculateHospitalCapacity(hospital) {
  return {
    beds: calculateOccupancyPercentage(hospital.totalBeds, hospital.availableBeds),
    icuBeds: calculateOccupancyPercentage(hospital.totalIcuBeds, hospital.availableIcuBeds),
    ventilators: calculateOccupancyPercentage(hospital.totalVentilators, hospital.availableVentilators),
  };
}

/**
 * Computes the alert list for a single hospital. Returns [] when
 * everything is fine. Each alert has a `severity` of "WARNING" or
 * "CRITICAL" and a machine-readable `type` so the frontend can render
 * an icon/color without parsing the message text.
 */
export function computeHospitalAlerts(hospital) {
  const alerts = [];

  if (hospital.emergencyStatus === "OVERLOADED") {
    alerts.push({
      type: "OVERLOADED",
      severity: "CRITICAL",
      message: `${hospital.name} has been flagged as overloaded.`,
    });
  }

  const bedRatio = hospital.totalBeds > 0 ? hospital.availableBeds / hospital.totalBeds : 1;
  if (bedRatio < LOW_BED_AVAILABILITY_RATIO) {
    alerts.push({
      type: "LOW_BED_AVAILABILITY",
      severity: "CRITICAL",
      message: `${hospital.name} has only ${hospital.availableBeds} of ${hospital.totalBeds} beds available.`,
    });
  } else if (bedRatio < ELEVATED_BED_AVAILABILITY_RATIO) {
    alerts.push({
      type: "LOW_BED_AVAILABILITY",
      severity: "WARNING",
      message: `${hospital.name} bed availability is getting low (${hospital.availableBeds}/${hospital.totalBeds}).`,
    });
  }

  if (hospital.totalIcuBeds > 0 && hospital.availableIcuBeds === 0) {
    alerts.push({
      type: "NO_ICU_AVAILABLE",
      severity: "CRITICAL",
      message: `${hospital.name} has no available ICU beds.`,
    });
  }

  if (hospital.totalVentilators > 0 && hospital.availableVentilators === 0) {
    alerts.push({
      type: "NO_VENTILATORS_AVAILABLE",
      severity: "CRITICAL",
      message: `${hospital.name} has no available ventilators.`,
    });
  }

  return alerts;
}

/**
 * Great-circle distance between two lat/lng points, in kilometers.
 * Used to turn the repository's coarse bounding-box pre-filter into an
 * exact "within radiusKm" result for GET /hospitals/near.
 */
export function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const h = Math.min(1, Math.max(0, a)); // float error can push a past 1 for antipodal points
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_KM * c;
}

/**
 * A generous bounding box (in degrees) around (lat, lng) that is
 * guaranteed to contain every point within radiusKm — used to cheaply
 * shrink the candidate set with an indexed range query before the
 * exact Haversine cutoff is applied. Longitude degrees shrink toward
 * the poles, so we widen the longitude delta by 1/cos(latitude); this
 * intentionally over-includes near the poles rather than risk
 * excluding a real match — the precise filter afterward removes any
 * false positives.
 */
export function boundingBoxForRadius(lat, lng, radiusKm) {
  const latDelta = radiusKm / 111; // ~111 km per degree of latitude
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
