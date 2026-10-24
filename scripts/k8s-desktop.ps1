<#
  SentinelCloud on Docker Desktop's built-in Kubernetes (Windows PowerShell).

  The Kind workflow in docs/PHASE-9-KUBERNETES.md creates its own cluster with
  ports 30080/30030/30090/30093 mapped to localhost. Docker Desktop's cluster
  (context "docker-desktop") has no such mappings, so this script uses
  `kubectl port-forward` for the same URLs instead.

    .\scripts\k8s-desktop.ps1 deploy    # build the images, load them, install KEDA, apply, wait for Ready
    .\scripts\k8s-desktop.ps1 deploy -NoKeda   # the same without KEDA (CPU-based HPAs only)
    .\scripts\k8s-desktop.ps1 forward   # http://localhost:30080 (+ Grafana/Prometheus/Alertmanager)
    .\scripts\k8s-desktop.ps1 status    # pods, HPAs
    .\scripts\k8s-desktop.ps1 delete    # remove SentinelCloud from the cluster (incl. data)

  Needs k8s/overlays/local/secrets.env (see secrets.env.example).
  Run from the repository root.
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet("deploy", "forward", "status", "delete")]
  [string]$Action = "deploy",
  [string]$Context = "docker-desktop",
  [string]$Node = "desktop-control-plane",
  [string]$Tag = "1.0.0",
  # Phase 17: skip KEDA (queue-based autoscaling) and use k8s/overlays/local.
  [switch]$NoKeda
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$Namespace = "sentinelcloud"
# Phase 17: with KEDA, the local overlay plus queue-based autoscaling for
# notification-service (k8s/components/keda); -NoKeda uses the plain one.
$Overlay = if ($NoKeda) { "k8s/overlays/local" } else { "k8s/overlays/local-keda" }
$KedaVersion = "2.21.0"
$KedaImages = @("keda", "keda-metrics-apiserver", "keda-admission-webhooks") | ForEach-Object { "ghcr.io/kedacore/${_}:$KedaVersion" }

# image-name = build-context (same list as scripts/k8s-build-images.sh)
$Images = [ordered]@{
  "gateway"              = "services/gateway"
  "auth-service"         = "services/auth-service"
  "hospital-service"     = "services/hospital-service"
  "ambulance-service"    = "services/ambulance-service"
  "blood-bank-service"   = "services/blood-bank-service"
  "power-service"        = "services/power-service"
  "disaster-service"     = "services/disaster-service"
  "notification-service" = "services/notification-service"
  "resilience-service"   = "services/resilience-service"
  "response-service"     = "services/response-service"
  "simulator-service"    = "services/simulator-service"
  "frontend"             = "frontend"
}

# Third-party images the manifests use (k8s/base) plus metrics-server; keep in
# step with the image: lines there and $MetricsServerVersion below.
$MetricsServerVersion = "v0.9.0"
$InfraImages = @(
  "postgres:16-alpine"
  "redis:7-alpine"
  "rabbitmq:3.13-management-alpine"
  "prom/prometheus:v2.54.1"
  "prom/alertmanager:v0.27.0"
  "grafana/grafana:11.2.0"
  "registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.13.0"
  "busybox:1.36"
  "registry.k8s.io/metrics-server/metrics-server:$MetricsServerVersion"
)

# local port = service:port (the NodePorts the Kind cluster would expose)
$Forwards = [ordered]@{
  30080 = "svc/frontend:80"
  30030 = "svc/grafana:3000"
  30090 = "svc/prometheus:9090"
  30093 = "svc/alertmanager:9093"
}

function Step($msg) { Write-Host ">>> $msg" -ForegroundColor Cyan }

function Invoke-Native {
  # Native commands don't throw on a non-zero exit code in PowerShell 5.1.
  param([string]$Exe, [string[]]$Arguments)
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Exe $($Arguments -join ' ') failed (exit $LASTEXITCODE)" }
}

# Named Invoke-Kubectl, and calling kubectl.exe: PowerShell names are
# case-insensitive, so a function called "Kubectl" would call itself forever.
function Invoke-Kubectl([string[]]$Arguments) { Invoke-Native kubectl.exe (@("--context", $Context) + $Arguments) }

function Assert-Context {
  $contexts = kubectl.exe config get-contexts -o name
  if ($contexts -notcontains $Context) {
    throw "kubectl context '$Context' not found. Available: $($contexts -join ', '). Is Kubernetes enabled in Docker Desktop?"
  }
}

