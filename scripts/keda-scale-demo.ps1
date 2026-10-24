# =========================================================================
# Phase 17: KEDA scale-out demo on Docker Desktop Kubernetes.
#
# Shows notification-service going 1 -> 3 replicas on queue length:
#   1. pause the consumer (KEDA paused-replicas=0),
#   2. put a large backlog straight into q.notifications.all-events,
#   3. show KEDA's external metric = RabbitMQ's queue depth,
#   4. resume and record queue depth / HPA desired / ready replicas until
#      the backlog is gone.
#
# Why a synthetic backlog: a scenario produces ~36 events, which one replica
# drains before the HPA's ~15 s sync, so scale-out never shows. The history
# consumer does one Redis write per event, so it takes thousands.
#
# The load messages don't touch the dashboard: they go to the history queue
# only (default exchange, not the topic exchange, so no other service and no
# live WebSocket queue sees them), and they all carry one eventId whose
# "seen" marker is set in Redis first, so notification-service treats every
# one as a duplicate (one SET NX, ack) and never adds it to the recent-events
# list. The marker is removed at the end.
#
#   .\scripts\keda-scale-demo.ps1                 # 30000 messages
#   .\scripts\keda-scale-demo.ps1 -Messages 60000 -MaxSeconds 300
# =========================================================================
param(
  [int]$Messages = 30000,
  [int]$MaxSeconds = 240,
  [string]$Context = "docker-desktop"
)
$ErrorActionPreference = "Stop"
$ns = "sentinelcloud"
$queue = "q.notifications.all-events"
$runId = "keda-load-" + (Get-Date -Format "yyyyMMddHHmmss")
$seenKey = "sentinelcloud:events:seen:$runId"

function Kc { & kubectl.exe --context $Context -n $ns @args }

function Get-QueueDepth {
  $line = Kc exec rabbitmq-0 '--' rabbitmqctl -q list_queues name messages consumers |
    Where-Object { $_ -match "^$([regex]::Escape($queue))\s" } | Select-Object -First 1
  if (-not $line) { return $null }
  $parts = $line -split "\s+"
  [pscustomobject]@{ Messages = [int]$parts[1]; Consumers = [int]$parts[2] }
}

function Get-KedaMetric {
  $path = "/apis/external.metrics.k8s.io/v1beta1/namespaces/$ns/s0-rabbitmq-q-notifications-all-events?labelSelector=scaledobject.keda.sh%2Fname%3Dnotification-service"
  $raw = & kubectl.exe --context $Context get --raw $path
  if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
  $item = ($raw | ConvertFrom-Json).items | Select-Object -First 1
  if ($item) { $item.value } else { $null }
}

function Get-Replicas {
  $ready = Kc get deploy notification-service -o "jsonpath={.status.readyReplicas}"
  if (-not $ready) { $ready = 0 }
  # KEDA deletes its HPA while paused, hence --ignore-not-found.
  $desired = Kc get hpa notification-service --ignore-not-found -o "jsonpath={.status.desiredReplicas}"
  if ($LASTEXITCODE -ne 0 -or -not $desired) { $desired = "-" }
  [pscustomobject]@{ Ready = [int]$ready; Desired = $desired }
}

function Set-Paused([bool]$paused) {
  if ($paused) { Kc annotate scaledobject notification-service autoscaling.keda.sh/paused-replicas=0 --overwrite | Out-Null }
  else { Kc annotate scaledobject notification-service autoscaling.keda.sh/paused-replicas- | Out-Null }
}

Kc get scaledobject notification-service -o name | Out-Null
if ($LASTEXITCODE -ne 0) { throw "No ScaledObject notification-service: deploy with KEDA first (.\scripts\k8s-desktop.ps1 deploy)" }

