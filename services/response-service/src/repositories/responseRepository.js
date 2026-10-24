/**
 * Phase 15 — SQL for response-service. `db` is the pool or a transaction's
 * client (both have .query), like the other services' repositories.
 */

function json(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function mapContext(row) {
  if (!row) return null;
  return {
    disasterId: row.disaster_id,
    disaster: json(row.disaster),
    status: row.status,
    radiusKm: Number(row.radius_km),
    reactions: json(row.reactions) || {},
    detectedAt: row.detected_at,
    updatedAt: row.updated_at,
  };
}

export function mapAction(row) {
  return {
    id: row.id,
    planId: row.plan_id,
    seq: row.seq,
    kind: row.kind,
    params: json(row.params),
    reason: row.reason,
    status: row.status,
    commandId: row.command_id,
    undoCommandId: row.undo_command_id,
    result: json(row.result),
    error: json(row.error),
    sentAt: row.sent_at,
    finishedAt: row.finished_at,
  };
}

function mapPlan(row, actions = []) {
  if (!row) return null;
  return {
    id: row.id,
    disasterId: row.disaster_id,
    revision: row.revision,
    status: row.status,
    mode: row.mode,
    needs: json(row.needs),
    disaster: json(row.disaster),
    createdAt: row.created_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    finishedAt: row.finished_at,
    undoneBy: row.undone_by,
    undoneAt: row.undone_at,
    actions,
  };
}

export function createResponseRepository(db) {
  async function actionsFor(planIds) {
    if (planIds.length === 0) return new Map();
    const { rows } = await db.query(`SELECT * FROM response_actions WHERE plan_id = ANY($1::uuid[]) ORDER BY plan_id, seq`, [planIds]);
    const byPlan = new Map(planIds.map((id) => [id, []]));
    for (const row of rows) byPlan.get(row.plan_id).push(mapAction(row));
    return byPlan;
  }

  return {
    // --- disaster context ------------------------------------------------
    async upsertDisaster(disaster) {
      const { rows } = await db.query(
        `INSERT INTO disaster_context (disaster_id, disaster, status, radius_km)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (disaster_id) DO UPDATE
           SET disaster = EXCLUDED.disaster, status = EXCLUDED.status,
               radius_km = EXCLUDED.radius_km, updated_at = now()
         RETURNING *`,
        [disaster.disasterId, JSON.stringify(disaster), disaster.status, disaster.radiusKm]
      );
      return mapContext(rows[0]);
    },

    /** Locks the row: reactions are merged read-modify-write in one transaction. */
    async getContextForUpdate(disasterId) {
      const { rows } = await db.query(`SELECT * FROM disaster_context WHERE disaster_id = $1 FOR UPDATE`, [disasterId]);
      return mapContext(rows[0]);
    },

    async getContext(disasterId) {
      const { rows } = await db.query(`SELECT * FROM disaster_context WHERE disaster_id = $1`, [disasterId]);
      return mapContext(rows[0]);
    },

    async saveReactions(disasterId, reactions) {
      await db.query(`UPDATE disaster_context SET reactions = $2, updated_at = now() WHERE disaster_id = $1`, [disasterId, JSON.stringify(reactions)]);
    },

    /** Disasters still without a revision-1 plan, detected more than `seconds` ago (the planning sweep). */
    async findUnplannedOlderThan(seconds) {
      const { rows } = await db.query(
        `SELECT c.disaster_id FROM disaster_context c
          WHERE c.status <> 'RESOLVED'
            AND c.detected_at < now() - make_interval(secs => $1)
            AND NOT EXISTS (SELECT 1 FROM response_plans p WHERE p.disaster_id = c.disaster_id AND p.revision = 1)
          LIMIT 50`,
        [seconds]
      );
      return rows.map((r) => r.disaster_id);
    },

    /** Escalated disasters whose follow-up plan is overdue (the planning sweep). */
    async findEscalatedWithoutFollowUp(seconds) {
      const { rows } = await db.query(
        `SELECT p.disaster_id FROM response_actions a
           JOIN response_plans p ON p.id = a.plan_id
          WHERE a.kind = 'disaster.widen_radius' AND a.status = 'SUCCEEDED'
            AND a.finished_at < now() - make_interval(secs => $1)
            AND NOT EXISTS (SELECT 1 FROM response_plans p2 WHERE p2.disaster_id = p.disaster_id AND p2.revision = 2)
          LIMIT 50`,
        [seconds]
      );
      return rows.map((r) => r.disaster_id);
    },

    // --- plans --------------------------------------------------------------
    /** Inserts a plan and its actions; null if this disaster+revision already has one. */
    async insertPlan({ disasterId, revision, status, mode, needs, disaster, actions }) {
      const { rows } = await db.query(
        `INSERT INTO response_plans (disaster_id, revision, status, mode, needs, disaster)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (disaster_id, revision) DO NOTHING
         RETURNING *`,
        [disasterId, revision, status, mode, JSON.stringify(needs), JSON.stringify(disaster)]
      );
      if (!rows[0]) return null;
      const planId = rows[0].id;
      for (const [i, a] of actions.entries()) {
        await db.query(
          `INSERT INTO response_actions (plan_id, seq, kind, params, reason, status) VALUES ($1, $2, $3, $4, $5, $6)`,
          [planId, i + 1, a.kind, JSON.stringify(a.params), a.reason, a.kind === "notice" ? "INFO" : "PROPOSED"]
        );
      }
      return this.getPlan(planId);
    },

    async getPlan(id) {
      const { rows } = await db.query(`SELECT * FROM response_plans WHERE id = $1`, [id]);
      if (!rows[0]) return null;
      return mapPlan(rows[0], (await actionsFor([id])).get(id));
    },

    async findPlan(disasterId, revision) {
      const { rows } = await db.query(`SELECT * FROM response_plans WHERE disaster_id = $1 AND revision = $2`, [disasterId, revision]);
      return rows[0] ? this.getPlan(rows[0].id) : null;
    },

    async listPlans({ disasterId, status, limit = 20 }) {
      const where = [];
      const params = [];
      if (disasterId) { params.push(disasterId); where.push(`disaster_id = $${params.length}`); }
      if (status) { params.push(status); where.push(`status = $${params.length}`); }
      params.push(limit);
      const { rows } = await db.query(
        `SELECT * FROM response_plans ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY created_at DESC, revision DESC LIMIT $${params.length}`,
        params
      );
      const byPlan = await actionsFor(rows.map((r) => r.id));
      return rows.map((r) => mapPlan(r, byPlan.get(r.id)));
    },

    /**
     * Conditional status change: only if the plan is currently in one of
     * `from` (so two operators can't both approve it). Returns the updated
     * row, or null if it wasn't. Options stamp who/when.
     */
    async transitionPlan(id, from, to, { decidedBy, decisionNote, undoneBy, decided = false, finished = false, undone = false } = {}) {
      const { rows } = await db.query(
        `UPDATE response_plans SET
            status        = $3,
            decided_by    = CASE WHEN $4 THEN $5::uuid ELSE decided_by END,
            decided_at    = CASE WHEN $4 THEN now() ELSE decided_at END,
            decision_note = CASE WHEN $4 THEN $6 ELSE decision_note END,
            finished_at   = CASE WHEN $7 THEN now() ELSE finished_at END,
            undone_by     = CASE WHEN $8 THEN $9::uuid ELSE undone_by END,
            undone_at     = CASE WHEN $8 THEN now() ELSE undone_at END
          WHERE id = $1 AND status = ANY($2::text[])
          RETURNING *`,
        [id, from, to, decided, decidedBy ?? null, decisionNote ?? null, finished, undone, undoneBy ?? null]
      );
      return rows[0] || null;
    },

    async plansOf(disasterId, statuses) {
      const { rows } = await db.query(`SELECT id FROM response_plans WHERE disaster_id = $1 AND status = ANY($2::text[])`, [disasterId, statuses]);
      return rows.map((r) => r.id);
    },

    // --- actions ------------------------------------------------------------
    async markActionSent(actionId, commandId) {
      await db.query(`UPDATE response_actions SET status = 'PENDING', command_id = $2, sent_at = now() WHERE id = $1`, [actionId, commandId]);
    },

    async markActionUndoing(actionId, undoCommandId) {
      await db.query(`UPDATE response_actions SET status = 'UNDOING', undo_command_id = $2, sent_at = now() WHERE id = $1`, [actionId, undoCommandId]);
    },

    async skipProposedActions(planId) {
      await db.query(`UPDATE response_actions SET status = 'SKIPPED' WHERE plan_id = $1 AND status = 'PROPOSED'`, [planId]);
    },

    /** The action a command (or undo command) reply belongs to, locked. */
    async findActionByCommandForUpdate(commandId) {
      const { rows } = await db.query(
        `SELECT * FROM response_actions WHERE command_id = $1 OR undo_command_id = $1 FOR UPDATE`,
        [commandId]
      );
      return rows[0] ? mapAction(rows[0]) : null;
    },

    async finishAction(actionId, status, { result = null, error = null } = {}) {
      await db.query(
        `UPDATE response_actions SET status = $2, result = COALESCE($3, result), error = $4, finished_at = now() WHERE id = $1`,
        [actionId, status, result === null ? null : JSON.stringify(result), error === null ? null : JSON.stringify(error)]
      );
    },

    /** Actions whose command got no reply within `seconds` (the timeout sweep). */
    async findTimedOutActions(seconds) {
      const { rows } = await db.query(
        `SELECT * FROM response_actions WHERE status IN ('PENDING','UNDOING') AND sent_at < now() - make_interval(secs => $1) LIMIT 100`,
        [seconds]
      );
      return rows.map(mapAction);
    },

    async countPlansByStatus() {
      const { rows } = await db.query(`SELECT status, count(*)::int AS n FROM response_plans GROUP BY status`);
      return rows;
    },
  };
}
