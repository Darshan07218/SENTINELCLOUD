import { Router } from "express";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { createEmergencySchema, emergencyListQuerySchema } from "../schemas/emergencySchemas.js";

const OPERATOR_ROLES = ["EMERGENCY_OPERATOR", "SYSTEM_ADMIN"];

export function createEmergencyRouter({ emergencyService }) {
  const router = Router();

  // Phase 12: every :id in this API is a UUID. Reject anything else with a
  // 400 here instead of letting Postgres fail the cast (a 500 + stack trace).
  router.param("id", (req, res, next, id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      ? next()
      : res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Path parameter 'id' must be a UUID." } })
  );
  router.use(requireAuth);

  router.get("/active", async (req, res, next) => {
    try {
      const emergencies = await emergencyService.listActiveEmergencies();
      res.status(200).json({ emergencies, count: emergencies.length });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", requireRole(...OPERATOR_ROLES), validateBody(createEmergencySchema), async (req, res, next) => {
    try {
      const result = await emergencyService.createEmergency(req.body, req.user.id);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/", validateQuery(emergencyListQuerySchema), async (req, res, next) => {
    try {
      const result = await emergencyService.listEmergencies(req.query);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", async (req, res, next) => {
    try {
      const emergency = await emergencyService.getEmergency(req.params.id);
      if (!emergency) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Emergency not found." } });
      res.status(200).json({ emergency });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/complete", requireRole(...OPERATOR_ROLES), async (req, res, next) => {
    try {
      const result = await emergencyService.completeEmergency(req.params.id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/cancel", requireRole(...OPERATOR_ROLES), async (req, res, next) => {
    try {
      const emergency = await emergencyService.cancelEmergency(req.params.id);
      if (!emergency) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Emergency not found." } });
      res.status(200).json({ emergency });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
