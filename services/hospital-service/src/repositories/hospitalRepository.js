/**
 * All SQL touching the hospitals table lives here. Every query is
 * parameterized — no string-concatenated SQL, which is what actually
 * prevents SQL injection (not an ORM we don't have).
 *
 * Row shape returned to callers uses camelCase (mapped from Postgres's
 * snake_case columns) so the rest of the service never has to think
 * about the two different naming conventions.
 */

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    emergencyContactName: row.emergency_contact_name,
    emergencyContactPhone: row.emergency_contact_phone,
    totalBeds: row.total_beds,
    availableBeds: row.available_beds,
    totalIcuBeds: row.total_icu_beds,
    availableIcuBeds: row.available_icu_beds,
    totalVentilators: row.total_ventilators,
    availableVentilators: row.available_ventilators,
    emergencyStatus: row.emergency_status,
    managedByUserId: row.managed_by_user_id,
    // Phase 21: provenance (OpenStreetMap element, how capacity was obtained).
    osmId: row.osm_id ?? null,
    capacitySource: row.capacity_source ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createHospitalRepository(pool) {
  return {
    async create(data, managedByUserId) {
      const { rows } = await pool.query(
        `INSERT INTO hospitals (
           name, address, latitude, longitude,
           emergency_contact_name, emergency_contact_phone,
           total_beds, available_beds,
           total_icu_beds, available_icu_beds,
           total_ventilators, available_ventilators,
           managed_by_user_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          data.name,
          data.address,
          data.latitude,
          data.longitude,
          data.emergencyContactName,
          data.emergencyContactPhone,
          data.totalBeds,
          data.availableBeds,
          data.totalIcuBeds,
          data.availableIcuBeds,
          data.totalVentilators,
          data.availableVentilators,
          managedByUserId,
        ]
      );
      return mapRow(rows[0]);
    },

    async findById(id) {
      const { rows } = await pool.query(`SELECT * FROM hospitals WHERE id = $1`, [id]);
      return mapRow(rows[0]);
    },

    async list({ page, limit }) {
      const offset = (page - 1) * limit;
      const [{ rows }, { rows: countRows }] = await Promise.all([
        pool.query(`SELECT * FROM hospitals ORDER BY name ASC LIMIT $1 OFFSET $2`, [limit, offset]),
        pool.query(`SELECT COUNT(*)::int AS count FROM hospitals`),
      ]);
      return { hospitals: rows.map(mapRow), total: countRows[0].count };
    },

    /**
     * Coarse pre-filter only: a bounding box roughly `radiusKm` wide
     * around (lat, lng), computed with a fixed degrees-per-km
     * approximation. This trims the row count cheaply using the
     * (latitude, longitude) index before the service layer computes
     * exact Haversine distance in JS and does the final radius cutoff
     * — see services/hospitalService.js findNear(). At this project's
     * scale (tens to low hundreds of hospitals) doing the precise
     * distance math in application code is simpler to read, test, and
     * reason about than pushing a geospatial extension into the query,
     * while the bounding box keeps it cheap even as the table grows.
     */
    async findWithinBoundingBox({ minLat, maxLat, minLng, maxLng }) {
      const { rows } = await pool.query(
        `SELECT * FROM hospitals
         WHERE latitude BETWEEN $1 AND $2 AND longitude BETWEEN $3 AND $4`,
        [minLat, maxLat, minLng, maxLng]
      );
      return rows.map(mapRow);
    },

    async findWithIcuAvailable() {
      const { rows } = await pool.query(
        `SELECT * FROM hospitals WHERE available_icu_beds > 0 ORDER BY available_icu_beds DESC LIMIT 500`
      );
      return rows.map(mapRow);
    },

    /** Dashboard totals in one aggregate query instead of loading every row. */
    async summary() {
      const { rows } = await pool.query(`
        SELECT COUNT(*)::int                                               AS "totalHospitals",
               COALESCE(SUM(total_beds), 0)::int                           AS "totalBeds",
               COALESCE(SUM(available_beds), 0)::int                       AS "availableBeds",
               COALESCE(SUM(total_icu_beds), 0)::int                       AS "totalIcuBeds",
               COALESCE(SUM(available_icu_beds), 0)::int                   AS "availableIcuBeds",
               COALESCE(SUM(total_ventilators), 0)::int                    AS "totalVentilators",
               COALESCE(SUM(available_ventilators), 0)::int                AS "availableVentilators",
               COALESCE(SUM(CASE WHEN emergency_status = 'OVERLOADED' THEN 1 ELSE 0 END), 0)::int AS "overloadedHospitals"
          FROM hospitals`);
      return rows[0];
    },

    async findAllForAlerts() {
      const { rows } = await pool.query(`SELECT * FROM hospitals`);
      return rows.map(mapRow);
    },

    /** Generic partial update for the "static profile" fields (PUT /hospitals/:id). */
    async updateProfile(id, fields) {
      const columnMap = {
        name: "name",
        address: "address",
        latitude: "latitude",
        longitude: "longitude",
        emergencyContactName: "emergency_contact_name",
        emergencyContactPhone: "emergency_contact_phone",
        totalBeds: "total_beds",
        totalIcuBeds: "total_icu_beds",
        totalVentilators: "total_ventilators",
        managedByUserId: "managed_by_user_id",
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
        `UPDATE hospitals SET ${setClauses.join(", ")} WHERE id = $${i} RETURNING *`,
        values
      );
      return mapRow(rows[0]);
    },

    async updateAvailableBeds(id, availableBeds) {
      const { rows } = await pool.query(
        `UPDATE hospitals SET available_beds = $1 WHERE id = $2 RETURNING *`,
        [availableBeds, id]
      );
      return mapRow(rows[0]);
    },

    async updateAvailableIcuBeds(id, availableIcuBeds) {
      const { rows } = await pool.query(
        `UPDATE hospitals SET available_icu_beds = $1 WHERE id = $2 RETURNING *`,
        [availableIcuBeds, id]
      );
      return mapRow(rows[0]);
    },

    async updateAvailableVentilators(id, availableVentilators) {
      const { rows } = await pool.query(
        `UPDATE hospitals SET available_ventilators = $1 WHERE id = $2 RETURNING *`,
        [availableVentilators, id]
      );
      return mapRow(rows[0]);
    },

    /**
     * Phase 18: capacity history for the forecast — every row since `since`
     * plus the last row before it (the value in force when the window
     * starts), oldest first.
     */
    async capacityHistory(hospitalId, since) {
      const columns = `recorded_at, total_beds, available_beds, total_icu_beds, available_icu_beds, source`;
      const [{ rows: before }, { rows: within }] = await Promise.all([
        pool.query(
          `SELECT ${columns} FROM hospital_capacity_history
            WHERE hospital_id = $1 AND recorded_at < $2
            ORDER BY recorded_at DESC LIMIT 1`,
          [hospitalId, since]
        ),
        pool.query(
          `SELECT ${columns} FROM hospital_capacity_history
            WHERE hospital_id = $1 AND recorded_at >= $2
            ORDER BY recorded_at ASC LIMIT 5000`,
          [hospitalId, since]
        ),
      ]);
      return [...before, ...within].map((r) => ({
        recordedAt: r.recorded_at,
        totalBeds: r.total_beds,
        availableBeds: r.available_beds,
        totalIcuBeds: r.total_icu_beds,
        availableIcuBeds: r.available_icu_beds,
        source: r.source,
      }));
    },

    async setEmergencyStatus(id, status) {
      const { rows } = await pool.query(
        `UPDATE hospitals SET emergency_status = $1 WHERE id = $2 RETURNING *`,
        [status, id]
      );
      return mapRow(rows[0]);
    },
  };
}
