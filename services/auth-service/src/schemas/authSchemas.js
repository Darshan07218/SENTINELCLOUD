import { z } from "zod";

export const ALL_ROLES = ["CITIZEN", "EMERGENCY_OPERATOR", "HOSPITAL_ADMIN", "INFRASTRUCTURE_ADMIN", "SYSTEM_ADMIN"];

// Phase 12: public sign-up ALWAYS creates a CITIZEN (read-only) account.
// Before, anyone could register as EMERGENCY_OPERATOR, HOSPITAL_ADMIN or
// INFRASTRUCTURE_ADMIN and immediately create disasters, dispatch
// ambulances or register fake hospitals. Privileged roles are now granted
// only by a SYSTEM_ADMIN through PATCH /users/:id (user management).
// Any "role" field sent to /register is ignored (Zod strips unknown keys).
export const SELF_REGISTERABLE_ROLES = ["CITIZEN"];

export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters long")
  .regex(/[a-z]/, "Password must contain at least one lowercase letter")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[0-9]/, "Password must contain at least one digit")
  // bcrypt only uses the first 72 BYTES of a password; anything after that
  // would be silently ignored, so it's rejected instead. (Must come LAST:
  // .refine() returns a ZodEffects, which has no .regex()/.min() methods.)
  .refine((p) => Buffer.byteLength(p, "utf8") <= 72, "Password must be at most 72 bytes long");

const emailSchema = z.string().trim().toLowerCase().email("Must be a valid email address").max(254);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().trim().min(2, "Full name is too short").max(120),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required").max(1024),
});

// The refresh token normally arrives in the httpOnly cookie. Non-browser
// clients may still send it in the body instead.
export const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(4096).optional(),
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(1).max(4096).optional(),
  // true = end every session of this account ("log out everywhere").
  allDevices: z.boolean().optional(),
});

// ---- user management (SYSTEM_ADMIN only) ----
export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const updateUserSchema = z
  .object({
    role: z.enum(ALL_ROLES).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.role !== undefined || v.isActive !== undefined, "Provide role and/or isActive");

export const uuidSchema = z.string().uuid();
