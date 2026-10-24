/**
 * Runs fn(client) inside BEGIN/COMMIT on one pooled connection, rolling
 * back if fn throws. A connection whose ROLLBACK also fails is handed
 * back with release(err) so the pool discards it instead of reusing a
 * session stuck in an aborted transaction.
 */
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  let broken = null;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      broken = rollbackErr;
    }
    throw err;
  } finally {
    client.release(broken || undefined);
  }
}
