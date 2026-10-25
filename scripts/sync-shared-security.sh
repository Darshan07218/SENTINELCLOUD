#!/usr/bin/env bash
# Copies the canonical Phase 12 security modules from shared/node-security/
# into every Node service's src/security/ folder.
#
# Each service is built as its own Docker context (services/<name>/), so a
# file outside that folder can't be imported at runtime. Same approach as
# metrics.js (Phase 10) and chaos.js (Phase 11): one canonical copy, synced.
# tests in shared/node-security/tests verify the copies are identical.
#
#   ./scripts/sync-shared-security.sh
set -euo pipefail
cd "$(dirname "$0")/.."

FILES=(secrets.js audit.js jwt.js)
SERVICES=(gateway auth-service hospital-service ambulance-service disaster-service notification-service resilience-service response-service simulator-service intake-service)

for svc in "${SERVICES[@]}"; do
  mkdir -p "services/${svc}/src/security"
  for f in "${FILES[@]}"; do
    cp "shared/node-security/${f}" "services/${svc}/src/security/${f}"
  done
  echo "synced -> services/${svc}/src/security/"
done
