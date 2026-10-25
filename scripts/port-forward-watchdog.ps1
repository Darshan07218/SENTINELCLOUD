<#
  Phase 19: self-healing port-forwards (started hidden by `k8s-desktop.ps1 forward`/`up`).

  `kubectl port-forward` is bound to ONE pod: when that pod is replaced
  (rollout, crash, node restart) the forward dies or stops answering, and
  http://localhost:30080 goes dead until someone runs `forward` again.
  This loop keeps every forward alive: every few seconds it restarts a
  forward whose kubectl process exited, or whose URL failed two checks in a
  row. It exits by itself when the cluster has been unreachable for 10
  minutes (Docker Desktop stopped); `up` starts it again.

  Log: %TEMP%\sentinelcloud-port-forward.log
#>
param(
  [string]$Context = "docker-desktop",
  [string]$Namespace = "sentinelcloud",
  [int]$IntervalSeconds = 5
)

$ErrorActionPreference = "Continue"
$Log = Join-Path $env:TEMP "sentinelcloud-port-forward.log"

# local port -> target, remote port, health URL
$Forwards = @(
  @{ Port = 30080; Target = "svc/frontend";     Remote = 80;   Url = "http://127.0.0.1:30080/" }
  @{ Port = 30030; Target = "svc/grafana";      Remote = 3000; Url = "http://127.0.0.1:30030/api/health" }
  @{ Port = 30090; Target = "svc/prometheus";   Remote = 9090; Url = "http://127.0.0.1:30090/-/ready" }
  @{ Port = 30093; Target = "svc/alertmanager"; Remote = 9093; Url = "http://127.0.0.1:30093/-/ready" }
)

function Write-Log($msg) {
  $line = "{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $msg
  try { Add-Content -Path $Log -Value $line -Encoding utf8 } catch { }
  # Keep the log small: last 500 lines.
  try { if ((Get-Item $Log).Length -gt 200KB) { Set-Content $Log -Value (Get-Content $Log -Tail 500) -Encoding utf8 } } catch { }
}

function Test-Url($url) {
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 4
    return $r.StatusCode -lt 500
  } catch {
    # A 4xx still proves the forward and the pod answer.
    $code = $_.Exception.Response.StatusCode.value__
    return ($code -ge 400 -and $code -lt 500)
  }
}

function Start-Forward($f) {
  if ($f.Process -and -not $f.Process.HasExited) {
    try { Stop-Process -Id $f.Process.Id -Force } catch { }
  }
  $f.Process = Start-Process kubectl.exe -WindowStyle Hidden -PassThru -ArgumentList @(
    "--context", $Context, "port-forward", "-n", $Namespace, "--address", "127.0.0.1", $f.Target, "$($f.Port):$($f.Remote)")
  $f.Failures = 0
  $f.StartedAt = Get-Date
  Write-Log "started forward :$($f.Port) -> $($f.Target):$($f.Remote) (pid $($f.Process.Id))"
}

Write-Log "watchdog started (pid $PID, context $Context)"
foreach ($f in $Forwards) { Start-Forward $f }
$unreachableSince = $null

while ($true) {
  Start-Sleep -Seconds $IntervalSeconds

  kubectl.exe --context $Context get --raw /readyz 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    if (-not $unreachableSince) { $unreachableSince = Get-Date; Write-Log "cluster unreachable" }
    if (((Get-Date) - $unreachableSince).TotalMinutes -ge 10) {
      Write-Log "cluster unreachable for 10 minutes - watchdog exiting"
      foreach ($f in $Forwards) { if ($f.Process -and -not $f.Process.HasExited) { Stop-Process -Id $f.Process.Id -Force } }
      exit 0
    }
    continue
  }
  if ($unreachableSince) { Write-Log "cluster reachable again"; $unreachableSince = $null }

  foreach ($f in $Forwards) {
    if (-not $f.Process -or $f.Process.HasExited) {
      Write-Log "forward :$($f.Port) exited - restarting"
      Start-Forward $f
      continue
    }
    # Give a fresh forward a moment before judging it.
    if (((Get-Date) - $f.StartedAt).TotalSeconds -lt 8) { continue }
    if (Test-Url $f.Url) {
      $f.Failures = 0
    } else {
      $f.Failures++
      if ($f.Failures -ge 2) {
        Write-Log "forward :$($f.Port) not answering ($($f.Url)) - restarting"
        Start-Forward $f
      }
    }
  }
}