function Import-ImagesIntoNode {
  # Docker Desktop's kind node runs its own containerd and pulls images itself,
  # one at a time: a single stalled registry download blocks every pod behind it.
  # So every image the cluster needs is pulled on the host (where Docker's
  # downloads work) and streamed into the node, like `kind load`.
  $ErrorActionPreference = "Continue"
  docker exec $Node true 2>$null
  $reachable = $LASTEXITCODE -eq 0
  $ErrorActionPreference = "Stop"
  if (-not $reachable) {
    Write-Warning "Can't reach node container '$Node' - skipping image import. If pods stay in ErrImagePull/ContainerCreating, check the node name with: docker ps -a"
    return
  }
  $platform = "linux/" + (docker version -f "{{.Server.Arch}}")
  $all = @($Images.Keys | ForEach-Object { "sentinelcloud/${_}:$Tag" }) + $InfraImages
  if (-not $NoKeda) { $all += $KedaImages }
  foreach ($image in $all) {
    if (-not (docker images -q $image)) {
      Step "pulling $image"
      Invoke-Native docker @("pull", "--platform", $platform, $image)
    }
    Step "loading $image into $Node"
    # Through cmd.exe: a PowerShell 5.1 pipe corrupts binary data. --platform:
    # multi-arch images only have the host's platform locally, so
    # --all-platforms would fail on the missing ones.
    cmd /c "docker save --platform $platform $image | docker exec -i $Node ctr --namespace=k8s.io images import --platform $platform --digests --snapshotter=overlayfs - >nul"
    if ($LASTEXITCODE -ne 0) { throw "loading $image into $Node failed (exit $LASTEXITCODE)" }
  }
}

function Install-MetricsServer {
  # The HPAs (and the traffic-surge drill) need CPU metrics.
  # "Continue": in PowerShell 5.1 a redirected native stderr line would otherwise throw.
  $ErrorActionPreference = "Continue"
  kubectl.exe --context $Context get deployment metrics-server -n kube-system 2>$null | Out-Null
  $exists = $LASTEXITCODE -eq 0
  $ErrorActionPreference = "Stop"
  if ($exists) { return }
  Step "installing metrics-server (for the HPAs)"
  # Pinned (not "latest"), so its image is the one Import-ImagesIntoNode loaded.
  Invoke-Kubectl @("apply", "-f", "https://github.com/kubernetes-sigs/metrics-server/releases/download/$MetricsServerVersion/components.yaml")
  Invoke-Kubectl @("patch", "deployment", "metrics-server", "-n", "kube-system", "--type=json", "--patch-file", "k8s/cluster/metrics-server-kind-patch.json")
}

function Install-Keda {
  # Phase 17: KEDA (queue-based autoscaling), pinned like metrics-server so its
  # images are the ones Import-ImagesIntoNode loaded. Server-side apply: its
  # CRDs are too big for client-side apply's annotation.
  Step "installing KEDA $KedaVersion"
  Invoke-Kubectl @("apply", "--server-side", "--force-conflicts", "-f", "https://github.com/kedacore/keda/releases/download/v$KedaVersion/keda-$KedaVersion.yaml")
  foreach ($d in "keda-operator", "keda-metrics-apiserver", "keda-admission") {
    Invoke-Kubectl @("rollout", "status", "deployment/$d", "-n", "keda", "--timeout=300s")
  }
}

function Remove-CpuOnlyHpa {
  # Upgrading an existing install to KEDA: `kubectl apply` doesn't delete the
  # CPU-only HPA that k8s/components/keda removes from the manifests, and KEDA
  # refuses to manage a Deployment another HPA already controls. Delete it only
  # if it is NOT KEDA's own (KEDA labels its HPAs managed-by=keda-operator);
  # KEDA creates the replacement within seconds, replicas stay as they are.
  $ErrorActionPreference = "Continue"
  $managedBy = kubectl.exe --context $Context get hpa notification-service -n $Namespace -o "jsonpath={.metadata.labels.app\.kubernetes\.io/managed-by}" 2>$null
  $exists = $LASTEXITCODE -eq 0
  $ErrorActionPreference = "Stop"
  if ($exists -and $managedBy -ne "keda-operator") {
    Step "replacing notification-service's CPU-only HPA with KEDA's"
    Invoke-Kubectl @("delete", "hpa", "notification-service", "-n", $Namespace)
  }
}

