import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

/**
 * Minimal, dependency-free migration runner.
 *
 * Why hand-rolled instead of a library like node-pg-migrate: at this
 * project's scale (a handful of forward-only SQL files) a ~40-line
 * runner is easier to read, review, and explain in a viva than pulling
 * in an extra dependency with its own CLI/config surface. Each
 * migration is a plain .sql file, applied at most once, tracked in a
 * schema_migrations table — the same core idea every migration tool
 * uses under the hood.
 *
 * Ordering: filenames are sorted lexically, so the numeric prefix
 * (0001_, 0002_, ...) controls apply order — keep that convention for
 * any new migration file.
 */
export async function runMigrations(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows: appliedRows } = await pool.query("SELECT filename FROM schema_migrations");
  const applied = new Set(appliedRows.map((r) => r.filename));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let appliedCount = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`[ambulance-service] applied migration: ${file}`);
      appliedCount += 1;
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`[ambulance-service] migration failed: ${file}:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  if (appliedCount === 0) {
    console.log("[ambulance-service] no pending migrations");
  }
}
