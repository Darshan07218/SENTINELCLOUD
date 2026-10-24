import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import {
  createDisasterSchema,
  updateDisasterSchema,
  setStatusSchema,
  listQuerySchema,
  nearQuerySchema,
} from "../schemas/disasterSchemas.js";
import { buildSituationReport } from "../services/situationReportService.js";

const WRITE_ROLES = ["EMERGENCY_OPERATOR", "SYSTEM_ADMIN"];

export function createDisasterRouter({ disasterService, reactionRepository }) {
  const router = Router();

  // Phase 12: every :id in this API is a UUID. Reject anything else with a
  // 400 here instead of letting Postgres fail the cast (a 500 + stack trace).
  router.param("id", (req, res, next, id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      ? next()
      : res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Path parameter 'id' must be a UUID." } })
  );

  // All routes require authentication (matching the gateway's baseline
  // "any logged-in role can read" rule); creating/updating/changing
  // status is further restricted to EMERGENCY_OPERATOR/SYSTEM_ADMIN —
  // the same write-role rule the gateway already enforces at the edge
  // (see services/gateway/src/routeAccessRules.js), re-checked here as
  // defense in depth, same pattern every other service in this
  // project follows.
  router.use(requireAuth);

  router.post("/", requireRole(...WRITE_ROLES), validateBody(createDisasterSchema), async (req, res, next) => {
    try {
      const { disaster, eventPublished } = await disasterService.createDisaster(req.body, req.user.id);
      res.status(201).json({ disaster, eventPublished });
    } catch (err) {
      next(err);
    }
  });

  router.get("/", validateQuery(listQuerySchema), async (req, res, next) => {
    try {
      res.json(await disasterService.listDisasters(req.query));
    } catch (err) {
      next(err);
    }
  });

  router.get("/active", async (req, res, next) => {
    try {
      res.json({ disasters: await disasterService.listActiveDisasters() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/near", validateQuery(nearQuerySchema), async (req, res, next) => {
    try {
      const { lat, lng, radiusKm } = req.query;
      res.json({ disasters: await disasterService.findDisastersNear(lat, lng, radiusKm) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", async (req, res, next) => {
    try {
      res.json({ disaster: await disasterService.getDisaster(req.params.id) });
    } catch (err) {
      next(err);
    }
  });

  router.put("/:id", requireRole(...WRITE_ROLES), validateBody(updateDisasterSchema), async (req, res, next) => {
    try {
      const { disaster, eventPublished } = await disasterService.updateDisaster(req.params.id, req.body);
      res.json({ disaster, eventPublished });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/status", requireRole(...WRITE_ROLES), validateBody(setStatusSchema), async (req, res, next) => {
    try {
      const { disaster, eventPublished } = await disasterService.setStatus(req.params.id, req.body.status, req.body.note);
      res.json({ disaster, eventPublished });
    } catch (err) {
      next(err);
    }
  });

  // Feature: aggregated situation report — the fan-in read side of the
  // event flow. See services/situationReportService.js and
  // consumers/reactionConsumer.js for how disaster_reactions gets
  // populated in the first place.
  router.get("/:id/situation-report", async (req, res, next) => {
    try {
      const disaster = await disasterService.getDisaster(req.params.id);
      const reactions = await reactionRepository.findByDisasterId(disaster.id);
      res.json({ situationReport: buildSituationReport(disaster, reactions) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
