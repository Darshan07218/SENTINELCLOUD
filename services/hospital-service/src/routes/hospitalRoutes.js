import { Router } from "express";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requireHospitalOwnership } from "../middleware/ownership.js";
import {
  createHospitalSchema,
  updateHospitalSchema,
  updateBedsSchema,
  updateIcuSchema,
  updateVentilatorsSchema,
  overloadSchema,
  nearQuerySchema,
  paginationQuerySchema,
  forecastQuerySchema,
} from "../schemas/hospitalSchemas.js";

const MANAGER_ROLES = ["HOSPITAL_ADMIN", "SYSTEM_ADMIN"];

export function createHospitalRouter({ hospitalService, hospitalRepository, reservationService = null }) {
  const router = Router();

  // Phase 12: every :id in this API is a UUID. Reject anything else with a
  // 400 here instead of letting Postgres fail the cast (a 500 + stack trace).
  router.param("id", (req, res, next, id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      ? next()
      : res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Path parameter 'id' must be a UUID." } })
  );
  const ownership = requireHospitalOwnership(hospitalRepository);

  // Every route in this service requires authentication — there is no
  // public hospital data. (The gateway already enforces this too; see
  // docs/PHASE-2-AUTH.md — this is the defense-in-depth layer in case
  // hospital-service is ever reached directly, bypassing the gateway.)
  router.use(requireAuth);

  // ---------------------------------------------------------------
  // Feature 6 & 7 — fixed-path GETs registered before the /:id route
  // so "near" and "icu-available" and "alerts" aren't swallowed by it.
  // ---------------------------------------------------------------
  router.get("/near", validateQuery(nearQuerySchema), async (req, res, next) => {
    try {
      const { lat, lng, radiusKm } = req.query;
      const hospitals = await hospitalService.findHospitalsNear(lat, lng, radiusKm);
      res.status(200).json({ hospitals, query: { lat, lng, radiusKm } });
    } catch (err) {
      next(err);
    }
  });

  router.get("/icu-available", async (req, res, next) => {
    try {
      const hospitals = await hospitalService.findHospitalsWithIcuAvailable();
      res.status(200).json({ hospitals });
    } catch (err) {
      next(err);
    }
  });

  // Feature 9 — capacity alerts, aggregated across every hospital.
  router.get("/alerts", async (req, res, next) => {
    try {
      const alerts = await hospitalService.generateCapacityAlerts();
      res.status(200).json({ alerts, count: alerts.length });
    } catch (err) {
      next(err);
    }
  });

  // Dashboard summary stats — total hospitals, aggregate bed/ICU
  // availability, overloaded count. One call for everything the
  // frontend's summary cards need, rather than the browser computing
  // aggregates itself from a full hospital list.
  router.get("/stats/summary", async (req, res, next) => {
    try {
      const summary = await hospitalService.getSummary();
      summary.bedOccupancyPercentage =
        summary.totalBeds > 0
          ? Math.round(((summary.totalBeds - summary.availableBeds) / summary.totalBeds) * 1000) / 10
          : 0;
      summary.icuOccupancyPercentage =
        summary.totalIcuBeds > 0
          ? Math.round(((summary.totalIcuBeds - summary.availableIcuBeds) / summary.totalIcuBeds) * 1000) / 10
          : 0;
      res.status(200).json({ summary });
    } catch (err) {
      next(err);
    }
  });

  // Phase 20: beds held for response plans (newest first). Read-only here:
  // plans hold them and undoing a plan releases them.
  router.get("/reservations", async (req, res, next) => {
    try {
      if (!reservationService) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Reservations are not enabled." } });
      const status = ["HELD", "RELEASED"].includes(req.query.status) ? req.query.status : undefined;
      const hospitalId = /^[0-9a-f-]{36}$/i.test(String(req.query.hospitalId || "")) ? req.query.hospitalId : undefined;
      const reservations = await reservationService.list({ hospitalId, status });
      res.status(200).json({ reservations, count: reservations.length });
    } catch (err) {
      next(err);
    }
  });

  // Phase 18: every hospital's bed/ICU occupancy forecast, highest risk
  // first (headline numbers; the hourly series is on /:id/forecast).
  router.get("/forecast", validateQuery(forecastQuerySchema), async (req, res, next) => {
    try {
      const forecasts = await hospitalService.forecastAll({ horizonHours: req.query.horizonHours });
      res.status(200).json({ forecasts, count: forecasts.length, horizonHours: req.query.horizonHours });
    } catch (err) {
      next(err);
    }
  });

  // ---------------------------------------------------------------
  // Feature 1 — register hospital
  // ---------------------------------------------------------------
  router.post("/", requireRole(...MANAGER_ROLES), validateBody(createHospitalSchema), async (req, res, next) => {
    try {
      const hospital = await hospitalService.registerHospital(req.body, req.user.id);
      res.status(201).json({ hospital });
    } catch (err) {
      next(err);
    }
  });

  router.get("/", validateQuery(paginationQuerySchema), async (req, res, next) => {
    try {
      const result = await hospitalService.listHospitals(req.query);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", async (req, res, next) => {
    try {
      const hospital = await hospitalService.getHospital(req.params.id);
      if (!hospital) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Hospital not found." } });
      res.status(200).json({ hospital });
    } catch (err) {
      next(err);
    }
  });

  // Phase 18: one hospital's forecast with the hourly history and forecast series.
  router.get("/:id/forecast", validateQuery(forecastQuerySchema), async (req, res, next) => {
    try {
      const forecast = await hospitalService.forecastCapacity(req.params.id, { horizonHours: req.query.horizonHours });
      if (!forecast) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Hospital not found." } });
      res.status(200).json({ forecast });
    } catch (err) {
      next(err);
    }
  });

  // ---------------------------------------------------------------
  // Feature 2 — update hospital information (profile fields)
  // ---------------------------------------------------------------
  router.put(
    "/:id",
    requireRole(...MANAGER_ROLES),
    ownership,
    validateBody(updateHospitalSchema),
    async (req, res, next) => {
      try {
        // Phase 12: only a SYSTEM_ADMIN may (re)assign who manages a hospital.
        // Otherwise a hospital admin could hand their hospital to — or take
        // it from — another account.
        if (req.body.managedByUserId !== undefined && req.user.role !== "SYSTEM_ADMIN") {
          return res.status(403).json({ error: { code: "FORBIDDEN", message: "Only a SYSTEM_ADMIN can change managedByUserId." } });
        }
        const hospital = await hospitalService.updateHospitalProfile(req.params.id, req.body);
        res.status(200).json({ hospital });
      } catch (err) {
        next(err);
      }
    }
  );

  // ---------------------------------------------------------------
  // Feature 3, 4, 5 — availability updates, each its own small,
  // single-purpose, auditable endpoint (see schemas/hospitalSchemas.js
  // for why these are split out from the general PUT).
  // ---------------------------------------------------------------
  router.patch(
    "/:id/beds",
    requireRole(...MANAGER_ROLES),
    ownership,
    validateBody(updateBedsSchema),
    async (req, res, next) => {
      try {
        const hospital = await hospitalService.updateAvailableBeds(req.params.id, req.body.availableBeds);
        res.status(200).json({ hospital });
      } catch (err) {
        next(err);
      }
    }
  );

  router.patch(
    "/:id/icu",
    requireRole(...MANAGER_ROLES),
    ownership,
    validateBody(updateIcuSchema),
    async (req, res, next) => {
      try {
        const hospital = await hospitalService.updateAvailableIcuBeds(req.params.id, req.body.availableIcuBeds);
        res.status(200).json({ hospital });
      } catch (err) {
        next(err);
      }
    }
  );

  router.patch(
    "/:id/ventilators",
    requireRole(...MANAGER_ROLES),
    ownership,
    validateBody(updateVentilatorsSchema),
    async (req, res, next) => {
      try {
        const hospital = await hospitalService.updateAvailableVentilators(
          req.params.id,
          req.body.availableVentilators
        );
        res.status(200).json({ hospital });
      } catch (err) {
        next(err);
      }
    }
  );

  // ---------------------------------------------------------------
  // Feature 8 — mark hospital as overloaded (or clear it)
  // ---------------------------------------------------------------
  router.post(
    "/:id/overload",
    requireRole(...MANAGER_ROLES),
    ownership,
    validateBody(overloadSchema),
    async (req, res, next) => {
      try {
        const hospital = await hospitalService.setOverloaded(req.params.id, req.body.overloaded);
        res.status(200).json({ hospital });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
