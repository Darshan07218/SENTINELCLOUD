import { Router } from "express";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  createAmbulanceSchema,
  updateAmbulanceSchema,
  updateLocationSchema,
  updateStatusSchema,
  dispatchSchema,
  assignHospitalSchema,
  nearestQuerySchema,
  paginationQuerySchema,
} from "../schemas/ambulanceSchemas.js";

const OPERATOR_ROLES = ["EMERGENCY_OPERATOR", "SYSTEM_ADMIN"];

export function createAmbulanceRouter({ ambulanceService, dispatchService }) {
  const router = Router();

  // Phase 12: every :id in this API is a UUID. Reject anything else with a
  // 400 here instead of letting Postgres fail the cast (a 500 + stack trace).
  router.param("id", (req, res, next, id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      ? next()
      : res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Path parameter 'id' must be a UUID." } })
  );

  // No per-ambulance ownership model (unlike hospital-service's
  // per-admin ownership): the ambulance fleet is a shared operational
  // resource any EMERGENCY_OPERATOR coordinates, not something one
  // individual operator "owns" — so role membership alone is the
  // authorization boundary here, enforced independently at this
  // service (defense in depth) in addition to the gateway's Phase 2
  // role rule for the /ambulances prefix.
  router.use(requireAuth);

  router.get("/nearest", validateQuery(nearestQuerySchema), async (req, res, next) => {
    try {
      const { lat, lng, radiusKm, limit, equipmentLevel } = req.query;
      const ambulances = await ambulanceService.findNearestAvailable(lat, lng, { radiusKm, limit, equipmentLevel });
      res.status(200).json({ ambulances, query: { lat, lng, radiusKm, limit, equipmentLevel } });
    } catch (err) {
      next(err);
    }
  });

  router.get("/stats/summary", async (req, res, next) => {
    try {
      const summary = await ambulanceService.getFleetSummary();
      res.status(200).json({ summary });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", requireRole(...OPERATOR_ROLES), validateBody(createAmbulanceSchema), async (req, res, next) => {
    try {
      const ambulance = await ambulanceService.registerAmbulance(req.body);
      res.status(201).json({ ambulance });
    } catch (err) {
      next(err);
    }
  });

  router.get("/", validateQuery(paginationQuerySchema), async (req, res, next) => {
    try {
      const result = await ambulanceService.listAmbulances(req.query);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", async (req, res, next) => {
    try {
      const ambulance = await ambulanceService.getAmbulance(req.params.id);
      if (!ambulance) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Ambulance not found." } });
      res.status(200).json({ ambulance });
    } catch (err) {
      next(err);
    }
  });

  router.put("/:id", requireRole(...OPERATOR_ROLES), validateBody(updateAmbulanceSchema), async (req, res, next) => {
    try {
      const ambulance = await ambulanceService.updateAmbulanceProfile(req.params.id, req.body);
      if (!ambulance) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Ambulance not found." } });
      res.status(200).json({ ambulance });
    } catch (err) {
      next(err);
    }
  });

  router.patch(
    "/:id/location",
    requireRole(...OPERATOR_ROLES),
    validateBody(updateLocationSchema),
    async (req, res, next) => {
      try {
        const ambulance = await ambulanceService.updateLocation(req.params.id, req.body.latitude, req.body.longitude);
        if (!ambulance) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Ambulance not found." } });
        res.status(200).json({ ambulance });
      } catch (err) {
        next(err);
      }
    }
  );

  router.patch(
    "/:id/status",
    requireRole(...OPERATOR_ROLES),
    validateBody(updateStatusSchema),
    async (req, res, next) => {
      try {
        const ambulance = await ambulanceService.changeStatus(req.params.id, req.body.status);
        if (!ambulance) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Ambulance not found." } });
        res.status(200).json({ ambulance });
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    "/:id/dispatch",
    requireRole(...OPERATOR_ROLES),
    validateBody(dispatchSchema),
    async (req, res, next) => {
      try {
        const result = await dispatchService.dispatchAmbulanceToEmergency(req.params.id, req.body.emergencyId);
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  router.patch(
    "/:id/assign-hospital",
    requireRole(...OPERATOR_ROLES),
    validateBody(assignHospitalSchema),
    async (req, res, next) => {
      try {
        const ambulance = await ambulanceService.assignHospital(req.params.id, req.body.hospitalId);
        if (!ambulance) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Ambulance not found." } });
        res.status(200).json({ ambulance });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
