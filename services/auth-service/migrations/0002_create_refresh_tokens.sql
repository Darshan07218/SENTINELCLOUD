-- 0002_create_refresh_tokens.sql
-- Refresh tokens are stored hashed (never in plaintext) so a database
-- leak alone doesn't hand out valid tokens. Each row represents one
-- issued refresh token; logout/rotation marks it revoked rather than
-- deleting it, which keeps an audit trail of session activity.

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash         TEXT NOT NULL UNIQUE,
    issued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at         TIMESTAMPTZ NOT NULL,
    revoked_at         TIMESTAMPTZ,
    replaced_by_hash   TEXT,
    user_agent         TEXT,
    ip_address         TEXT
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
