#!/usr/bin/env bash
# =========================================================================
# Phase 17: runs tests/db/realPostgres.test.js against a THROWAWAY Postgres
# built from the project's own init script (one database + login role per
# service), then removes it. Never touches the Compose or Kubernetes
# databases. Used by CI (.github/workflows/ci.yml) and on Linux / WSL.
#
#   ./scripts/run-db-tests.sh
#
# Needs Docker and Node 20+, and `npm ci` already run in the Node services
# (the suite imports their real modules). Exit code: the test run's.
# =========================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="sc-db-tests-$$"
PORT="${SC_DB_TEST_PORT:-55432}"
# Where the test database is published and reached. The defaults keep it on
# this machine only; running this script inside a container that drives the
# host's Docker needs e.g. SC_DB_TEST_BIND=0.0.0.0 SC_DB_TEST_HOST=host.docker.internal.
BIND="${SC_DB_TEST_BIND:-127.0.0.1}"
HOST="${SC_DB_TEST_HOST:-127.0.0.1}"
DATABASES=(AUTH:auth_db:auth_svc HOSPITAL:hospital_db:hospital_svc AMBULANCE:ambulance_db:ambulance_svc BLOOD_BANK:blood_db:blood_bank_svc POWER:power_db:power_svc DISASTER:disaster_db:disaster_svc RESPONSE:response_db:response_svc)

rand() { node -p 'require("crypto").randomBytes(16).toString("hex")'; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

envs=(-e POSTGRES_USER=sentinel -e "POSTGRES_PASSWORD=$(rand)")
spec=""
for entry in "${DATABASES[@]}"; do
  IFS=: read -r var db user <<<"$entry"
  pw="$(rand)"
  envs+=(-e "${var}_DB_PASSWORD=$pw")
  export "${var}_DB_PASSWORD=$pw"
  spec+="${spec:+,}${db}:${user}:${var}_DB_PASSWORD"
done
envs+=(-e "POSTGRES_SERVICE_DATABASES=$spec")

echo ">>> starting throwaway Postgres ($NAME on $BIND:$PORT)"
docker run -d --name "$NAME" "${envs[@]}" -p "$BIND:$PORT:5432" \
  -v "$PWD/infrastructure/postgres-init:/docker-entrypoint-initdb.d:ro" postgres:16-alpine >/dev/null

# TCP, not the socket: during init the image runs a temporary socket-only server.
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U sentinel && break
  sleep 2
done
sleep 2

echo ">>> running tests/db/realPostgres.test.js"
SC_DB_TEST=1 SC_DB_TEST_ALLOW_RESET=1 PGHOST="$HOST" PGPORT="$PORT" \
  node --test --test-reporter=spec tests/db/realPostgres.test.js
