import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { DISASTER_TYPES, DETECTION_STATUSES } from "../services/intakeService.js";

// The people who run disasters decide on detections (gateway: same list).
const DECIDE_ROLES = ["EMERGENCY_OPERATOR", "SYSTEM_ADMIN"];

const listQuerySchema = z.object({
  status: z.enum(DETECTION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const decisionSchema = z.object({ note: z.string().trim().max(500).optional() }).strict();
const demoSchema = z
  .object({
    type: z.enum(DISASTER_TYPES),
    severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  })
  .strict();

/**
 * Phase 19 API (docs/PHASE-19-AUTO-DETECTION.md §3), behind the gateway at
 * /api/v1/intake. Reading: every signed-in user. Confirm, dismiss and
 * "poll now": EMERGENCY_OPERATOR or SYSTEM_ADMIN. Injecting a DEMO
 * detection: SYSTEM_ADMIN only.
 */
export function createIntakeRouter({ intakeService }) {
  const router = Router();
  router.param("id", (req, res, next, id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      ? next()
      : res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Path parameter 'id' must be a UUID." } })
  );
  router.use(requireAuth);

  const handle = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };

  router.get("/overview", handle(async (req, res) => res.json(await intakeService.overview())));

  router.get(
    "/detections",
    validateQuery(listQuerySchema),
    handle(async (req, res) => res.json({ detections: await intakeService.list(req.query) }))
  );

  router.get(
    "/detections/:id",
    handle(async (req, res) => {
      const detection = await intakeService.get(req.params.id);
      if (!detection) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Detection not found." } });
      res.json({ detection });
    })
  );

  router.post(
    "/detections/:id/confirm",
    requireRole(...DECIDE_ROLES),
    validateBody(decisionSchema),
    handle(async (req, res) => res.json({ detection: await intakeService.confirm(req.params.id, req.user, { note: req.body.note }) }))
  );

  router.post(
    "/detections/:id/dismiss",
    requireRole(...DECIDE_ROLES),
    validateBody(decisionSchema),
    handle(async (req, res) => res.json({ detection: await intakeService.dismiss(req.params.id, req.user, { note: req.body.note }) }))
  );

  router.post(
    "/poll",
    requireRole(...DECIDE_ROLES),
    handle(async (req, res) => {
      const created = await intakeService.pollNow();
      res.json({ newDetections: created.length, detections: created });
    })
  );

  router.post(
    "/demo",
    requireRole("SYSTEM_ADMIN"),
    validateBody(demoSchema),
    handle(async (req, res) => res.status(201).json({ detection: await intakeService.injectDemo(req.body) }))
  );

  return router;
}
