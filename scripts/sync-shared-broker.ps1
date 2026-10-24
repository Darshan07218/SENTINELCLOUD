<#
  Windows PowerShell version of scripts/sync-shared-broker.sh: copies the
  canonical Phase 14 messaging modules from shared/node-broker/ into each Node
  service's src/ folder. shared/node-broker/tests/copies.test.js fails if a
  copy drifts.

    .\scripts\sync-shared-broker.ps1
#>
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

# broker.js: every service that publishes or consumes domain events.
foreach ($svc in "hospital-service", "ambulance-service", "disaster-service", "notification-service", "response-service") {
  Copy-Item shared/node-broker/broker.js "services/$svc/src/broker.js" -Force
  Write-Host "synced broker.js -> services/$svc/src/"
}
# outbox.js: the services that save a change and then publish its event.
foreach ($svc in "hospital-service", "ambulance-service", "disaster-service", "response-service") {
  Copy-Item shared/node-broker/outbox.js "services/$svc/src/outbox.js" -Force
  Write-Host "synced outbox.js -> services/$svc/src/"
}
# commands.js (Phase 15): the services that execute response-service's commands.
foreach ($svc in "ambulance-service", "disaster-service") {
  Copy-Item shared/node-broker/commands.js "services/$svc/src/commands.js" -Force
  Write-Host "synced commands.js -> services/$svc/src/"
}
