function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    latitude: row.latitude,
    longitude: row.longitude,
    radiusKm: row.radius_km,
    description: row.description,
    status: row.status,
    statusNote: row.status_note ?? null,
    createdByUserId: row.created_by_user_id,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createDisasterRepository(pool) {
  return {
    async create(data, createdByUserId) {
      const { rows } = await pool.query(
        `INSERT INTO disasters (type, severity, latitude, longitude, radius_km, description, created_by_user_id, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8, now()))
         RETURNING *`,
        [
          data.type,
          data.severity,
          data.latitude,
          data.longitude,
          data.radiusKm,
          data.description,
          createdByUserId,
          data.occurredAt || null,
        ]
      );
      return mapRow(rows[0]);
    },

    async findById(id) {
      const { rows } = await pool.query(`SELECT * FROM disasters WHERE id = $1`, [id]);
      return mapRow(rows[0]);
    },

    async list({ page, limit, status, type }) {
      const conditions = [];
      const params = [];
      if (status) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
      }
      if (type) {
        params.push(type);
        conditions.push(`type = $${params.length}`);
      }
      const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const offset = (page - 1) * limit;

      params.push(limit, offset);
      const { rows } = await pool.query(
        `SELECT * FROM disasters ${whereClause} ORDER BY occurred_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS count FROM disasters ${whereClause}`, params.slice(0, conditions.length));
      return { disasters: rows.map(mapRow), total: countRows[0].count };
    },

    async listActive() {
      const { rows } = await pool.query(`SELECT * FROM disasters WHERE status = 'ACTIVE' ORDER BY occurred_at DESC LIMIT 500`);
      return rows.map(mapRow);
    },

    /** Coarse pre-filter for "disasters near a location" — same bounding-box-then-Haversine pattern as every other geo query in this project. */
    async findWithinBoundingBox({ minLat, maxLat, minLng, maxLng }) {
      const { rows } = await pool.query(
        `SELECT * FROM disasters WHERE latitude BETWEEN $1 AND $2 AND longitude BETWEEN $3 AND $4`,
        [minLat, maxLat, minLng, maxLng]
      );
      return rows.map(mapRow);
    },

    async updateFields(id, fields) {
      const columnMap = { severity: "severity", radiusKm: "radius_km", description: "description" };
      const sets = [];
      const params = [];
      for (const [key, column] of Object.entries(columnMap)) {
        if (fields[key] !== undefined) {
          params.push(fields[key]);
          sets.push(`${column} = $${params.length}`);
        }
      }
      if (sets.length === 0) return this.findById(id);
      params.push(id);
      const { rows } = await pool.query(
        `UPDATE disasters SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
        params
      );
      return mapRow(rows[0]);
    },

    /**
     * Conditional on the status the caller validated the transition from,
     * so two concurrent status changes can't both apply (the loser gets
     * null). `note` is stored as the reason for the latest change.
     */
    async setStatus(id, status, { fromStatus, note } = {}) {
      const params = [status, note ?? null, id];
      let where = "id = $3";
      if (fromStatus) {
        params.push(fromStatus);
        where += " AND status = $4";
      }
      const { rows } = await pool.query(`UPDATE disasters SET status = $1, status_note = $2 WHERE ${where} RETURNING *`, params);
      return mapRow(rows[0]);
    },
  };
}
