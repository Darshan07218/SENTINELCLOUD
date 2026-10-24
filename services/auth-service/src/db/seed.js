import { hashPassword } from "../utils/password.js";
import { passwordSchema } from "../schemas/authSchemas.js";
import { isPlaceholder } from "../security/secrets.js";

/**
 * SYSTEM_ADMIN accounts cannot be created via public POST /register
 * (Phase 12: sign-up only ever creates CITIZEN accounts). Exactly one
 * bootstrap admin is seeded here, idempotently, so there's always a way
 * in to grant roles through the user-management API. Credentials come
 * from environment variables — never hardcoded — and the row is only
 * created if no SYSTEM_ADMIN exists yet, so it's safe on every startup.
 *
 * Phase 12: the bootstrap password must satisfy the normal password
 * policy and must not be an example value such as "ChangeMe123!" —
 * scripts/generate-secrets.sh creates a random one.
 */
export async function seedDefaultAdmin(pool) {
  const email = process.env.DEFAULT_ADMIN_EMAIL;
  const password = process.env.DEFAULT_ADMIN_PASSWORD;
  const fullName = process.env.DEFAULT_ADMIN_NAME || "SentinelCloud System Administrator";

  if (!email || !password) {
    console.warn("[auth-service] DEFAULT_ADMIN_EMAIL/DEFAULT_ADMIN_PASSWORD not set — skipping admin seed");
    return;
  }

  const { rows: existingAdmins } = await pool.query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'SYSTEM_ADMIN' LIMIT 1`
  );
  if (existingAdmins.length > 0) {
    console.log("[auth-service] a SYSTEM_ADMIN already exists — skipping admin seed");
    return;
  }

  if (isPlaceholder(password) || !passwordSchema.safeParse(password).success) {
    throw new Error(
      "DEFAULT_ADMIN_PASSWORD is an example value or too weak (min 10 chars, upper, lower, digit). " +
        "Generate one with scripts/generate-secrets.sh — see SECURITY.md."
    );
  }

  const passwordHash = await hashPassword(password);
  await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role_id)
     SELECT $1, $2, $3, id FROM roles WHERE name = 'SYSTEM_ADMIN'
     ON CONFLICT (email) DO NOTHING`,
    [email.trim().toLowerCase(), passwordHash, fullName]
  );
  // Don't print the full address into logs.
  const masked = email.replace(/^(.).*(@.*)$/, "$1***$2");
  console.log(`[auth-service] seeded the bootstrap SYSTEM_ADMIN account (${masked})`);
}

export const SIMULATOR_FULL_NAME = "Scenario Simulator";

/**
 * Phase 16 (docs/PHASE-16-SIMULATOR.md §1): the service account
 * simulator-service logs in with, so everything it does goes through the
 * gateway like a person's clicks and the audit log shows "Scenario
 * Simulator", never a human. It is a SERVICE account owned by configuration:
 * created if missing, and on every start its password, role and active flag
 * are reset to what SIMULATOR_EMAIL / SIMULATOR_PASSWORD say. Skipped when
 * those aren't set (the simulator then can't log in, nothing else changes).
 */
export async function seedSimulatorAccount(pool) {
  const email = process.env.SIMULATOR_EMAIL;
  const password = process.env.SIMULATOR_PASSWORD;
  if (!email || !password) {
    console.log("[auth-service] SIMULATOR_EMAIL/SIMULATOR_PASSWORD not set — no simulator account");
    return;
  }
  if (isPlaceholder(password) || !passwordSchema.safeParse(password).success) {
    throw new Error("SIMULATOR_PASSWORD is an example value or too weak (min 10 chars, upper, lower, digit). Generate one with scripts/generate-secrets.sh.");
  }
  const passwordHash = await hashPassword(password);
  await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role_id)
     SELECT $1, $2, $3, id FROM roles WHERE name = 'SYSTEM_ADMIN'
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           full_name = EXCLUDED.full_name,
           role_id = EXCLUDED.role_id,
           is_active = TRUE`,
    [email.trim().toLowerCase(), passwordHash, SIMULATOR_FULL_NAME]
  );
  const masked = email.replace(/^(.).*(@.*)$/, "$1***$2");
  console.log(`[auth-service] simulator service account ready (${masked})`);
}
