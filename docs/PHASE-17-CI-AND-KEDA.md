# Phase 17 — CI pipeline and queue-based autoscaling (KEDA)

> **Status: done.** Design in §1–4, as built in §5, verification in §6.
> Owner in the team plan: Member D.

## 1. CI pipeline (GitHub Actions)

`.github/workflows/ci.yml` runs on every push and pull request. Each job is
something the project already runs by hand, now automatic:

| Job | Runs | Typical time |
|---|---|---|
| `node` | `npm ci` in every Node package, `scripts/run-node-tests.sh`, then the real-PostgreSQL suite against a throwaway Postgres built from the project's own init script (`scripts/run-db-tests.sh`) | ~3 min |
| `java` (blood-bank, power) | `mvn -B test` on Temurin 21, Maven cache | ~3 min each, in parallel |
| `alerts` | `promtool test rules` on the alert unit tests | <1 min |
| `manifests` | generate throwaway secrets, `docker compose config`, `kubectl kustomize` of both overlays, `actionlint` on the workflow itself | <1 min |
| `images` (12 images) | `docker build` of every service and the frontend, so a broken Dockerfile fails the build | ~5 min, in parallel |
| `system` | `scripts/verify-system.sh compose --yes --skip-unit --teardown`: the whole stack up from clean, the 13 end-to-end checks | ~15 min; **nightly and on demand only** |

The fast jobs gate every change; the slow end-to-end run doesn't hold up
every push.

**This repository isn't on GitHub yet** (it isn't even a git repository).
The workflow is ready for the moment it is pushed; until then each job is
verified by running the same commands locally in the same Linux containers
(§6).

## 2. Queue-based autoscaling with KEDA

The HorizontalPodAutoscalers scale on CPU. For an event-driven system the
better signal is often **how much work is waiting**: a backlog of messages
says "add consumers" before CPU does.

- **KEDA 2.21.0** (pinned) is installed into its own `keda` namespace.
- **notification-service** scales on `q.notifications.all-events`: 1 replica
  per 20 waiting messages, between 1 and 3. The HPA controller asks KEDA's
  metrics server for the queue length about every 15 s. Its CPU
  trigger stays too, so behaviour under normal load is unchanged. KEDA
  creates and owns the HPA, so the CPU-only HPA is removed for this one
  service.
- **Why notification-service:** it consumes *every* event (`#`), so it's
  the first to fall behind after an outage. It's built for several replicas
  (one live queue per pod), and it isn't a Resilience Demo drill target: the
  drills patch their targets' HPAs by name, which KEDA would overwrite.
- **Credentials:** KEDA reads the RabbitMQ user and password from
  notification-service's own environment (`usernameFromEnv` /
  `passwordFromEnv`), so no extra secret is needed. A NetworkPolicy lets the
  KEDA operator, and only it, reach RabbitMQ's AMQP port.
- **Optional:** KEDA lives in a Kustomize component
  (`k8s/components/keda`) used by a new overlay `k8s/overlays/local-keda`.
  `k8s/overlays/local` keeps working without KEDA (Kind/Minikube docs
  unchanged). `scripts/k8s-desktop.ps1 deploy` installs KEDA and uses
  `local-keda` (add `-NoKeda` to skip).

### Demo: KEDA sees the backlog

1. Pause the consumer: `kubectl annotate scaledobject notification-service
   -n sentinelcloud autoscaling.keda.sh/paused-replicas="0"`. KEDA scales it
   to 0 (`PAUSED True`).
2. Run a scenario (Phase 16) or raise a disaster. Events pile up in
   `q.notifications.all-events` with 0 consumers (Grafana: "Queue depth").
3. Show the number the autoscaler is given, straight from KEDA's metrics
   server:
   ```
   kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1/namespaces/sentinelcloud/s0-rabbitmq-q-notifications-all-events?labelSelector=scaledobject.keda.sh%2Fname%3Dnotification-service"
   ```
   The `value` matches the queue depth RabbitMQ reports.
4. Resume: `kubectl annotate scaledobject notification-service -n
   sentinelcloud autoscaling.keda.sh/paused-replicas-`. The deployment
   returns at 1 replica and drains the queue; `kubectl get hpa
   notification-service` shows `0/20 (avg)` again.

A scenario's backlog (36 messages for `monsoon-flood`) is too small to show
scale-out: one replica clears it faster than the HPA's ~15 s sync.

### Demo: scale-out to 3 (`scripts/keda-scale-demo.ps1`)

One command runs the whole thing: pause, put a synthetic backlog (default
30 000 messages) straight into `q.notifications.all-events`, print RabbitMQ's
depth next to KEDA's metric, resume, and record queue / HPA desired / ready
replicas every few seconds until the backlog is gone.

```
.\scripts\keda-scale-demo.ps1
```

The load stays out of the dashboard: the messages go to the history queue
only (default exchange, so no other service and no live WebSocket queue gets
them), and they all carry one event ID whose "seen" marker (Phase 14
dedup) is set in Redis first, so notification-service acks each one as a
duplicate after a single Redis call. The marker is deleted at the end. The
HPA returns to 1 replica about 4 minutes later (120 s window, then 1 pod per
60 s).

