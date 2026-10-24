/**
 * Refresh tokens are stored by their SHA-256 hash only (see
 * utils/jwt.js hashToken) — the plaintext token never touches the
 * database, so a DB leak alone does not hand out usable sessions.
 */

export function createRefreshTokenRepository(pool) {
  return {
    async store({ userId, tokenHash, expiresAt, userAgent, ipAddress }) {
      await pool.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, tokenHash, expiresAt, userAgent ? String(userAgent).slice(0, 300) : null, ipAddress || null]
      );
    },

    /** Returns the row only if it exists, is unexpired, and unrevoked. */
    async findValid(tokenHash) {
      const { rows } = await pool.query(
        `SELECT id, user_id, expires_at, revoked_at
         FROM refresh_tokens
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
        [tokenHash]
      );
      return rows[0] || null;
    },

    /** Any row for this hash, whatever its state (used for reuse detection). */
    async findByHash(tokenHash) {
      const { rows } = await pool.query(
        `SELECT id, user_id, revoked_at, replaced_by_hash, expires_at,
                (revoked_at IS NOT NULL AND revoked_at > now() - interval '30 seconds') AS recently_revoked
         FROM refresh_tokens WHERE token_hash = $1`,
        [tokenHash]
      );
      return rows[0] || null;
    },

    /**
     * Rotation: the old token is marked revoked and linked to its
     * replacement, in the same transaction as inserting the new one.
     *
     * Phase 12: the UPDATE only succeeds if the old token is STILL valid
     * at that instant (revoked_at IS NULL). Two concurrent refreshes with
     * the same token can no longer both succeed and fork the session;
     * the loser gets `false` and is refused.
     */
    async rotate({ oldTokenHash, newTokenHash, userId, expiresAt, userAgent, ipAddress }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rowCount } = await client.query(
          `UPDATE refresh_tokens SET revoked_at = now(), replaced_by_hash = $2
           WHERE token_hash = $1 AND user_id = $3 AND revoked_at IS NULL AND expires_at > now()`,
          [oldTokenHash, newTokenHash, userId]
        );
        if (rowCount !== 1) {
          await client.query("ROLLBACK");
          return false;
        }
        await client.query(
          `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
           VALUES ($1, $2, $3, $4, $5)`,
          [userId, newTokenHash, expiresAt, userAgent ? String(userAgent).slice(0, 300) : null, ipAddress || null]
        );
        await client.query("COMMIT");
        return true;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async revoke(tokenHash) {
      const { rowCount } = await pool.query(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
        [tokenHash]
      );
      return rowCount > 0;
    },

    /** Ends every session of a user: logout-everywhere, reuse detection, role change, deactivation. */
    async revokeAllForUser(userId) {
      const { rowCount } = await pool.query(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      );
      return rowCount;
    },

    /**
     * Deletes tokens that expired more than `graceHours` ago. An expired
     * token can no longer be used or replayed (verifyRefreshToken rejects
     * it before any lookup), so keeping it only grows the table; the grace
     * period keeps recent rows around for audit/debugging.
     */
    async purgeExpired(graceHours = 24) {
      const { rowCount } = await pool.query(
        `DELETE FROM refresh_tokens WHERE expires_at < now() - make_interval(hours => $1)`,
        [graceHours]
      );
      return rowCount;
    },
  };
}
