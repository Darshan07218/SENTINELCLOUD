import { z } from "zod";
import { DISASTER_TYPES, SEVERITIES, DISASTER_STATUSES } from "../events/eventTypes.js";

export const createDisasterSchema = z.object({
  type: z.enum(DISASTER_TYPES),
  severity: z.enum(SEVERITIES),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  // The affected-zone radius every reacting service's "find nearby X"
  // query uses (see src/services/disasterService.js publishDetected()).
  radiusKm: z.number().positive().max(500),
  description: z.string().min(5).max(2000),
  occurredAt: z.string().datetime().optional(),
});

export const updateDisasterSchema = z
  .object({
    severity: z.enum(SEVERITIES).optional(),
    radiusKm: z.number().positive().max(500).optional(),
    description: z.string().min(5).max(2000).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided." });

export const setStatusSchema = z.object({
  status: z.enum(DISASTER_STATUSES),
  note: z.string().max(1000).optional(),
});

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(DISASTER_STATUSES).optional(),
  type: z.enum(DISASTER_TYPES).optional(),
});

export const nearQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().positive().max(500).default(50),
});