$publisher = @'
const amqp = require("amqplib");
(async () => {
  const conn = await amqp.connect(process.env.RABBITMQ_URL);
  const ch = await conn.createConfirmChannel();
  const body = Buffer.from(JSON.stringify({
    eventId: "__ID__", eventType: "keda.load-test", source: "keda-scale-demo",
    occurredAt: new Date().toISOString(), payload: {}
  }));
  for (let i = 0; i < __N__; i++) {
    if (!ch.sendToQueue("__Q__", body, { contentType: "application/json" })) {
      await new Promise((r) => ch.once("drain", r));
    }
  }
  await ch.waitForConfirms();
  await conn.close();
  console.log("published __N__ messages (confirmed)");
})().catch((e) => { console.error(e.message); process.exit(1); });
'@
$publisher = $publisher.Replace("__ID__", $runId).Replace("__N__", "$Messages").Replace("__Q__", $queue)

$paused = $false
try {
  Write-Host ">>> marking event id $runId as already seen (load stays out of the event history)"
  Kc exec redis-0 '--' sh -c ('redis-cli -a $REDIS_PASSWORD --no-auth-warning SET ' + $seenKey + ' 1 EX 3600') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "could not set the Redis marker" }

  Write-Host ">>> pausing notification-service at 0 replicas"
  Set-Paused $true; $paused = $true
  $deadline = (Get-Date).AddSeconds(90)
  do {
    Start-Sleep 3
    $q = Get-QueueDepth
    $r = Get-Replicas
  } until (($r.Ready -eq 0 -and $q -and $q.Consumers -eq 0) -or (Get-Date) -gt $deadline)
  if ($q.Consumers -ne 0) { throw "consumers still attached after 90 s" }

  Write-Host ">>> publishing $Messages messages to $queue"
  # Piped straight to kubectl: a function's pipeline input doesn't reach a
  # native command inside it.
  $publisher | & kubectl.exe --context $Context -n $ns exec -i deploy/hospital-service -- node -
  if ($LASTEXITCODE -ne 0) { throw "publishing failed" }

  Start-Sleep 3
  $q = Get-QueueDepth
  $metric = Get-KedaMetric
  Write-Host (">>> backlog: RabbitMQ {0} messages, {1} consumers; KEDA external metric value {2}" -f $q.Messages, $q.Consumers, $metric)

  Write-Host ">>> resuming: HPA target is 20 messages per replica, max 3"
  Set-Paused $false; $paused = $false
  $start = Get-Date
  $maxReady = 0
  $timeToMax = $null
  $drainedAt = $null
  "{0,6}  {1,9}  {2,8}  {3,6}" -f "t(s)", "queue", "desired", "ready" | Write-Host
  do {
    $q = Get-QueueDepth
    $r = Get-Replicas
    $t = [int]((Get-Date) - $start).TotalSeconds
    "{0,6}  {1,9}  {2,8}  {3,6}" -f $t, $q.Messages, $r.Desired, $r.Ready | Write-Host
    if ($r.Ready -gt $maxReady) { $maxReady = $r.Ready; if ($maxReady -ge 3) { $timeToMax = $t } }
    if ($q.Messages -eq 0 -and -not $drainedAt) { $drainedAt = $t }
    if ($drainedAt -and $maxReady -ge 3) { break }
    Start-Sleep 3
  } until (((Get-Date) - $start).TotalSeconds -gt $MaxSeconds)

  Write-Host ""
  Write-Host ">>> result: max ready replicas $maxReady$(if ($timeToMax) { " (reached at ${timeToMax}s)" }); backlog $(if ($drainedAt) { "drained at ${drainedAt}s" } else { "NOT drained within ${MaxSeconds}s" })"
  Write-Host ">>> scale-down to 1 follows the HPA behaviour (120 s window, 1 pod per 60 s): about 4 minutes"
  if ($maxReady -lt 3) { exit 2 }
}
finally {
  if ($paused) { Write-Host ">>> resuming notification-service"; Set-Paused $false }
  Kc exec redis-0 '--' sh -c ('redis-cli -a $REDIS_PASSWORD --no-auth-warning DEL ' + $seenKey) | Out-Null
}
