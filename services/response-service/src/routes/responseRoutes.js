import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { NEEDS_BY_SEVERITY, TYPE_FACTORS, BLOOD_TYPES, MAX_RADIUS_KM, MAX_RESERVE_SHARE } from "../playbook.js";
import { POPULATION_ZONES, RURAL_DENSITY, EXPOSURE, CASUALTIES_PER_10K, SEVERITY_MULTIPLIER, SHARES, TRIPS_PER_AMBULANCE } from "../impact.js";
import { PLAN_WAIT_SECONDS, COMMAND_TIMEOUT_SECONDS } from "../services/responseService.js";

// Same write roles as disasters: the people who run the emergency response.
const DECIDE_ROLES = ["EMERGENCY_OPERATOR", "SYSTEM_ADMIN"];
const PLAN_STATUSES = ["PROPOSED", "EXECUTING", "COMPLETED", "PARTIAL", "REJECTED", "EXPIRED", "UNDOING", "ROLLED_BACK"];

const listQuerySchema = z.object({
  disasterId: z.string().uuid().optional(),
  status: z.enum(PLAN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const decisionSchema = z.object({ note: z.string().trim().max(500).optional() }).strict();

/**
 * Phase 15 API (docs/PHASE-15-RESPONSE-ENGINE.md §4), behind the gateway at
 * /api/v1/response. Reading is open to every signed-in user; approving,
 * rejecting and undoing need EMERGENCY_OPERATOR or SYSTEM_ADMIN (the gateway
 * enforces the same for every write; re-checked here as defence in depth).
 */
export function createResponseRouter({ responseService, autoApprove }) {
  const router = Router();
  router.param("id", (req, res, next, id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      ? next()
      : res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Path parameter 'id' must be a UUID." } })
  );
  router.use(requireAuth);

  router.get("/plans", validateQuery(listQuerySchema), async (req, res, next) => {
    try {
      res.json({ plans: await responseService.listPlans(req.query) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/plans/:id", async (req, res, next) => {
    try {
      res.json({ plan: await responseService.getPlan(req.params.id) });
    } catch (err) {
      next(err);
    }
  });

  const decide = (action) => [
    requireRole(...DECIDE_ROLES),
    validateBody(decisionSchema),
    async (req, res, next) => {
      try {
        res.json({ plan: await responseService[action](req.params.id, req.user, { note: req.body.note }) });
      } catch (err) {
        next(err);
      }
    },
  ];
  router.post("/plans/:id/approve", ...decide("approve"));
  router.post("/plans/:id/reject", ...decide("reject"));
  router.post("/plans/:id/undo", ...decide("undo"));

  /** The playbook table, so the UI (and a viva) can show exactly what the engine does. */
  router.get("/playbook", (req, res) => {
    res.json({
      mode: autoApprove ? "AUTO" : "APPROVAL",
      needsBySeverity: NEEDS_BY_SEVERITY,
      typeFactors: TYPE_FACTORS,
      bloodTypes: BLOOD_TYPES,
      maxEscalatedRadiusKm: MAX_RADIUS_KM,
      planWaitSeconds: PLAN_WAIT_SECONDS,
      commandTimeoutSeconds: COMMAND_TIMEOUT_SECONDS,
      // Phase 20: the impact model the needs are estimated with (impact.js).
      impactModel: {
        populationZones: POPULATION_ZONES,
        ruralDensityPerKm2: RURAL_DENSITY,
        exposure: EXPOSURE,
        casualtiesPer10kExposedAtMedium: CASUALTIES_PER_10K,
        severityMultiplier: SEVERITY_MULTIPLIER,
        shares: SHARES,
        tripsPerAmbulance: TRIPS_PER_AMBULANCE,
        maxShareOfFreeBedsReserved: MAX_RESERVE_SHARE,
      },
      note: "Demo policy, not clinical or emergency-management guidance.",
    });
  });

  return router;
}