function Deploy {
  # local-keda builds on local, so the Secret always comes from local's secrets.env.
  if (-not (Test-Path "k8s/overlays/local/secrets.env")) {
    throw "k8s/overlays/local/secrets.env is missing - create it from secrets.env.example (every CHANGE_ME replaced)."
  }
  Assert-Context

  $composeUp = docker ps -q --filter "label=com.docker.compose.project=sentinelcloud"
  if ($composeUp) {
    Write-Warning "The Docker Compose stack is also running and competes for the same RAM. Stop it with: docker compose stop"
  }

  foreach ($name in $Images.Keys) {
    Step "building sentinelcloud/${name}:$Tag"
    Invoke-Native docker @("build", "-t", "sentinelcloud/${name}:$Tag", $Images[$name])
  }
  Import-ImagesIntoNode
  Install-MetricsServer
  if (-not $NoKeda) { Install-Keda }

  if (-not $NoKeda) { Remove-CpuOnlyHpa }
  Step "applying $Overlay"
  # server-side: the Grafana dashboards ConfigMap exceeds client-side apply's annotation limit
  Invoke-Kubectl @("apply", "--server-side", "-k", $Overlay)
  # Same tag rebuilt -> unchanged spec -> Kubernetes would keep the old pods.
  Invoke-Kubectl @("rollout", "restart", "deployment", "-n", $Namespace)

  Step "waiting for pods (Postgres and RabbitMQ initialise on first start; can take a few minutes)"
  # Wait per workload, not per pod: during a rolling update `kubectl wait pods --all`
  # also waits on old pods that are deleted meanwhile, and fails with NotFound.
  foreach ($kind in "statefulset", "deployment") {
    $names = kubectl.exe --context $Context get $kind -n $Namespace -o "jsonpath={.items[*].metadata.name}"
    foreach ($name in ($names -split " " | Where-Object { $_ })) {
      if ($name -eq "traffic-generator") { continue } # starts at 0 replicas by design
      Invoke-Kubectl @("rollout", "status", "$kind/$name", "-n", $Namespace, "--timeout=900s")
    }
  }
  Status
  Write-Host "`nNext: .\scripts\k8s-desktop.ps1 forward" -ForegroundColor Green
}

function Forward {
  Assert-Context
  Get-CimInstance Win32_Process -Filter "Name = 'kubectl.exe'" |
    Where-Object { $_.CommandLine -match "port-forward" -and $_.CommandLine -match "-n $Namespace" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  # GetEnumerator(): on an [ordered] table, $Forwards[30080] would be read as position 30080, not key 30080.
  foreach ($entry in $Forwards.GetEnumerator()) {
    $port = $entry.Key
    $target, $remote = $entry.Value -split ":"
    Start-Process kubectl.exe -WindowStyle Hidden -ArgumentList @(
      "--context", $Context, "port-forward", "-n", $Namespace, "--address", "127.0.0.1", $target, "${port}:$remote")
  }
  Start-Sleep -Seconds 3
  Write-Host "Frontend      http://localhost:30080"
  Write-Host "Grafana       http://localhost:30030"
  Write-Host "Prometheus    http://localhost:30090"
  Write-Host "Alertmanager  http://localhost:30093"
  Write-Host "(port-forwards run hidden in the background; '.\scripts\k8s-desktop.ps1 forward' restarts them)"
}

function Status {
  Invoke-Kubectl @("get", "pods", "-n", $Namespace, "-o", "wide")
  Invoke-Kubectl @("get", "hpa", "-n", $Namespace)
  # Phase 17: KEDA's view (absent without KEDA; that's not an error).
  $ErrorActionPreference = "Continue"
  kubectl.exe --context $Context get scaledobject -n $Namespace 2>$null
  $ErrorActionPreference = "Stop"
}

function Remove-Deployment {
  Assert-Context
  Get-CimInstance Win32_Process -Filter "Name = 'kubectl.exe'" |
    Where-Object { $_.CommandLine -match "port-forward" -and $_.CommandLine -match "-n $Namespace" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Invoke-Kubectl @("delete", "-k", $Overlay, "--ignore-not-found")
}

switch ($Action) {
  "deploy"  { Deploy }
  "forward" { Forward }
  "status"  { Status }
  "delete"  { Remove-Deployment }
}
