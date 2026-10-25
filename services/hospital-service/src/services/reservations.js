/**
 * Phase 20: bed reservations (docs/PHASE-20-SMARTER-RESPONSE.md §2).
 *
 * reserve: in ONE transaction, lock the hospital row, take up to the asked
 * beds and ICU beds off its free counts, record the reservation, and queue a
 * capacity alert if the hospital is now short (same outbox as every other
 * capacity change). The capacity-history trigger (Phase 18) records the drop,
 * so the forecast sees it too.
 *
 * Idempotent per command: a reservation remembers the command that made it;
 * the same command again returns that reservation instead of holding more.
 *
 * Holds what is free right now: if beds filled up since the plan was made,
 * fewer are held (reported in the reply); none free at all is a failure.
 */
import { calculateHospitalCapacity, computeHospitalAlerts } from "./capacity.js";

export class ReservationError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BEDS_PER_RESERVATION = 2000;

function mapReservation(r) {
  return {
    id: r.id,
    hospitalId: r.hospital_id,
    beds: r.beds,
    icuBeds: r.icu_beds,
    disasterId: r.disaster_id,
    planId: r.plan_id,
    notes: r.notes,
    status: r.status,
    createdAt: r.created_at,
    releasedAt: r.released_at,
  };
}

function alertFor(row) {
  const hospital = {
    id: row.id,
    name: row.name,
    totalBeds: row.total_beds,
    availableBeds: row.available_beds,
    totalIcuBeds: row.total_icu_beds,
    availableIcuBeds: row.available_icu_beds,
    totalVentilators: row.total_ventilators,
    availableVentilators: row.available_ventilators,
    emergencyStatus: row.emergency_status,
  };
  const alerts = computeHospitalAlerts(hospital);
  return alerts.length ? { hospitalId: hospital.id, hospitalName: hospital.name, alerts, capacity: calculateHospitalCapacity(hospital) } : null;
}

/**
 * @param transaction  (fn) => runs fn(client) in one transaction
 * @param outbox       the service's outbox (alerts), optional in tests
 */
export function createReservationService({ transaction, pool, outbox = null }) {
  async function reserve({ hospitalId, beds = 0, icuBeds = 0, disasterId = null, planId = null, commandId = null, notes = null }) {
    if (!UUID_RE.test(String(hospitalId))) throw new ReservationError("INVALID_COMMAND", "hospitalId must be a UUID", 400);
    for (const [name, v] of [["beds", beds], ["icuBeds", icuBeds]]) {
      if (!Number.isInteger(v) || v < 0 || v > MAX_BEDS_PER_RESERVATION) throw new ReservationError("INVALID_COMMAND", `${name} must be an integer 0..${MAX_BEDS_PER_RESERVATION}`, 400);
    }
    if (beds + icuBeds === 0) throw new ReservationError("INVALID_COMMAND", "nothing to reserve", 400);

    let queued = false;
    const result = await transaction(async (client) => {
      if (commandId) {
        const { rows } = await client.query(`SELECT * FROM bed_reservations WHERE source_command_id = $1`, [commandId]);
        if (rows[0]) return { reservation: mapReservation(rows[0]), duplicate: true };
      }
      const { rows: hRows } = await client.query(`SELECT * FROM hospitals WHERE id = $1 FOR UPDATE`, [hospitalId]);
      const h = hRows[0];
      if (!h) throw new ReservationError("HOSPITAL_NOT_FOUND", "No such hospital.", 404);
      const takeBeds = Math.min(beds, h.available_beds);
      const takeIcu = Math.min(icuBeds, h.available_icu_beds);
      if (takeBeds + takeIcu === 0) throw new ReservationError("NO_CAPACITY", `${h.name} has no free beds or ICU beds left to hold.`);

      const { rows: updated } = await client.query(
        `UPDATE hospitals SET available_beds = available_beds - $2, available_icu_beds = available_icu_beds - $3
          WHERE id = $1 RETURNING *`,
        [hospitalId, takeBeds, takeIcu]
      );
      const { rows } = await client.query(
        `INSERT INTO bed_reservations (hospital_id, beds, icu_beds, disaster_id, plan_id, source_command_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [hospitalId, takeBeds, takeIcu, UUID_RE.test(String(disasterId)) ? disasterId : null, UUID_RE.test(String(planId)) ? planId : null, commandId, notes ? String(notes).slice(0, 300) : null]
      );
      const alert = alertFor(updated[0]);
      if (alert && outbox) {
        await outbox.enqueue(client, "hospital.capacity.alert", alert);
        queued = true;
      }
      return { reservation: mapReservation(rows[0]), hospitalName: h.name, requested: { beds, icuBeds } };
    });
    if (queued) outbox.kick();
    return result;
  }

  /** Gives the beds back. Releasing twice is harmless (alreadyReleased). */
  async function release(reservationId) {
    if (!UUID_RE.test(String(reservationId))) throw new ReservationError("INVALID_COMMAND", "reservationId must be a UUID", 400);
    return transaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM bed_reservations WHERE id = $1 FOR UPDATE`, [reservationId]);
      const r = rows[0];
      if (!r) throw new ReservationError("RESERVATION_NOT_FOUND", "No such bed reservation.", 404);
      if (r.status === "RELEASED") return { reservation: mapReservation(r), alreadyReleased: true };
      await client.query(
        `UPDATE hospitals
            SET available_beds = LEAST(total_beds, available_beds + $2),
                available_icu_beds = LEAST(total_icu_beds, available_icu_beds + $3)
          WHERE id = $1`,
        [r.hospital_id, r.beds, r.icu_beds]
      );
      const { rows: done } = await client.query(`UPDATE bed_reservations SET status = 'RELEASED', released_at = now() WHERE id = $1 RETURNING *`, [reservationId]);
      return { reservation: mapReservation(done[0]), alreadyReleased: false };
    });
  }

  async function list({ hospitalId, status } = {}) {
    const where = [];
    const params = [];
    if (hospitalId) where.push(`hospital_id = $${params.push(hospitalId)}`);
    if (status) where.push(`status = $${params.push(status)}`);
    const { rows } = await pool.query(
      `SELECT * FROM bed_reservations ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT 200`,
      params
    );
    return rows.map(mapReservation);
  }

  return { reserve, release, list };
}
