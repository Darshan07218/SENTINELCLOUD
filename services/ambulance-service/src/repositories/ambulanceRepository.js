function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    vehicleNumber: row.vehicle_number,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    status: row.status,
    driverName: row.driver_name,
    driverPhone: row.driver_phone,
    equipmentLevel: row.equipment_level,
    assignedHospitalId: row.assigned_hospital_id,
    assignedEmergencyId: row.assigned_emergency_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createAmbulanceRepository(pool) {
  return {
    async create(data) {
      const { rows } = await pool.query(
        `INSERT INTO ambulances (vehicle_number, latitude, longitude, driver_name, driver_phone, equipment_level)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [data.vehicleNumber, data.latitude, data.longitude, data.driverName, data.driverPhone, data.equipmentLevel]
      );
      return mapRow(rows[0]);
    },

    async findById(id) {
      const { rows } = await pool.query(`SELECT * FROM ambulances WHERE id = $1`, [id]);
      return mapRow(rows[0]);
    },

    async findByVehicleNumber(vehicleNumber) {
      const { rows } = await pool.query(`SELECT * FROM ambulances WHERE vehicle_number = $1`, [vehicleNumber]);
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
        `SELECT * FROM ambulances ${where} ORDER BY vehicle_number ASC LIMIT $${i} OFFSET $${i + 1}`,
        [...values, limit, offset]
      );
      const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS count FROM ambulances ${where}`, values);
      return { ambulances: rows.map(mapRow), total: countRows[0].count };
    },

    async findAvailableWithinBoundingBox({ minLat, maxLat, minLng, maxLng, equipmentLevel }) {
      const conditions = ["status = 'AVAILABLE'", "latitude BETWEEN $1 AND $2", "longitude BETWEEN $3 AND $4"];
      const values = [minLat, maxLat, minLng, maxLng];
      if (equipmentLevel) {
        conditions.push(`equipment_level = $5`);
        values.push(equipmentLevel);
      }
      const { rows } = await pool.query(`SELECT * FROM ambulances WHERE ${conditions.join(" AND ")}`, values);
      return rows.map(mapRow);
    },

    async findAllAvailable(equipmentLevel) {
      const conditions = ["status = 'AVAILABLE'"];
      const values = [];
      if (equipmentLevel) {
        conditions.push(`equipment_level = $1`);
        values.push(equipmentLevel);
      }
      const { rows } = await pool.query(`SELECT * FROM ambulances WHERE ${conditions.join(" AND ")}`, values);
      return rows.map(mapRow);
    },

    async updateProfile(id, fields) {
      const columnMap = {
        vehicleNumber: "vehicle_number",
        driverName: "driver_name",
        driverPhone: "driver_phone",
        equipmentLevel: "equipment_level",
      };
      const setClauses = [];
      const values = [];
      let i = 1;
      for (const [key, value] of Object.entries(fields)) {
        const column = columnMap[key];
        if (!column) continue;
        setClauses.push(`${column} = $${i}`);
        values.push(value);
        i += 1;
      }
      if (setClauses.length === 0) return this.findById(id);
      values.push(id);
      const { rows } = await pool.query(
        `UPDATE ambulances SET ${setClauses.join(", ")} WHERE id = $${i} RETURNING *`,
        values
      );
      return mapRow(rows[0]);
    },

    async updateLocation(id, latitude, longitude) {
      const { rows } = await pool.query(
        `UPDATE ambulances SET latitude = $1, longitude = $2 WHERE id = $3 RETURNING *`,
        [latitude, longitude, id]
      );
      return mapRow(rows[0]);
    },

    async updateStatus(id, status) {
      const { rows } = await pool.query(`UPDATE ambulances SET status = $1 WHERE id = $2 RETURNING *`, [status, id]);
      return mapRow(rows[0]);
    },

    /**
     * Claims an AVAILABLE ambulance for an emergency in one conditional
     * UPDATE. Returns null if the ambulance is gone or no longer
     * AVAILABLE — i.e. a concurrent dispatch won the race — so two
     * operators can never send the same ambulance to two emergencies.
     */
    async assignToEmergency(id, emergencyId, status) {
      const { rows } = await pool.query(
        `UPDATE ambulances SET assigned_emergency_id = $1, status = $2
          WHERE id = $3 AND status = 'AVAILABLE'
          RETURNING *`,
        [emergencyId, status, id]
      );
      return mapRow(rows[0]);
    },

    /**
     * Frees the ambulance from `emergencyId` and sets `status` — but only
     * if it is still assigned to that emergency (it may have been
     * re-dispatched since). Returns null when it wasn't.
     */
    async clearEmergencyAssignment(id, status, emergencyId) {
      const { rows } = await pool.query(
        `UPDATE ambulances SET assigned_emergency_id = NULL, assigned_hospital_id = NULL, status = $1
          WHERE id = $2 AND assigned_emergency_id = $3
          RETURNING *`,
        [status, id, emergencyId]
      );
      return mapRow(rows[0]);
    },

    /**
     * For a CANCELLED call: unassigns the ambulance from `emergencyId`
     * (only if still on it). A crew that hasn't reached a patient yet
     * (DISPATCHED/EN_ROUTE/AT_SCENE) becomes AVAILABLE again; one already
     * transporting keeps its status and finishes the trip.
     */
    async releaseFromEmergency(id, emergencyId) {
      const { rows } = await pool.query(
        `UPDATE ambulances
            SET assigned_emergency_id = NULL,
                assigned_hospital_id = NULL,
                status = CASE WHEN status IN ('DISPATCHED','EN_ROUTE','AT_SCENE') THEN 'AVAILABLE' ELSE status END
          WHERE id = $1 AND assigned_emergency_id = $2
          RETURNING *`,
        [id, emergencyId]
      );
      return mapRow(rows[0]);
    },

    async assignHospital(id, hospitalId) {
      const { rows } = await pool.query(
        `UPDATE ambulances SET assigned_hospital_id = $1 WHERE id = $2 RETURNING *`,
        [hospitalId, id]
      );
      return mapRow(rows[0]);
    },

    async countByStatus() {
      const { rows } = await pool.query(`SELECT status, COUNT(*)::int AS count FROM ambulances GROUP BY status`);
      return Object.fromEntries(rows.map((r) => [r.status, r.count]));
    },
  };
}
