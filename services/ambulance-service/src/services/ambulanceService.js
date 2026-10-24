import { estimateRoute, boundingBoxForRadius, haversineDistanceKm } from "./routing.js";
import { isValidStatusTransition, getAllowedNextStatuses } from "./statusMachine.js";

function conflictError(message, code = "CONFLICT") {
  const err = new Error(message);
  err.statusCode = 409;
  err.code = code;
  return err;
}

/** Two concurrent registrations of the same plate both pass the
 *  findByVehicleNumber pre-check; the UNIQUE constraint (23505) is the
 *  real guard, so map it to the same 409 instead of a 500. */
async function mapUniqueViolation(promise, vehicleNumber) {
  try {
    return await promise;
  } catch (err) {
    if (err && err.code === "23505") {
      throw conflictError(`Vehicle number '${vehicleNumber}' is already registered.`, "VEHICLE_NUMBER_TAKEN");
    }
    throw err;
  }
}

export function createAmbulanceService({ ambulanceRepository }) {
  return {
    async registerAmbulance(data) {
      const existing = await ambulanceRepository.findByVehicleNumber(data.vehicleNumber);
      if (existing) {
        throw conflictError(`Vehicle number '${data.vehicleNumber}' is already registered.`, "VEHICLE_NUMBER_TAKEN");
      }
      return mapUniqueViolation(ambulanceRepository.create(data), data.vehicleNumber);
    },

    async getAmbulance(id) {
      return ambulanceRepository.findById(id);
    },

    async listAmbulances({ page, limit, status }) {
      const { ambulances, total } = await ambulanceRepository.list({ page, limit, status });
      return {
        ambulances,
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      };
    },

    async updateAmbulanceProfile(id, fields) {
      const current = await ambulanceRepository.findById(id);
      if (!current) return null;
      if (fields.vehicleNumber && fields.vehicleNumber !== current.vehicleNumber) {
        const existing = await ambulanceRepository.findByVehicleNumber(fields.vehicleNumber);
        if (existing) {
          throw conflictError(`Vehicle number '${fields.vehicleNumber}' is already registered.`, "VEHICLE_NUMBER_TAKEN");
        }
      }
      return mapUniqueViolation(ambulanceRepository.updateProfile(id, fields), fields.vehicleNumber);
    },

    async updateLocation(id, latitude, longitude) {
      const current = await ambulanceRepository.findById(id);
      if (!current) return null;
      return ambulanceRepository.updateLocation(id, latitude, longitude);
    },

    async changeStatus(id, newStatus) {
      const current = await ambulanceRepository.findById(id);
      if (!current) return null;
      if (!isValidStatusTransition(current.status, newStatus)) {
        throw conflictError(
          `Cannot transition ambulance from ${current.status} to ${newStatus}. Allowed next states: ${
            getAllowedNextStatuses(current.status).join(", ") || "(none)"
          }.`,
          "INVALID_STATUS_TRANSITION"
        );
      }
      return ambulanceRepository.updateStatus(id, newStatus);
    },

    async assignHospital(id, hospitalId) {
      const current = await ambulanceRepository.findById(id);
      if (!current) return null;
      return ambulanceRepository.assignHospital(id, hospitalId);
    },

    async findNearestAvailable(lat, lng, { radiusKm, limit, equipmentLevel }) {
      const box = boundingBoxForRadius(lat, lng, radiusKm);
      const candidates = await ambulanceRepository.findAvailableWithinBoundingBox({ ...box, equipmentLevel });

      return candidates
        .filter((a) => haversineDistanceKm(lat, lng, a.latitude, a.longitude) <= radiusKm) // straight-line radius
        .map((a) => ({ ambulance: a, route: estimateRoute(lat, lng, a.latitude, a.longitude) }))
        .sort((a, b) => a.route.distanceKm - b.route.distanceKm)
        .slice(0, limit)
        .map((c) => ({ ...c.ambulance, distanceKm: c.route.distanceKm, etaMinutes: c.route.etaMinutes }));
    },

    async getFleetSummary() {
      const counts = await ambulanceRepository.countByStatus();
      const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
      return {
        totalAmbulances: total,
        available: counts.AVAILABLE || 0,
        dispatched: counts.DISPATCHED || 0,
        enRoute: counts.EN_ROUTE || 0,
        atScene: counts.AT_SCENE || 0,
        transporting: counts.TRANSPORTING || 0,
        atHospital: counts.AT_HOSPITAL || 0,
        outOfService: counts.OUT_OF_SERVICE || 0,
      };
    },
  };
}
