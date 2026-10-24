#!/bin/sh
# Phase 14: dead-lettering for SentinelCloud's durable queues
# (docs/PHASE-14-RELIABLE-EVENTS.md section 2.3).
#
# Runs INSIDE the RabbitMQ container after it starts: Kubernetes runs it as
# the StatefulSet's postStart hook, Docker Compose as the service's
# post_start hook. Waits for the broker, then applies one policy, which is
# idempotent, so running it on every start is safe.
#
# Why a policy and not queue arguments: arguments can't be changed on an
# existing durable queue (redeclaring with new ones fails with
# PRECONDITION_FAILED), and every install already has these queues. A policy
# can be added to existing queues at any time and needs no code change in
# the services.
#
# The per-pod live queues (q.notifications.live.*) are left out on purpose:
# a lost live-feed push is harmless and the event is still in Redis history.
# The exchange and q.dead-letters it routes to are declared by every service
# on connect (broker.js, RabbitConfig.java).

# Into the container's own log when allowed (the subshell keeps a failed
# redirect's error message quiet), otherwise to this hook's output.
log() { (echo "[sentinel-dead-letter] $*" > /proc/1/fd/1) 2>/dev/null || echo "[sentinel-dead-letter] $*"; }

i=0
until rabbitmqctl -q await_startup --timeout 10 >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    log "RabbitMQ did not start within ~5 minutes; dead-letter policy NOT applied"
    exit 0 # never fail the hook: that would kill the broker container
  fi
  sleep 5
done

# Phase 15 added response-service's queue and the three command queues.
if rabbitmqctl -q set_policy --apply-to queues --priority 1 sentinel-dead-letter \
  '^q\.((hospital|ambulance|bloodbank|power)\.disaster-events|disaster\.reaction-aggregator|notifications\.all-events|response\.events|(ambulance|bloodbank|disaster)\.commands)$' \
  '{"dead-letter-exchange":"sentinelcloud.dlx"}' >/dev/null 2>&1; then
  log "policy applied: failed messages on the ten durable queues go to sentinelcloud.dlx -> q.dead-letters"
else
  log "FAILED to apply the dead-letter policy"
fi
exit 0