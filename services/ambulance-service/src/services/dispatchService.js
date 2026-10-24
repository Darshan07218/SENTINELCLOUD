import { estimateRoute, boundingBoxForRadius, haversineDistanceKm } from "./routing.js";

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  err.code = "NOT_FOUND";
  return err;
}

function conflictError(message, code = "CONFLICT") {
  const err = new Error(message);
  err.statusCode = 409;
  err.code = code;
  return err;
}

const AUTO_DISPATCH_SEARCH_RADIUS_KM = 50;

/**
 * `transaction(fn)` runs fn({ ambulanceRepository, emergencyRepository })
 * with repositories bound to one transaction (see index.js). Optional so
 * unit tests can wire the service without a real pool; the conditional
 * UPDATEs in the repositories still prevent double-dispatch without it,
 * the transaction adds all-or-nothing for the two-table writes.
 */
export function createDispatchService({ ambulanceRepository, emergencyRepository, publishEvent, transaction, outbox }) {
  const inTransaction = transaction || ((fn) => fn({ ambulanceRepository, emergencyRepository }));

  async function publishBestEffort(routingKey, payload) {
    if (!publishEvent) return;
    try {
      await publishEvent(routingKey, payload);
    } catch (err) {
      console.warn(`[ambulance-service] failed to publish ${routingKey} event:`, err.message);
    }
  }

  /**
   * Phase 14: runs fn in a transaction whose context also has
   * emit(routingKey, payload). With the outbox (index.js passes one), emit
   * writes the event on the transaction's own connection, so the dispatch
   * and its event commit together; the relay is kicked after the commit.
   * Without it (unit tests), events are published best-effort after the
   * commit, as before Phase 14.
   */
  async function withEvents(fn) {
    const deferred = [];
    const result = await inTransaction(async (tx) => {
      const emit = async (routingKey, payload) => {
        if (outbox && tx.client) await outbox.enqueue(tx.client, routingKey, payload);
        else deferred.push([routingKey, payload]);
      };
      return fn({ ...tx, emit });
    });
    if (outbox && transaction) outbox.kick();
    for (const [routingKey, payload] of deferred) await publishBestEffort(routingKey, payload);
    return result;
  }

  /** An event with no accompanying change (e.g. "no ambulance in range"). */
  function emitStandalone(routingKey, payload) {
    return withEvents(({ emit }) => emit(routingKey, payload));
  }

  async function rankAvailableAmbulances(lat, lng, options) {
    const opts = options || {};
    const radiusKm = opts.radiusKm || AUTO_DISPATCH_SEARCH_RADIUS_KM;
    const equipmentLevel = opts.equipmentLevel;
    const box = boundingBoxForRadius(lat, lng, radiusKm);
    const candidates = await ambulanceRepository.findAvailableWithinBoundingBox({ ...box, equipmentLevel });
    return candidates
      // "Within radiusKm" is straight-line distance (the same meaning the
      // bounding box and every other service's radius search use); the
      // road-distance estimate is for ranking and ETA only.
      .filter((a) => haversineDistanceKm(lat, lng, a.latitude, a.longitude) <= radiusKm)
      .map((a) => ({ ambulance: a, route: estimateRoute(lat, lng, a.latitude, a.longitude) }))
      .sort((a, b) => a.route.distanceKm - b.route.distanceKm)
      .map((c) => ({ ...c.ambulance, distanceKm: c.route.distanceKm, etaMinutes: c.route.etaMinutes }));
  }

  async function dispatchAmbulanceToEmergency(ambulanceId, emergencyId) {
    return withEvents(async ({ ambulanceRepository: ambulances, emergencyRepository: emergencies, emit }) => {
      const ambulance = await ambulances.findById(ambulanceId);
      if (!ambulance) throw notFoundError("Ambulance not found.");
      if (ambulance.status !== "AVAILABLE") {
        throw conflictError(`Ambulance is ${ambulance.status}, not AVAILABLE — cannot dispatch.`, "AMBULANCE_NOT_AVAILABLE");
      }
      const emergency = await emergencies.findById(emergencyId);
      if (!emergency) throw notFoundError("Emergency not found.");
      if (emergency.status !== "ACTIVE") {
        throw conflictError(
          `Emergency is ${emergency.status}, not ACTIVE — it may already be assigned or resolved.`,
          "EMERGENCY_NOT_ACTIVE"
        );
      }

      // Both claims are conditional UPDATEs: the ambulance must still be
      // AVAILABLE and the emergency still ACTIVE at write time. If either
      // lost a race with a concurrent dispatch, nothing is written (the
      // transaction rolls back) and the caller gets a 409.
      const updatedAmbulance = await ambulances.assignToEmergency(ambulanceId, emergencyId, "DISPATCHED");
      if (!updatedAmbulance) {
        throw conflictError("Ambulance was dispatched by another request a moment ago — it is no longer AVAILABLE.", "AMBULANCE_NOT_AVAILABLE");
      }
      const updatedEmergency = await emergencies.assignAmbulance(emergencyId, ambulanceId);
      if (!updatedEmergency) {
        throw conflictError("Emergency was assigned or closed by another request.", "EMERGENCY_NOT_ACTIVE");
      }
      const route = estimateRoute(ambulance.latitude, ambulance.longitude, emergency.latitude, emergency.longitude);
      await emit("ambulance.dispatched", {
        ambulanceId,
        vehicleNumber: updatedAmbulance.vehicleNumber,
        emergencyId,
        distanceKm: route.distanceKm,
        etaMinutes: route.etaMinutes,
      });
      return { ambulance: updatedAmbulance, emergency: updatedEmergency, route };
    });
  }

  async function dispatchForNewEmergency(emergency) {
    const ranked = await rankAvailableAmbulances(emergency.latitude, emergency.longitude);

    if (ranked.length === 0) {
      await emitStandalone("emergency.unassigned", {
        emergencyId: emergency.id,
        reason: "no_available_ambulance_in_range",
        searchRadiusKm: AUTO_DISPATCH_SEARCH_RADIUS_KM,
      });
      return { emergency, ambulance: null, recommendation: null };
    }

    // Try candidates nearest-first. A candidate claimed by a concurrent
    // dispatch between the search and our UPDATE is skipped, not turned
    // into an error: the emergency already exists, so the right outcome
    // is "assigned the next-nearest" or "left ACTIVE", never a 409 for a
    // row that was in fact created.
    for (const candidate of ranked) {
      try {
        const result = await dispatchAmbulanceToEmergency(candidate.id, emergency.id);
        return {
          emergency: result.emergency,
          ambulance: result.ambulance,
          recommendation: {
            ambulanceId: candidate.id,
            vehicleNumber: candidate.vehicleNumber,
            distanceKm: candidate.distanceKm,
            etaMinutes: candidate.etaMinutes,
            consideredCandidates: ranked.length,
          },
        };
      } catch (err) {
        if (err.code !== "AMBULANCE_NOT_AVAILABLE" && err.code !== "NOT_FOUND") throw err;
      }
    }

    await emitStandalone("emergency.unassigned", {
      emergencyId: emergency.id,
      reason: "all_candidates_taken_concurrently",
      searchRadiusKm: AUTO_DISPATCH_SEARCH_RADIUS_KM,
    });
    return { emergency, ambulance: null, recommendation: null };
  }

  async function completeEmergency(emergencyId) {
    return withEvents(async ({ ambulanceRepository: ambulances, emergencyRepository: emergencies, emit }) => {
      const emergency = await emergencies.findById(emergencyId);
      if (!emergency) throw notFoundError("Emergency not found.");
      const resolvedEmergency = emergency.status === "ASSIGNED" ? await emergencies.resolve(emergencyId) : null;
      if (!resolvedEmergency) {
        throw conflictError(
          `Emergency is ${emergency.status}, not ASSIGNED — only an emergency with an assigned ambulance can be completed.`,
          "EMERGENCY_NOT_ASSIGNED"
        );
      }
      // Only frees the ambulance if it is still on THIS emergency; if it
      // was already re-dispatched elsewhere it is left alone (null).
      const freedAmbulance = await ambulances.clearEmergencyAssignment(emergency.assignedAmbulanceId, "AVAILABLE", emergencyId);
      await emit("emergency.resolved", { emergencyId, ambulanceId: resolvedEmergency.assignedAmbulanceId });
      return { emergency: resolvedEmergency, ambulance: freedAmbulance };
    });
  }

  async function cancelEmergency(emergencyId) {
    return inTransaction(async ({ ambulanceRepository: ambulances, emergencyRepository: emergencies }) => {
      const emergency = await emergencies.findById(emergencyId);
      if (!emergency) return null;
      const cancelled = await emergencies.cancel(emergencyId);
      if (!cancelled) {
        throw conflictError(`Emergency is already ${emergency.status}.`, "EMERGENCY_ALREADY_CLOSED");
      }
      // A cancelled call must not strand its ambulance as DISPATCHED
      // forever: release it (AVAILABLE if the crew hadn't reached a
      // patient yet; otherwise keep its status so it finishes the trip).
      if (cancelled.assignedAmbulanceId) {
        await ambulances.releaseFromEmergency(cancelled.assignedAmbulanceId, emergencyId);
      }
      return cancelled;
    });
  }

  return {
    rankAvailableAmbulances,
    dispatchAmbulanceToEmergency,
    dispatchForNewEmergency,
    completeEmergency,
    cancelEmergency,
  };
}
