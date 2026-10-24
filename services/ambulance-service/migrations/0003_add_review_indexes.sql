-- 0003_add_review_indexes.sql
-- Engineering review: GET /emergencies (ORDER BY created_at DESC, optional
-- status filter) and GET /emergencies/active (status IN (...) ORDER BY
-- created_at) previously sorted the whole table. A composite index serves
-- both the filter and the order.
CREATE INDEX IF NOT EXISTS idx_emergencies_status_created ON emergencies(status, created_at);
CREATE INDEX IF NOT EXISTS idx_emergencies_created ON emergencies(created_at DESC);
