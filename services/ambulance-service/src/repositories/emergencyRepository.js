function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    description: row.description,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    severity: row.severity,
    status: row.status,
    assignedAmbulanceId: row.assigned_ambulance_id,
    assignedHospitalId: row.assigned_hospital_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

export function createEmergencyRepository(pool) {
  return {
    async create(data, createdByUserId) {
      const { rows } = await pool.query(
        `INSERT INTO emergencies (description, latitude, longitude, severity, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`,
        [data.description, data.latitude, data.longitude, data.severity, createdByUserId]
      );
      return mapRow(rows[0]);
    },

    /** Phase 15: an emergency created by a response-service dispatch command, tagged with that command's id. */
    async createForCommand(data, createdByUserId, sourceCommandId) {
      const { rows } = await pool.query(
        `INSERT INTO emergencies (description, latitude, longitude, severity, created_by_user_id, source_command_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [data.description, data.latitude, data.longitude, data.severity, createdByUserId, sourceCommandId]
      );
      return mapRow(rows[0]);
    },

    /** Phase 15: every emergency a dispatch command created so far (a retry only creates the missing ones). */
    async findByCommand(sourceCommandId) {
      const { rows } = await pool.query(`SELECT * FROM emergencies WHERE source_command_id = $1 ORDER BY created_at`, [sourceCommandId]);
      return rows.map(mapRow);
    },

    async findById(id) {
      const { rows } = await pool.query(`SELECT * FROM emergencies WHERE id = $1`, [id]);
      return mapRow(rows[0]);
    },

    async list({ page, limit, status }) {
      const conditions = [];
      const values = [];
      let i = 1;
      if (status) {
        conditions.push(`status = $${i}`);
        values.push(status);
        i += 1;
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const offset = (page - 1) * limit;
      const { rows } = await pool.query(
        `SELECT * FROM emergencies ${where} ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
        [...values, limit, offset]
      );
      const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS count FROM emergencies ${where}`, values);
      return { emergencies: rows.map(mapRow), total: countRows[0].count };
    },

    async findActive(limit = 500) {
      const { rows } = await pool.query(
        `SELECT * FROM emergencies WHERE status IN ('ACTIVE','ASSIGNED') ORDER BY created_at ASC LIMIT $1`,
        [limit]
      );
      return rows.map(mapRow);
    },

    async assignAmbulance(id, ambulanceId) {
      const { rows } = await pool.query(
        `UPDATE emergencies SET status = 'ASSIGNED', assigned_ambulance_id = $1
          WHERE id = $2 AND status = 'ACTIVE' RETURNING *`,
        [ambulanceId, id]
      );
      return mapRow(rows[0]);
    },

    async assignHospital(id, hospitalId) {
      const { rows } = await pool.query(
        `UPDATE emergencies SET assigned_hospital_id = $1 WHERE id = $2 RETURNING *`,
        [hospitalId, id]
      );
      return mapRow(rows[0]);
    },

    async resolve(id) {
      const { rows } = await pool.query(
        `UPDATE emergencies SET status = 'RESOLVED', resolved_at = now()
          WHERE id = $1 AND status = 'ASSIGNED' RETURNING *`,
        [id]
      );
      return mapRow(rows[0]);
    },

    async cancel(id) {
      const { rows } = await pool.query(
        `UPDATE emergencies SET status = 'CANCELLED', resolved_at = now()
          WHERE id = $1 AND status IN ('ACTIVE','ASSIGNED') RETURNING *`,
        [id]
      );
      return mapRow(rows[0]);
    },
  };
}
