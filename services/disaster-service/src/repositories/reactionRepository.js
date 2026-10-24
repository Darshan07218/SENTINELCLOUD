function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    disasterId: row.disaster_id,
    eventType: row.event_type,
    sourceService: row.source_service,
    eventId: row.event_id,
    payload: row.payload,
    receivedAt: row.received_at,
    eventOccurredAt: row.event_occurred_at ?? null,
  };
}

/**
 * Fan-in storage for reaction events (see migrations/0002 for the full
 * rationale). upsert() is what makes the aggregator idempotent under
 * RabbitMQ's at-least-once delivery: a redelivered or corrected
 * reaction from the same service for the same disaster replaces the
 * prior row rather than duplicating it.
 */
export function createReactionRepository(pool) {
  return {
    /**
     * Returns the stored row, or null when the incoming event is OLDER
     * than the one already stored (a late redelivery) and was ignored.
     */
    async upsert({ disasterId, eventType, sourceService, eventId, payload, occurredAt }) {
      const { rows } = await pool.query(
        `INSERT INTO disaster_reactions (disaster_id, event_type, source_service, event_id, payload, event_occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (disaster_id, event_type, source_service)
         DO UPDATE SET event_id = EXCLUDED.event_id, payload = EXCLUDED.payload, received_at = now(),
                       event_occurred_at = EXCLUDED.event_occurred_at
          WHERE disaster_reactions.event_occurred_at IS NULL
             OR EXCLUDED.event_occurred_at IS NULL
             OR EXCLUDED.event_occurred_at >= disaster_reactions.event_occurred_at
         RETURNING *`,
        [disasterId, eventType, sourceService, eventId, JSON.stringify(payload), occurredAt ?? null]
      );
      return mapRow(rows[0]);
    },

    async findByDisasterId(disasterId) {
      const { rows } = await pool.query(
        `SELECT * FROM disaster_reactions WHERE disaster_id = $1 ORDER BY received_at ASC`,
        [disasterId]
      );
      return rows.map(mapRow);
    },
  };
}
