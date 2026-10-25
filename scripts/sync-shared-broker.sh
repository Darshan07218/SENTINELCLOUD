#!/usr/bin/env bash
# Copies the canonical Phase 14 messaging modules from shared/node-broker/
# into each Node service's src/ folder (same approach as
# sync-shared-security.sh: each service is its own Docker build context).
# shared/node-broker/tests/copies.test.js fails if a copy drifts.
#
#   ./scripts/sync-shared-broker.sh      (Windows: .\scripts\sync-shared-broker.ps1)
set -euo pipefail
cd "$(dirname "$0")/.."

# broker.js: every service that publishes or consumes domain events.
for svc in hospital-service ambulance-service disaster-service notification-service response-service; do
  cp shared/node-broker/broker.js "services/${svc}/src/broker.js"
  echo "synced broker.js -> services/${svc}/src/"
done
# outbox.js: the services that save a change and then publish its event.
for svc in hospital-service ambulance-service disaster-service response-service; do
  cp shared/node-broker/outbox.js "services/${svc}/src/outbox.js"
  echo "synced outbox.js -> services/${svc}/src/"
done
# commands.js (Phase 15): the services that execute response-service's commands.
for svc in ambulance-service disaster-service hospital-service; do
  cp shared/node-broker/commands.js "services/${svc}/src/commands.js"
  echo "synced commands.js -> services/${svc}/src/"
done
