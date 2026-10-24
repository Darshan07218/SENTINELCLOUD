import {
  calculateHospitalCapacity,
  computeHospitalAlerts,
  haversineDistanceKm,
  boundingBoxForRadius,
} from "./capacity.js";

/**
 * A hospital's public API representation always includes its computed
 * capacity percentages and current alerts alongside the raw counts —
 * every consumer (frontend dashboard, other services in a later phase)
 * gets the same derived numbers instead of recomputing them
 * independently and risking drift.
 */
function enrich(hospital) {
  return {
    ...hospital,
    capacity: calculateHospitalCapacity(hospital),
    alerts: computeHospitalAlerts(hospital),
  };
}

export function createHospitalService({ hospitalRepository, publishEvent, outbox, transaction }) {
  /** The hospital.capacity.alert payload, or null when there's nothing to alert. */
  function alertPayload(hospital) {
    const alerts = computeHospitalAlerts(hospital);
    if (alerts.length === 0) return null;
    return { hospitalId: hospital.id, hospitalName: hospital.name, alerts, capacity: calculateHospitalCapacity(hospital) };
  }

  /**
   * Without an outbox (unit tests), publishing is best-effort: a hospital
   * update must succeed even if RabbitMQ happens to be unreachable at that
   * instant, so a failed publish is only logged.
   */
  async function publishIfAlertWorthy(hospital) {
    const payload = hospital && alertPayload(hospital);
    if (!payload || !publishEvent) return;
    try {
      await publishEvent("hospital.capacity.alert", payload);
    } catch (err) {
      console.warn("[hospital-service] failed to publish capacity alert event:", err.message);
    }
  }

  /**
   * Runs write(repository) and raises a capacity alert if the result needs
   * one. Phase 14: with the outbox (index.js), the change and its alert
   * commit together and the relay delivers it, so an alert is no longer
   * lost when RabbitMQ is briefly down.
   */
  async function saveAndAlert(write) {
    if (outbox && transaction) {
      let queued = false;
      const hospital = await transaction(async ({ hospitalRepository: repo, client }) => {
        const row = await write(repo);
        const payload = row && alertPayload(row);
        if (payload) {
          await outbox.enqueue(client, "hospital.capacity.alert", payload);
          queued = true;
        }
        return row;
      });
      if (queued) outbox.kick();
      return hospital;
    }
    const hospital = await write(hospitalRepository);
    await publishIfAlertWorthy(hospital);
    return hospital;
  }

  return {
    async registerHospital(data, ownerUserId) {
      const hospital = await saveAndAlert((repo) => repo.create(data, ownerUserId));
      return enrich(hospital);
    },

    async getHospital(id) {
      const hospital = await hospitalRepository.findById(id);
      return hospital ? enrich(hospital) : null;
    },

    async listHospitals({ page, limit }) {
      const { hospitals, total } = await hospitalRepository.list({ page, limit });
      return {
        hospitals: hospitals.map(enrich),
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      };
    },

    /**
     * Coarse bounding-box query from the repository (uses the
     * (latitude, longitude) index), narrowed to an exact radius with
     * Haversine distance, then sorted nearest-first. See
     * services/capacity.js for why this project computes distance in
     * application code rather than requiring a geospatial database
     * extension at this scale.
     */
    async findHospitalsNear(lat, lng, radiusKm) {
      const box = boundingBoxForRadius(lat, lng, radiusKm);
      const candidates = await hospitalRepository.findWithinBoundingBox(box);
      return candidates
        .map((h) => ({ ...h, distanceKm: Math.round(haversineDistanceKm(lat, lng, h.latitude, h.longitude) * 10) / 10 }))
        .filter((h) => h.distanceKm <= radiusKm)
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .map((h) => ({ ...enrich(h), distanceKm: h.distanceKm }));
    },

    async getSummary() {
      return hospitalRepository.summary();
    },

    async findHospitalsWithIcuAvailable() {
      const hospitals = await hospitalRepository.findWithIcuAvailable();
      return hospitals.map(enrich);
    },

    /**
     * Every hospital's computed alerts, flattened into one list for
     * the "capacity alerts" / dashboard-wide view. Sorted CRITICAL
     * first so the most urgent items are always at the top regardless
     * of hospital name ordering.
     */
    async generateCapacityAlerts() {
      const hospitals = await hospitalRepository.findAllForAlerts();
      const severityRank = { CRITICAL: 0, WARNING: 1 };
      return hospitals
        .flatMap((h) => computeHospitalAlerts(h).map((alert) => ({ ...alert, hospitalId: h.id, hospitalName: h.name })))
        .sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
    },

    /**
     * Applies a partial profile update, with one extra invariant the
     * Zod schema can't express on its own (it doesn't have access to
     * the hospital's *current* row): if totalBeds/totalIcuBeds/
     * totalVentilators is being lowered, it can never drop below the
     * currently available count for that same category — you can't
     * shrink total capacity to less than what's already sitting empty
     * and available.
     */
    async updateHospitalProfile(id, fields) {
      const current = await hospitalRepository.findById(id);
      if (!current) return null;

      const invariantChecks = [
        ["totalBeds", "availableBeds"],
        ["totalIcuBeds", "availableIcuBeds"],
        ["totalVentilators", "availableVentilators"],
      ];
      for (const [totalKey, availableKey] of invariantChecks) {
        if (fields[totalKey] !== undefined && fields[totalKey] < current[availableKey]) {
          const err = new Error(
            `${totalKey} cannot be reduced below the current ${availableKey} (${current[availableKey]}). Update ${availableKey} first.`
          );
          err.statusCode = 409;
          err.code = "CAPACITY_INVARIANT_VIOLATION";
          throw err;
        }
      }

      const updated = await saveAndAlert((repo) => repo.updateProfile(id, fields));
      return enrich(updated);
    },

    async updateAvailableBeds(id, availableBeds) {
      const current = await hospitalRepository.findById(id);
      if (!current) return null;
      if (availableBeds > current.totalBeds) {
        const err = new Error(`availableBeds (${availableBeds}) cannot exceed totalBeds (${current.totalBeds}).`);
        err.statusCode = 409;
        err.code = "CAPACITY_INVARIANT_VIOLATION";
        throw err;
      }
      const updated = await saveAndAlert((repo) => repo.updateAvailableBeds(id, availableBeds));
      return enrich(updated);
    },

    async updateAvailableIcuBeds(id, availableIcuBeds) {
      const current = await hospitalRepository.findById(id);
      if (!current) return null;
      if (availableIcuBeds > current.totalIcuBeds) {
        const err = new Error(
          `availableIcuBeds (${availableIcuBeds}) cannot exceed totalIcuBeds (${current.totalIcuBeds}).`
        );
        err.statusCode = 409;
        err.code = "CAPACITY_INVARIANT_VIOLATION";
        throw err;
      }
      const updated = await saveAndAlert((repo) => repo.updateAvailableIcuBeds(id, availableIcuBeds));
      return enrich(updated);
    },

    async updateAvailableVentilators(id, availableVentilators) {
      const current = await hospitalRepository.findById(id);
      if (!current) return null;
      if (availableVentilators > current.totalVentilators) {
        const err = new Error(
          `availableVentilators (${availableVentilators}) cannot exceed totalVentilators (${current.totalVentilators}).`
        );
        err.statusCode = 409;
        err.code = "CAPACITY_INVARIANT_VIOLATION";
        throw err;
      }
      const updated = await saveAndAlert((repo) => repo.updateAvailableVentilators(id, availableVentilators));
      return enrich(updated);
    },

    async setOverloaded(id, overloaded) {
      const current = await hospitalRepository.findById(id);
      if (!current) return null;
      const status = overloaded ? "OVERLOADED" : "NORMAL";
      const updated = await saveAndAlert((repo) => repo.setEmergencyStatus(id, status));
      return enrich(updated);
    },
  };
}
