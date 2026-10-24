#!/bin/sh
# Phase 15: make sure every service's database and login role exist, on EVERY
# Postgres start (docs/PHASE-15-RESPONSE-ENGINE.md §5).
#
# Postgres runs /docker-entrypoint-initdb.d/init-multiple-databases.sh only
# when its data volume is empty, so a database added later (response_db) never
# appeared on an existing install. That script is idempotent, so this hook
# simply runs it again once the server accepts connections. Kubernetes runs
# it as the StatefulSet's postStart hook, Docker Compose as the service's
# post_start hook. It's mounted outside /docker-entrypoint-initdb.d on purpose,
# so the image doesn't also run it during first-time initialisation.

# Into the container's own log when allowed (the subshell keeps a failed
# redirect's error message quiet), otherwise to this hook's output.
log() { (echo "[ensure-databases] $*" > /proc/1/fd/1) 2>/dev/null || echo "[ensure-databases] $*"; }

# TCP, not the socket: during first-time init the entrypoint runs a temporary
# socket-only server, and the init script already runs inside that.
i=0
until pg_isready -q -h 127.0.0.1 -U "$POSTGRES_USER"; do
  i=$((i + 1))
  if [ "$i" -ge 90 ]; then
    log "Postgres not accepting connections after ~3 minutes; databases NOT checked"
    exit 0 # never fail the hook: that would kill the database container
  fi
  sleep 2
done

if bash /docker-entrypoint-initdb.d/init-multiple-databases.sh > /tmp/ensure-databases.log 2>&1; then
  log "all service databases and roles present"
else
  log "FAILED (see below)"
  (cat /tmp/ensure-databases.log > /proc/1/fd/1) 2>/dev/null || cat /tmp/ensure-databases.log
fi
exit 0