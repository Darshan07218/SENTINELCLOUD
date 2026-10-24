import pg from "pg";
import { requireSecret, requireEnv } from "./security/secrets.js";

const { Pool } = pg;
let pool = null;

export function initPool() {
  pool = new Pool({
    host: process.env.DB_HOST || "postgres",
    port: Number(process.env.DB_PORT || 5432),
    // Phase 12: no fallback credentials in code. Each service has its own
    // database user (least privilege) and password, both from the environment.
    user: requireEnv("DB_USER"),
    password: requireSecret("DB_PASSWORD", { minLength: 16 }),
    database: process.env.DB_NAME || "ambulance_db",
    // Engineering review: 5 per replica (was 10). Summed over every service
    // and replica this must stay below Postgres max_connections.
    max: Number(process.env.DB_POOL_MAX || 5),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on("error", (err) => {
    console.error("[ambulance-service] unexpected Postgres pool error:", err.message);
  });

  return pool;
}

export function getPool() {
  if (!pool) throw new Error("Postgres pool not initialized — call initPool() first");
  return pool;
}

export async function checkDbConnection() {
  try {
    const client = await getPool().connect();
    try {
      await client.query("SELECT 1");
      return { connected: true };
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn("[ambulance-service] database check failed:", err.message); // details stay in the logs, not in HTTP responses
    return { connected: false, error: "connection failed" };
  }
}

export async function waitForDb(retries = 15, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const status = await checkDbConnection();
    if (status.connected) return;
    console.log(`[ambulance-service] Postgres not ready yet, retry ${attempt}/${retries} in ${delayMs}ms`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("Postgres did not become ready in time");
}

/**
 * Phase 9 (Kubernetes): serialises one-time startup work — migrations
 * and demo seeding — across every replica of this service.
 *
 * Why this exists: under Docker Compose there was only ever ONE
 * container per service, so "read schema_migrations, apply what's
 * missing" was safe. Under Kubernetes, `kubectl scale --replicas=3`
 * (or a rolling update, or the HPA) starts several pods at the same
 * instant against the same database. Without a lock they all see the
 * same migration as pending, all run CREATE TABLE, one wins and the
 * others crash on "relation already exists" → CrashLoopBackOff; the
 * "seed only if the table is empty" check has the same race and can
 * double-insert demo data.
 *
 * pg_advisory_lock is a cluster-wide (per-database) mutex held by the
 * session that took it. The first pod gets it and does the work; the
 * others block on the SELECT until it finishes, then find nothing left
 * to do. If the pod holding it is killed mid-migration, Postgres drops
 * the session and releases the lock automatically — no stale-lock
 * cleanup needed (unlike a "lock row" in a table).
 */
const STARTUP_LOCK_KEY = 9_000_001; // arbitrary constant; scoped to this service's own database

export async function withStartupLock(fn) {
  const client = await getPool().connect();
  try {
    console.log("[ambulance-service] acquiring startup lock (migrations + seed)…");
    await client.query("SELECT pg_advisory_lock($1)", [STARTUP_LOCK_KEY]);
    console.log("[ambulance-service] startup lock acquired");
    return await fn();
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [STARTUP_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
}

/** Closes the pool during graceful shutdown (SIGTERM from Kubernetes). */
export async function closePool() {
  if (pool) await pool.end();
}
