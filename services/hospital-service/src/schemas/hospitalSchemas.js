import { z } from "zod";

const nonNegativeInt = z.number().int().min(0, "Must be zero or greater");

/**
 * Shared "capacity triple" check: available can never exceed total.
 * Applied wherever a schema carries both numbers together, so the
 * error surfaces on the field that's actually wrong rather than as a
 * generic top-level failure.
 */
function refineAvailableNotOverTotal(schema, totalKey, availableKey) {
  return schema.refine((data) => data[availableKey] <= data[totalKey], {
    message: `${availableKey} cannot exceed ${totalKey}`,
    path: [availableKey],
  });
}

const baseHospitalFields = {
  name: z.string().trim().min(2, "Name is too short").max(160),
  address: z.string().trim().min(5, "Address is too short").max(500),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  emergencyContactName: z.string().trim().min(2).max(120),
  emergencyContactPhone: z
    .string()
    .trim()
    .regex(/^[0-9+()\-.\s]{7,32}$/, "Must be a valid phone number"),
  totalBeds: nonNegativeInt,
  availableBeds: nonNegativeInt,
  totalIcuBeds: nonNegativeInt,
  availableIcuBeds: nonNegativeInt,
  totalVentilators: nonNegativeInt,
  availableVentilators: nonNegativeInt,
};

export const createHospitalSchema = refineAvailableNotOverTotal(
  refineAvailableNotOverTotal(
    refineAvailableNotOverTotal(z.object(baseHospitalFields), "totalBeds", "availableBeds"),
    "totalIcuBeds",
    "availableIcuBeds"
  ),
  "totalVentilators",
  "availableVentilators"
);

// PUT /hospitals/:id — full update of the "static" profile fields.
// Availability counters are deliberately NOT editable here — they go
// through their own dedicated endpoints (PATCH /beds, /icu,
// /ventilators) so every availability change is a small, auditable,
// single-purpose request rather than bundled into a general edit.
export const updateHospitalSchema = z
  .object({
    name: baseHospitalFields.name.optional(),
    address: baseHospitalFields.address.optional(),
    latitude: baseHospitalFields.latitude.optional(),
    longitude: baseHospitalFields.longitude.optional(),
    emergencyContactName: baseHospitalFields.emergencyContactName.optional(),
    emergencyContactPhone: baseHospitalFields.emergencyContactPhone.optional(),
    totalBeds: nonNegativeInt.optional(),
    totalIcuBeds: nonNegativeInt.optional(),
    totalVentilators: nonNegativeInt.optional(),
    managedByUserId: z.string().uuid().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" });

export const updateBedsSchema = z.object({
  availableBeds: nonNegativeInt,
});

export const updateIcuSchema = z.object({
  availableIcuBeds: nonNegativeInt,
});

export const updateVentilatorsSchema = z.object({
  availableVentilators: nonNegativeInt,
});

export const overloadSchema = z.object({
  // true = mark OVERLOADED, false = clear back to NORMAL. Kept as an
  // explicit boolean (not a free-text status string) so this one
  // narrow action can't accidentally be used to set an arbitrary
  // status — that's what PUT /hospitals/:id's fields are for, and even
  // that schema doesn't expose emergency_status directly (it's not a
  // "static profile" field, it's operational state).
  overloaded: z.boolean(),
});

export const nearQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().positive().max(500).default(25),
});

// Phase 18: how far ahead the capacity forecast looks (hours).
export const forecastQuerySchema = z.object({
  horizonHours: z.coerce.number().int().min(1).max(72).default(24),
});

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
