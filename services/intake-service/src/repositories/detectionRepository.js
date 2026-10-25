/** All SQL for detections and source_status. Parameterised queries only. */

function mapDetection(r) {
  if (!r) return null;
  return {
    id: r.id,
    source: r.source,
    externalId: r.external_id,
    type: r.type,
    severity: r.severity,
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    radiusKm: Number(r.radius_km),
    title: r.title,
    description: r.description,
    details: r.details || {},
    observedAt: r.observed_at,
    detectedAt: r.detected_at,
    status: r.status,
    disasterId: r.disaster_id,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    note: r.note,
    error: r.error,
  };
}

function mapSource(r) {
  return {
    source: r.source,
    lastPolledAt: r.last_polled_at,
    lastOkAt: r.last_ok_at,
    lastError: r.last_error,
    lastFound: r.last_found,
    reading: r.reading || {},
  };
}

export function createDetectionRepository(pool) {
  return {
    /** Inserts a new detection; null when (source, external_id) already exists. */
    async insertIfNew(d) {
      const { rows } = await pool.query(
        `INSERT INTO detections
           (source, external_id, type, severity, latitude, longitude, radius_km, title, description, details, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (source, external_id) DO NOTHING
         RETURNING *`,
        [d.source, d.externalId, d.type, d.severity, d.latitude, d.longitude, d.radiusKm, d.title.slice(0, 200), d.description, JSON.stringify(d.details || {}), d.observedAt]
      );
      return mapDetection(rows[0]);
    },

    async findById(id) {
      const { rows } = await pool.query(`SELECT * FROM detections WHERE id = $1`, [id]);
      return mapDetection(rows[0]);
    },

    async list({ status, limit = 50 } = {}) {
      const { rows } = status
        ? await pool.query(`SELECT * FROM detections WHERE status = $1 ORDER BY detected_at DESC LIMIT $2`, [status, limit])
        : await pool.query(`SELECT * FROM detections ORDER BY detected_at DESC LIMIT $1`, [limit]);
      return rows.map(mapDetection);
    },

    /**
     * Moves a detection from one of `fromStatuses` to `status`. Returns null
     * if it was no longer in one of them (someone else decided first).
     */
    async transition(id, fromStatuses, { status, disasterId = null, decidedBy = null, note = null, error = null }) {
      const { rows } = await pool.query(
        `UPDATE detections
            SET status = $3, disaster_id = COALESCE($4, disaster_id), decided_by = COALESCE($5, decided_by),
                decided_at = now(), note = COALESCE($6, note), error = $7
          WHERE id = $1 AND status = ANY($2::varchar[])
          RETURNING *`,
        [id, fromStatuses, status, disasterId, decidedBy, note, error]
      );
      return mapDetection(rows[0]);
    },

    /** PENDING detections older than `hours` become EXPIRED; returns how many. */
    async expirePending(hours) {
      const { rowCount } = await pool.query(
        `UPDATE detections SET status = 'EXPIRED', decided_at = now(), decided_by = 'system'
          WHERE status = 'PENDING' AND detected_at < now() - make_interval(hours => $1)`,
        [hours]
      );
      return rowCount;
    },

    /** A confirm that died mid-way (pod killed) leaves CONFIRMING behind: make it retryable. */
    async failStuckConfirming(minutes) {
      const { rowCount } = await pool.query(
        `UPDATE detections SET status = 'FAILED', error = 'interrupted while creating the disaster; confirm again'
          WHERE status = 'CONFIRMING' AND decided_at < now() - make_interval(mins => $1)`,
        [minutes]
      );
      return rowCount;
    },

    async countByStatus() {
      const { rows } = await pool.query(`SELECT source, status, COUNT(*)::int AS n FROM detections GROUP BY source, status`);
      return rows;
    },

    async recordPoll(source, { ok, error = null, found = 0, reading = null }) {
      await pool.query(
        `INSERT INTO source_status (source, last_polled_at, last_ok_at, last_error, last_found, reading)
         VALUES ($1, now(), CASE WHEN $2 THEN now() END, $3, $4, COALESCE($5::jsonb, '{}'::jsonb))
         ON CONFLICT (source) DO UPDATE
            SET last_polled_at = now(),
                last_ok_at = CASE WHEN $2 THEN now() ELSE source_status.last_ok_at END,
                last_error = $3,
                last_found = CASE WHEN $2 THEN $4 ELSE source_status.last_found END,
                reading = CASE WHEN $5::jsonb IS NULL THEN source_status.reading ELSE $5::jsonb END`,
        [source, ok, error ? String(error).slice(0, 500) : null, found, reading ? JSON.stringify(reading) : null]
      );
    },

    async sources() {
      const { rows } = await pool.query(`SELECT * FROM source_status ORDER BY source`);
      return rows.map(mapSource);
    },
  };
}
