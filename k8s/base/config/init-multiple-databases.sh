#!/bin/bash
# =========================================================================
# Creates one database AND one database user per microservice inside the
# single Postgres container (Docker Compose and Kubernetes).
#
# Postgres's official image runs every .sh/.sql file in
# /docker-entrypoint-initdb.d/ once, when the data volume is first
# initialised. The script is also safe to re-run (every step is
# idempotent), e.g. to apply a changed password:
#   docker compose exec postgres bash /docker-entrypoint-initdb.d/init-multiple-databases.sh
#   kubectl exec -n sentinelcloud postgres-0 -- bash /docker-entrypoint-initdb.d/init-multiple-databases.sh
#
# Phase 12 — least privilege. Before, every service logged in as the
# Postgres SUPERUSER, so one compromised service (or one SQL injection)
# could read every other service's data — including password hashes in
# auth_db — and even run programs inside the container (COPY ... PROGRAM).
# Now each service has its own login role that:
#   * owns exactly one database (so it can run its own migrations),
#   * cannot connect to any other database (CONNECT revoked from PUBLIC),
#   * is not a superuser and cannot create roles or databases.
# The superuser (POSTGRES_USER) is used only by this script.
#
# Input: POSTGRES_SERVICE_DATABASES, comma-separated "database:user:PASSWORD_VAR"
# entries, e.g. "auth_db:auth_svc:AUTH_DB_PASSWORD". The password itself is
# read from the environment variable named in the third field (injected
# from .env / the Kubernetes Secret), so no password appears in this file
# or in the ConfigMap.
#
# Kubernetes keeps the same layout: a copy of this script lives at
# k8s/base/config/init-multiple-databases.sh (Kustomize can't read files
# outside k8s/) — keep the two in sync.
# =========================================================================
set -euo pipefail

function setup_service_database() {
	local database=$1 user=$2 password_var=$3
	local password="${!password_var:-}"
	if [ -z "$password" ]; then
		echo "SentinelCloud: $password_var is not set — cannot create user '$user' for '$database'." >&2
		exit 1
	fi
	echo "  -> database '$database' owned by its own user '$user'"
	# psql variables (:'name') are quoted by psql itself and format(%I/%L)
	# quotes identifiers/literals, so no value is ever spliced into SQL text.
	psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
		-v db="$database" -v usr="$user" -v pw="$password" <<-'EOSQL'
	SELECT format('CREATE ROLE %I LOGIN', :'usr')
	 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'usr') \gexec
	SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'usr', :'pw') \gexec
	SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'usr')
	 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db') \gexec
	SELECT format('ALTER DATABASE %I OWNER TO %I', :'db', :'usr') \gexec
	SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
	SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', :'db', :'usr') \gexec
	EOSQL
	# Inside the database: the service owns the public schema it migrates into.
	psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$database" -v usr="$user" <<-'EOSQL'
	SELECT format('ALTER SCHEMA public OWNER TO %I', :'usr') \gexec
	REVOKE CREATE ON SCHEMA public FROM PUBLIC;
	EOSQL
}

if [ -n "${POSTGRES_SERVICE_DATABASES:-}" ]; then
	echo "SentinelCloud: creating per-service databases and users"
	IFS=',' read -ra ENTRIES <<< "$POSTGRES_SERVICE_DATABASES"
	for entry in "${ENTRIES[@]}"; do
		IFS=':' read -r db user pwvar <<< "$(echo "$entry" | xargs)"
		if [ -z "${db:-}" ] || [ -z "${user:-}" ] || [ -z "${pwvar:-}" ]; then
			echo "SentinelCloud: bad POSTGRES_SERVICE_DATABASES entry '$entry' (want db:user:PASSWORD_VAR)" >&2
			exit 1
		fi
		setup_service_database "$db" "$user" "$pwvar"
	done
	# Nobody but the superuser needs the "postgres" maintenance database.
	psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -c 'REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;'
	echo "SentinelCloud: per-service databases ready."
else
	echo "SentinelCloud: POSTGRES_SERVICE_DATABASES not set, skipping."
fi
