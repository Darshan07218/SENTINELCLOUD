import { z } from "zod";

export const createEmergencySchema = z.object({
  description: z.string().trim().min(3, "Description is too short").max(1000),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
});

export const emergencyListQuerySchema = z.object({
  status: z.enum(["ACTIVE", "ASSIGNED", "RESOLVED", "CANCELLED"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
