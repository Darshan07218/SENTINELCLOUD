/**
 * All SQL touching the users/roles tables lives in this one module —
 * route handlers never write raw SQL themselves. Every query is
 * parameterized ($1, $2, ...); string-concatenated SQL is never used,
 * which is what actually prevents SQL injection here.
 */

const PUBLIC_COLUMNS = `u.id, u.email, u.full_name, u.is_active, u.created_at, r.name AS role`;

export function createUserRepository(pool) {
  return {
    async findByEmail(email) {
      const { rows } = await pool.query(
        `SELECT u.id, u.email, u.password_hash, u.full_name, u.is_active, r.name AS role
         FROM users u JOIN roles r ON r.id = u.role_id
         WHERE u.email = $1`,
        [email]
      );
      return rows[0] || null;
    },

    async findById(id) {
      const { rows } = await pool.query(
        `SELECT ${PUBLIC_COLUMNS} FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
        [id]
      );
      return rows[0] || null;
    },

    async create({ email, passwordHash, fullName, role }) {
      const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, full_name, role_id)
         SELECT $1, $2, $3, id FROM roles WHERE name = $4
         RETURNING id, email, full_name, created_at`,
        [email, passwordHash, fullName, role]
      );
      return rows[0];
    },

    async emailExists(email) {
      const { rows } = await pool.query("SELECT 1 FROM users WHERE email = $1", [email]);
      return rows.length > 0;
    },

    // ---- Phase 12: user management (SYSTEM_ADMIN) ----

    async list({ page, limit }) {
      const offset = (page - 1) * limit;
      const [{ rows }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT ${PUBLIC_COLUMNS} FROM users u JOIN roles r ON r.id = u.role_id
           ORDER BY u.created_at ASC LIMIT $1 OFFSET $2`,
          [limit, offset]
        ),
        pool.query("SELECT count(*)::int AS total FROM users"),
      ]);
      return { users: rows, total: countRows[0].total };
    },

    /**
     * Updates role and/or active flag in ONE transaction that first locks
     * every SYSTEM_ADMIN row, so two admins demoting each other at the same
     * moment can't leave the system with no active admin: the second
     * transaction waits, then sees the first one's change and is refused.
     * Returns { user } | { user: null } (no such id) | { error: "LAST_ADMIN" }.
     */
    async updateGuarded(id, { role, isActive }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `SELECT id FROM users WHERE role_id = (SELECT id FROM roles WHERE name = 'SYSTEM_ADMIN') FOR UPDATE`
        );
        const { rows } = await client.query(
          // No "users u" alias: identical in PostgreSQL, and pg-mem (the unit
          // tests' in-memory database) rejects an alias on the UPDATE target.
          `UPDATE users SET
             role_id   = COALESCE((SELECT id FROM roles WHERE name = $2), users.role_id),
             is_active = COALESCE($3, users.is_active),
             updated_at = now()
           WHERE users.id = $1
           RETURNING id`,
          [id, role ?? null, isActive ?? null]
        );
        if (!rows[0]) {
          await client.query("ROLLBACK");
          return { user: null };
        }
        const { rows: admins } = await client.query(
          `SELECT count(*)::int AS n FROM users u JOIN roles r ON r.id = u.role_id
           WHERE r.name = 'SYSTEM_ADMIN' AND u.is_active`
        );
        if (admins[0].n < 1) {
          await client.query("ROLLBACK");
          return { error: "LAST_ADMIN" };
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
      return { user: await this.findById(id) };
    },

    async countActiveAdmins() {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM users u JOIN roles r ON r.id = u.role_id
         WHERE r.name = 'SYSTEM_ADMIN' AND u.is_active`
      );
      return rows[0].n;
    },
  };
}