## 3. Files

| Area | Change |
|---|---|
| `.github/workflows/ci.yml` | new |
| `scripts/run-db-tests.sh` | new: throwaway Postgres + real-PostgreSQL suite (CI and Linux/WSL) |
| `k8s/components/keda/` | ScaledObject, NetworkPolicy, removal of the CPU-only HPA |
| `k8s/overlays/local-keda/` | `local` + the KEDA component |
| `scripts/k8s-desktop.ps1` | install KEDA (images loaded like the others), use `local-keda` |
| `scripts/keda-scale-demo.ps1` | new: one-command scale-out demo (synthetic backlog, 1 → 3 replicas) |
| docs | this file, README, Phase 9 doc pointer |

## 4. Tests

- `actionlint` on the workflow.
- The `node` job's commands, run in `node:22` on Linux (the bash runner has
  only been exercised on Windows so far).
- `kubectl kustomize` of both overlays; the KEDA one must contain the
  ScaledObject and no CPU-only HPA for notification-service.
- On the cluster: KEDA installed, the ScaledObject READY, then the backlog
  demo (pause → backlog → KEDA's metric matches the queue → resume → drained).

## 5. As built

Changes from the design, all found while deploying:

- **KEDA's deployment names** are `keda-operator`, `keda-metrics-apiserver`
  and `keda-admission`; the script waits on those.
- **The old HPA blocks the ScaledObject.** `kubectl apply` doesn't delete
  objects that disappeared from the manifests, so the CPU-only
  `notification-service` HPA stayed, and KEDA's admission webhook refused
  the ScaledObject ("already managed by the hpa"). `k8s-desktop.ps1` now
  deletes that HPA first, unless KEDA already owns it
  (`app.kubernetes.io/managed-by=keda-operator`).
- **No `pollingInterval`.** KEDA warned that it does nothing for scaling with
  `minReplicaCount: 1`; it was removed and the comments corrected.
- **Secrets** are always read from `k8s/overlays/local/secrets.env`; the
  `local-keda` overlay builds on `local` and has none of its own.
- **Going back to CPU only** (`deploy -NoKeda`) after a KEDA deploy: delete
  the ScaledObject first (`kubectl delete scaledobject notification-service
  -n sentinelcloud`); KEDA then removes its HPA and the `local` overlay
  recreates the CPU-only one.
- **Linux test runner**: `scripts/run-node-tests.sh` didn't include
  `shared/node-broker/` (445 tests on Linux vs 485 on Windows); added. It now
  uses the TAP reporter and counts cancelled tests as failures.

## 6. Verification (2026-10-24)

The repository isn't on GitHub, so each CI job was run locally with the same
commands in the same Linux images:

| Check | Result |
|---|---|
| `actionlint` 1.7.7 on `ci.yml` | clean |
| `shellcheck` on the new/changed scripts | clean |
| `node` job in `node:22`: `run-node-tests.sh` | 485 pass, 0 fail |
| `run-db-tests.sh` (throwaway Postgres, Linux) | 44 / 44 pass, container removed |
| `generate-secrets.sh` on Linux | no placeholders left; simulator password meets the policy |
| `kubectl kustomize` `local` / `local-keda` | 10 HPAs / ScaledObject + 9 HPAs + `rabbitmq-from-keda` |

On Docker Desktop Kubernetes:

| Check | Result |
|---|---|
| `k8s-desktop.ps1 deploy` (KEDA 2.21.0 + `local-keda`) | exit 0, all deployments rolled out |
| ScaledObject | `READY True`, triggers `rabbitmq,cpu` |
| KEDA's HPA | `0/20 (avg), cpu: 5%/70%`, so the AMQP read works through the NetworkPolicy |
| Paused at 0, `monsoon-flood` run | queue reached 36 messages, 0 consumers |
| Resumed | 1 replica drained 36 messages in ~13 s; HPA stayed at 1 (too small a backlog, see §2) |
| `keda-scale-demo.ps1` (30 000 messages) | RabbitMQ 30 000, KEDA metric `30k`; resumed: desired 3 and **3 ready replicas at 25 s**, queue empty at 37 s; 0 load messages in the event history, marker removed |
| Paused at 0, one disaster raised | RabbitMQ: 6 messages; KEDA external metric: `"value":"6"` |
| Resumed | back to 1 replica, `0/20 (avg)` |

| `images` job's command, all 12 images (`docker build -t sentinelcloud/<image>:ci`) | 12 / 12 exit 0 (local layer cache, so not a cold build) |

Not run: the GitHub-hosted workflow itself (needs a push to GitHub) and the
nightly `system` job. That job brings up the whole Compose stack as project
`sentinelcloud` and tears it down with its volumes; on the development
machine it would collide with another Compose project of that name and
compete with the Kubernetes stack for Docker's ~7.4 GB of memory, so it is
left to the GitHub runner (Actions tab → CI → Run workflow).
