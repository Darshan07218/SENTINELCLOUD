import { z } from "zod";
import { AMBULANCE_STATUSES } from "../services/statusMachine.js";

const EQUIPMENT_LEVELS = ["BASIC", "ADVANCED", "CRITICAL_CARE"];

const phoneSchema = z
  .string()
  .trim()
  .regex(/^[0-9+()\-.\s]{7,32}$/, "Must be a valid phone number");

export const createAmbulanceSchema = z.object({
  vehicleNumber: z.string().trim().min(2, "Vehicle number is too short").max(32),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  driverName: z.string().trim().min(2).max(120),
  driverPhone: phoneSchema,
  equipmentLevel: z.enum(EQUIPMENT_LEVELS).default("BASIC"),
});

export const updateAmbulanceSchema = z
  .object({
    vehicleNumber: z.string().trim().min(2).max(32).optional(),
    driverName: z.string().trim().min(2).max(120).optional(),
    driverPhone: phoneSchema.optional(),
    equipmentLevel: z.enum(EQUIPMENT_LEVELS).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" });

export const updateLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const updateStatusSchema = z.object({
  status: z.enum(AMBULANCE_STATUSES),
});

export const dispatchSchema = z.object({
  emergencyId: z.string().uuid(),
});

export const assignHospitalSchema = z.object({
  hospitalId: z.string().uuid(),
});

export const nearestQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().positive().max(500).default(50),
  limit: z.coerce.number().int().min(1).max(20).default(5),
  equipmentLevel: z.enum(EQUIPMENT_LEVELS).optional(),
});

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(AMBULANCE_STATUSES).optional(),
});
