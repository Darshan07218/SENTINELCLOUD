// Resets the bootstrap SYSTEM_ADMIN's password to DEFAULT_ADMIN_PASSWORD.
//
// seed.js only creates the admin when none exists, so changing .env after
// the first startup has no effect on an existing database. Run this inside
// the auth-service container (it has pg, bcryptjs and the DB credentials):
//
//   Get-Content scripts\reset-admin-password.mjs -Raw | docker compose exec -T auth-service node --input-type=module -
//   docker compose restart auth-service   # clears any in-memory login lockout
import pg from "pg";
import bcrypt from "bcryptjs";

const email = (process.env.DEFAULT_ADMIN_EMAIL || "").trim().toLowerCase();
const password = process.env.DEFAULT_ADMIN_PASSWORD || "";
if (!email || !password) {
  console.error("DEFAULT_ADMIN_EMAIL / DEFAULT_ADMIN_PASSWORD are not set in the container");
  process.exit(1);
}

const pool = new pg.Pool({
  host: process.env.DB_HOST || "postgres",
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "auth_db",
});

try {
  const rounds = Math.max(12, Number(process.env.BCRYPT_SALT_ROUNDS) || 12);
  const hash = await bcrypt.hash(password, rounds);
  const { rowCount } = await pool.query(
    `UPDATE users SET password_hash = $1, is_active = TRUE
       WHERE email = $2`,
    [hash, email]
  );
  if (rowCount === 0) {
    console.error(`No user with email ${email}. Restart auth-service to seed it, or check the email.`);
    process.exitCode = 1;
  } else {
    console.log(`Password reset for ${email}.`);
  }
} finally {
  await pool.end();
}
