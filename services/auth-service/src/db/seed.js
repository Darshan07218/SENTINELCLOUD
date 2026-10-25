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
export const INTAKE_FULL_NAME = "Automatic Detection";

/**
 * Phase 16 (docs/PHASE-16-SIMULATOR.md §1) and Phase 19: the SERVICE
 * accounts simulator-service and intake-service log in with, so everything
 * they do goes through the gateway like a person's clicks and the audit log
 * names the service, never a human. Owned by configuration: created if
 * missing, and on every start the password, role and active flag are reset
 * to what the environment says. Skipped when the variables aren't set (that
 * service then can't log in, nothing else changes).
 */
async function seedServiceAccount(pool, { emailVar, passwordVar, fullName, role, label }) {
  const email = process.env[emailVar];
  const password = process.env[passwordVar];
  if (!email || !password) {
    console.log(`[auth-service] ${emailVar}/${passwordVar} not set — no ${label} account`);
    return;
  }
  if (isPlaceholder(password) || !passwordSchema.safeParse(password).success) {
    throw new Error(`${passwordVar} is an example value or too weak (min 10 chars, upper, lower, digit). Generate one with scripts/generate-secrets.sh.`);
  }
  const passwordHash = await hashPassword(password);
  await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role_id)
     SELECT $1, $2, $3, id FROM roles WHERE name = $4
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           full_name = EXCLUDED.full_name,
           role_id = EXCLUDED.role_id,
           is_active = TRUE`,
    [email.trim().toLowerCase(), passwordHash, fullName, role]
  );
  const masked = email.replace(/^(.).*(@.*)$/, "$1***$2");
  console.log(`[auth-service] ${label} service account ready (${masked})`);
}

/** Phase 16: the simulator drives the whole platform, so SYSTEM_ADMIN. */
export function seedSimulatorAccount(pool) {
  return seedServiceAccount(pool, { emailVar: "SIMULATOR_EMAIL", passwordVar: "SIMULATOR_PASSWORD", fullName: SIMULATOR_FULL_NAME, role: "SYSTEM_ADMIN", label: "simulator" });
}

/** Phase 19: intake-service only ever creates disasters, so the least role that may: EMERGENCY_OPERATOR. */
export function seedIntakeAccount(pool) {
  return seedServiceAccount(pool, { emailVar: "INTAKE_EMAIL", passwordVar: "INTAKE_PASSWORD", fullName: INTAKE_FULL_NAME, role: "EMERGENCY_OPERATOR", label: "intake" });
}
