-- 0001_create_roles_and_users.sql
-- Core identity schema: roles + users.
-- Applied by the lightweight migration runner in src/db/migrate.js —
-- see that file for how/when this runs.

-- citext gives us case-insensitive, unique email comparisons at the
-- database level (so "User@Example.com" and "user@example.com" collide
-- correctly) without the application having to remember to lowercase
-- everywhere. Bundled with Postgres contrib (present in the official
-- postgres:16 image) and a "trusted" extension, so the service's own
-- database owner role may create it.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- provides gen_random_uuid()

CREATE TABLE IF NOT EXISTS roles (
    id          SMALLSERIAL PRIMARY KEY,
    name        VARCHAR(32) NOT NULL UNIQUE,
    description TEXT NOT NULL
);

INSERT INTO roles (name, description) VALUES
    ('CITIZEN',              'Read-only access to public dashboard, disaster alerts, and nearby service status.'),
    ('EMERGENCY_OPERATOR',   'Dispatches ambulances, acknowledges and escalates disaster events, views all domain data.'),
    ('HOSPITAL_ADMIN',       'Manages their hospital''s bed/ICU capacity and patient load data.'),
    ('INFRASTRUCTURE_ADMIN', 'Manages substations/transformers and acknowledges power risk alerts.'),
    ('SYSTEM_ADMIN',         'Full read/write across all domains, plus user and role management.')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         CITEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name     VARCHAR(120) NOT NULL,
    role_id       SMALLINT NOT NULL REFERENCES roles(id),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_role_id ON users(role_id);

-- Keep updated_at accurate without relying on application code to set it.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
