# SentinelCloud — Security Architecture

Phase 12 (security hardening). This document explains how SentinelCloud
protects itself, what the security review found, what was changed, how to
run the system securely, and what is deliberately left as an accepted risk.

SentinelCloud is a coursework project that runs on a laptop (Docker
Compose) or a local Kubernetes cluster (Kind / Minikube). The controls
below are the ones a real deployment of this architecture needs, kept as
simple as the job allows.

---

## 1. What is protected, and from whom

| Asset | Why it matters |
|---|---|
| Emergency data (disasters, dispatches, hospital capacity, blood stock, grid state) | Wrong data sends ambulances to the wrong place or hides a shortage |
| Privileged actions (create a disaster, dispatch, reserve blood, run a resilience drill, grant roles) | Each one changes the real-world response |
| User accounts and sessions | A stolen admin session controls everything above |
| Secrets (JWT keys, database, broker, Redis, Grafana passwords) | Any one of them bypasses the controls above |

| Attacker | Starting point |
|---|---|
| Anonymous visitor | Can reach the published ports (the frontend, and the gateway in Compose) |
| Signed-in low-privilege user | A valid `CITIZEN` token |
| Compromised container | Code running inside one pod or container |
| Token thief | A copied access or refresh token, e.g. via XSS |

## 2. Architecture and trust boundaries

```
                    ┌────────────── only door from outside ──────────────┐
 Browser ──HTTP──▶  frontend (nginx :30080)  ── CSP, no-framing, nosniff headers
                        │  sets X-Forwarded-For = real client IP
                        ▼
                    gateway (:8080)  ── decode + normalise path once
                        │              ── block /internal, /health, /metrics, /actuator…
                        │              ── rate limit per IP, per user (writes), per WS connect
                        │              ── JWT (HS256 pinned) + role check per prefix (fail closed)
                        │              ── CORS allow-list, request id, audit log
       ┌──────┬────────┼────────┬──────────┬─────────┬──────────────┐
       ▼      ▼        ▼        ▼          ▼         ▼              ▼
     auth  hospital ambulance blood-bank power  disaster  notification (WS)
       │  each re-verifies the JWT and enforces its own roles/ownership
       ▼
  postgres: one DB user per service ─ redis: password ─ rabbitmq: shared user, consumers validate events
  NetworkPolicies: default deny; only the arrows above are allowed
```

Three rules hold everywhere:

- **Defence in depth.** The gateway checks every request, and every service
  checks again: JWT verification, role checks and ownership checks. A
  request that somehow skips the gateway still meets the same checks.
- **Nothing trusts the network.** Services authenticate the *user* (JWT),
  data stores require *credentials*, and NetworkPolicies limit *who can
  connect at all*.
- **Secrets only come from the environment.** No secret has a default in
  code or images; a missing or example secret stops the service at startup.

---

## 3. The twelve controls

| # | Requirement | How SentinelCloud does it | Where |
|---|---|---|---|
| 1 | **JWT authentication** | Short-lived (15 min) HS256 access tokens. The algorithm is pinned on every verifier, so `none`, HS512 and alg-confusion tokens are rejected. `iss`, `type=access`, `exp` and `sub` are required. Tokens are verified at the gateway **and** again in every service (Node: `jsonwebtoken` or the zero-dependency verifier; Spring: jjwt). Refresh tokens: 7 days, stored only as SHA-256 hashes, **rotated atomically** on every use, **reuse detection** (a replayed rotated token ends every session of that account), sent only as an **httpOnly, SameSite=Strict cookie** scoped to `/api/v1/auth`, so page JavaScript and XSS can't read them. | `services/auth-service/src/utils/jwt.js`, `routes/authRoutes.js`, `utils/cookies.js`; `services/gateway/src/middleware/auth.js`; `shared/node-security/jwt.js`; Spring `security/JwtService.java` |
| 2 | **Role-based authorization** | Five roles (below). Gateway: writes need a role listed for that path prefix, and **unknown prefixes get no roles (fail closed)**. Services: per-endpoint `requireRole` / `@PreAuthorize`, plus **ownership** (a hospital admin edits only their hospital; a blood-bank reservation can be released only by its creator, the holding bank's admin, or a SYSTEM_ADMIN). **Sign-up always creates `CITIZEN`**; only a SYSTEM_ADMIN grants roles (Users page / `PATCH /auth/users/{id}`). There is no self-demotion, the last admin can't be removed (enforced in one locked transaction), and a role change ends that user's sessions. | `gateway/src/routeAccessRules.js`, `auth-service/src/routes/authRoutes.js`, `hospital-service/src/middleware/ownership.js`, `blood-bank-service/.../ReservationService.canRelease` |
| 3 | **Password hashing** | bcrypt, cost **12 minimum** (lower env values are ignored). Policy: 10+ characters with upper, lower and a digit, and **at most 72 bytes** (bcrypt ignores anything beyond, so it is refused rather than silently truncated). Login takes the **same time** for unknown emails (dummy bcrypt comparison) and gives the same error, so accounts can't be enumerated. **Per-account lockout**: 10 failures in 15 minutes, counted for unknown emails too. The bootstrap admin password must pass the policy and can't be an example value. | `auth-service/src/utils/password.js`, `utils/loginGuard.js`, `schemas/authSchemas.js`, `db/seed.js` |
| 4 | **Input validation** | Zod schemas on every Node write and list endpoint; Bean Validation on every Spring DTO, now with **upper bounds** (units, telemetry values, radius, page size). `:id` must be a UUID (400 instead of a database error). Disaster and reaction **events from RabbitMQ are validated** before use (UUID ids, coordinate ranges, radius ≤ 500 km, known source and type); bad ones are dropped, never requeued forever. Body limits: 10 KB (auth), 100 KB (services), 1 MB (nginx). WebSocket messages are capped at 4 KB. Business rules: expired blood can't be re-dated, and telemetry can't be timestamped in the future. | `*/schemas/*.js`, `*/dto/*.java`, `*/consumers/*.js`, `event/DisasterEventListener.java`, `InventoryService.java`, `TelemetryService.java` |
| 5 | **API rate limiting** | Gateway: **600 req/min per client IP** (all API calls), **60 writes/min per user**, **30 live-feed connects/min per IP**, answered with 429 + `Retry-After`. auth-service: 20 login/register per 15 min per IP, 120 refresh/logout per 15 min per IP, plus the per-account lockout. The client IP can't be spoofed: nginx *sets* `X-Forwarded-For`, the gateway trusts exactly the configured number of proxy hops (1 in Kubernetes, 0 in Compose) and *overwrites* the header it forwards. | `gateway/src/security/rateLimiter.js`, `gateway/src/index.js`, `auth-service/src/routes/authRoutes.js`, `frontend/nginx/default.conf.template` |
| 6 | **CORS** | Only the gateway answers CORS, from an **allow-list** (`CORS_ALLOWED_ORIGINS`; the Vite dev server). Credentials are allowed only for those origins. Services no longer send `Access-Control-Allow-Origin: *`. The **WebSocket checks Origin** too (browsers don't apply CORS to WebSockets): same host or allow-listed, else 403. | `gateway/src/index.js`, `gateway/src/security/wsAuth.js` |
| 7 | **Secure HTTP headers** | UI (nginx): strict **Content-Security-Policy** (`default-src 'self'`, no inline scripts or styles, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP, `server_tokens off`. API: helmet on every Express service, the same baseline on resilience-service, Spring Security defaults, `Cache-Control: no-store` on `/api/v1`. | `frontend/nginx/security-headers.conf`, `*/src/index.js` |
| 8 | **Environment-based secrets** | Every secret is read from the environment. **No fallbacks in code** (`DB_PASSWORD \|\| "…"` and `${DB_PASSWORD:…}` removed). Startup check: missing, shorter than 32 (JWT, chaos token) or 16 (passwords) characters, or a placeholder value → the service refuses to start. `scripts/generate-secrets.sh` creates `.env` and `secrets.env` with random values (`chmod 600`, gitignored). Example files contain only `CHANGE_ME`. | `shared/node-security/secrets.js`, `scripts/generate-secrets.sh`, `.env.example`, `k8s/overlays/local/secrets.env.example` |
| 9 | **Database credential protection** | **One database user per service**, owning only its own database. `CONNECT` is revoked from everyone else, there is no superuser/CREATEDB/CREATEROLE, and the superuser is used only by the init script. A compromised hospital-service can't read `auth_db` (password hashes) or run programs via `COPY … PROGRAM`. All SQL is parameterised (`$1` / JPQL named parameters); dynamic SQL uses whitelisted column names only. | `infrastructure/postgres-init/init-multiple-databases.sh` (and its `k8s/base/config/` copy) |
| 10 | **Kubernetes Secrets** | One generated Secret (`sentinelcloud-secrets-<hash>`, from the gitignored `secrets.env`); every credential reaches pods via `secretKeyRef`, never via ConfigMaps. Required keys aren't `optional` (Grafana no longer falls back to admin/admin). Pods run non-root with a read-only root filesystem, all capabilities dropped and the RuntimeDefault seccomp profile; data stores keep only the 5 capabilities their entrypoint needs. Only the three components that call the Kubernetes API (resilience-service, Prometheus, kube-state-metrics) mount a ServiceAccount token. RBAC is least privilege: resilience-service may patch only the 4 drill HPAs by name; Prometheus no longer has `nodes/proxy`. | `k8s/overlays/local/kustomization.yaml`, `k8s/base/**` |
| 11 | **Service-to-service authentication** | The user's JWT travels with every API call and **each service verifies it itself**: no service trusts "the gateway said so" headers. Data stores require credentials (per-service Postgres users, a Redis password, a RabbitMQ user). Fault injection (`/internal/*`) needs a 32+ character token, is never proxied by the gateway, and is reachable only from resilience-service (NetworkPolicy). **NetworkPolicies**: default deny, then only the arrows in §2. | `k8s/base/security/network-policies.yaml`, `*/middleware/auth.js`, `notification-service/src/index.js` |
| 12 | **Audit logging** | One JSON line per security event (`{"log":"audit", ts, service, action, outcome, actor{id,role}, ip, requestId, resource, details}`) on stdout. The gateway records **every write** (all services, Spring included), every 401/403, every 429, and every probe of an internal endpoint. auth-service records register, login success/failure (with reason), lockouts, logout, refresh-token reuse and role changes. resilience-service records drill start/abort/denied. Secrets, tokens, passwords, cookies and hashes are stripped from audit details, and control characters are neutralised (no forged log lines). A request id links gateway and service lines. | `shared/node-security/audit.js`, `gateway/src/index.js`, `auth-service/src/routes/authRoutes.js`, `resilience-service/src/index.js` |

### Roles

| Role | Can read | Can change |
|---|---|---|
| `CITIZEN` (every new account) | everything | nothing |
| `EMERGENCY_OPERATOR` | everything | disasters, ambulances, emergencies |
| `HOSPITAL_ADMIN` | everything | **their own** hospitals and blood banks; reservations they made |
| `INFRASTRUCTURE_ADMIN` | everything | **their own** substations and transformers |
| `SYSTEM_ADMIN` | everything | everything, users and roles, resilience drills |

---

## 4. Review findings and what was done

The whole codebase (8 Node services, 2 Spring services, frontend, Docker,
Compose, Kubernetes) was reviewed for the issues the brief lists. Most of the
basics were already sound: JWTs were checked at the gateway and in the
services; bcrypt was used; Zod and Bean Validation were in place; all SQL
was parameterised; helmet was on; and every application container ran as
non-root. These are the weaknesses found:

| Severity | Finding | Fix |
|---|---|---|
| **High** | **Self-service privilege escalation**: `/register` accepted `role: EMERGENCY_OPERATOR / HOSPITAL_ADMIN / INFRASTRUCTURE_ADMIN` | Sign-up is `CITIZEN` only; roles are granted by a SYSTEM_ADMIN (new Users page + API), audit-logged |
| **High** | **Live feed had no authentication**: anyone could open `/ws/live` and receive every event; no Origin check; 100 MiB messages | Token (WebSocket sub-protocol) checked at the gateway **and** notification-service; Origin check; 4 KB cap; connection cap; per-IP connect limit |
| **High** | **Every service used the Postgres superuser** | Per-service database users (verified against real Postgres 16) |
| **High** | **Compose published every database, broker, monitoring UI and service on all interfaces**; Redis had no password | Everything binds to 127.0.0.1; services aren't published at all; Redis `requirepass` with CONFIG/DEBUG disabled |
| **High** | **No NetworkPolicies**: any pod could reach any pod | Default-deny + allow-list (verified on k3s: 30/30 cases) |
| Medium | **Role check bypass by letter case**: `POST /api/v1/HOSPITALS` skipped the gateway's write-role check | Path decoded and normalised once; exact lower-case prefixes; fail closed |
| Medium | Encoded paths could reach `/internal` and Spring `/health`, `/prometheus` through the gateway | The path guard blocks `internal` in any case/encoding, plus every infrastructure endpoint |
| Medium | **IP spoofing defeated the login rate limit** (`X-Forwarded-For` was appended) | nginx sets the header; the gateway trusts a fixed hop count and overwrites it |
| Medium | Hard-coded fallback credentials (`sentinel_dev_password`) in Node code and Spring `application.yml`; known example secrets (`ChangeMe123!`, `change_me_dev_only…`) accepted | No fallbacks; startup checks reject missing/short/example secrets; generator script |
| Medium | Refresh token in `localStorage` (XSS-stealable); refresh rotation race; no reuse detection; logout needed a valid access token | httpOnly cookie; atomic rotation; reuse ⇒ all sessions revoked; logout by cookie |
| Medium | Login timing revealed which emails exist; no per-account lockout | Dummy bcrypt comparison; lockout per email |
| Medium | **Any hospital admin could release any blood reservation** (IDOR); expired blood could be re-dated back into stock | Ownership check; expiry rules |
| Medium | Spring `/health` showed DB version and disk paths to anyone; detailed downstream errors in `/health/services` and 502s | `show-details: never`; generic public messages; details only in server logs |
| Medium | Prometheus held `nodes/proxy` (can be escalated to command execution via the kubelet) | Scrapes cAdvisor from the kubelet's `/metrics/cadvisor` with `nodes/metrics` only (verified: 200 for metrics, 403 for the node proxy and the kubelet's `/run`) |
| Medium | Data stores ran with full default capabilities and no seccomp; Grafana could fall back to admin/admin; NodePorts listened on every interface | securityContext hardening; Grafana secret required; Kind ports on 127.0.0.1 |
| Medium | Node 20 base images (end of life April 2026); `http-proxy-middleware` range allowed vulnerable versions | Node 22 LTS; `^3.0.5`; `npm ci` where lockfiles exist |
| Low | Malformed `:id` → 500 + stack trace; unhandled rejection could crash notification-service; Spring client errors became 500s and real errors weren't logged | UUID guard; try/catch; proper 400/404/405/409/415 mapping; errors logged |
| Low | Client WebSocket messages and raw RabbitMQ fields written to logs (log injection); query strings in access logs | Not logged / sanitised; access logs without query strings |
| Low | Forged RabbitMQ events could trigger unbounded queries or be requeued forever | Payload validation; `default-requeue-rejected: false` |
| Low | A hospital admin could reassign `managedByUserId` | SYSTEM_ADMIN only |
| Low | Inline `<style>` would have forced `unsafe-inline` into the CSP | Moved to a stylesheet |

**Checked and found clean:** SQL injection (every query parameterised), XSS
sinks in the frontend (no `dangerouslySetInnerHTML`, `innerHTML` or
data-driven `href`), secrets in the frontend bundle (only the API base URL),
and secrets in Docker build args or layers (none).

---

## 5. Running SentinelCloud securely

```bash
# 1. Generate secrets (random; gitignored; chmod 600). Windows: Git Bash or WSL.
./scripts/generate-secrets.sh            # both .env and k8s/overlays/local/secrets.env
#    The bootstrap admin password is DEFAULT_ADMIN_PASSWORD in those files.

# 2a. Docker Compose
docker compose up --build                # http://localhost:5173 (gateway :8080)

# 2b. Kubernetes (Kind)
./scripts/k8s-build-images.sh kind
kubectl apply -k k8s/overlays/local      # http://localhost:30080
```

- **NetworkPolicies need a network plugin that enforces them.** Verified on
  k3s. Kind 0.24+ (kindnet), Calico and Cilium enforce them. Minikube's
  default plugin does not, so start it with `minikube start --cni=calico`.
  Without enforcement the policies are accepted but ignored.
- **HTTPS.** The local setups are plain HTTP, so the refresh cookie's
  `Secure` flag is turned off in the local overlay and Compose. Anything
  served over HTTPS keeps the base value (`COOKIE_SECURE=true`) and should
  enable HSTS in `frontend/nginx/security-headers.conf`.
- **Reaching the UI from another device.** Set `BIND_ADDRESS=0.0.0.0` in
  `.env` (Compose) or remove `listenAddress` for port 30080 in
  `k8s/cluster/kind-cluster.yaml`. Never do this for Prometheus or
  Alertmanager: they have no login.

### Upgrading an existing installation (Phases 9–11 → 12)

Run `./scripts/generate-secrets.sh`. It keeps strong values, replaces the
old example values, adds the new keys and drops obsolete ones.

The **data volumes must then be recreated**:

- Postgres creates the per-service users, and RabbitMQ its user and
  password, only when their volume is first initialised.
- All the data is demo data that the services seed again automatically.

```bash
docker compose down -v && docker compose up --build                        # Compose
kubectl delete -k k8s/overlays/local && kubectl apply -k k8s/overlays/local  # Kubernetes (deletes the PVCs too)
```

User accounts other than the bootstrap admin are lost; re-register them and
grant roles on the Users page.

### Finding the audit trail

```bash
kubectl logs -n sentinelcloud deploy/gateway | grep '"log":"audit"'
kubectl logs -n sentinelcloud deploy/auth-service | grep '"action":"auth.login"'
docker compose logs gateway auth-service resilience-service | grep '"log":"audit"'
```

---

## 6. Demonstrating it (≈5 minutes)

On Kubernetes, with `API=http://localhost:30080/api/v1`:

```bash
API=http://localhost:30080/api/v1
code() { curl -s -o /dev/null -w "%{http_code}\n" "$@"; }

code $API/hospitals                                    # 401: no token
curl -s -X POST $API/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"eve@example.com","password":"Evil12345678","fullName":"Eve","role":"SYSTEM_ADMIN"}'
#   → created as "role":"CITIZEN" (the requested role is ignored)
TOKEN=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"eve@example.com","password":"Evil12345678"}' | sed 's/.*"accessToken":"\([^"]*\)".*/\1/')
code -X POST $API/hospitals   -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'  # 403
code -X POST $API/HOSPITALS   -H "Authorization: Bearer $TOKEN"                                             # 404 (case trick)
code $API/power/%69nternal/whoami -H "Authorization: Bearer $TOKEN"                                          # 404 (internal)
code $API/blood-banks/health -H "Authorization: Bearer $TOKEN"                                               # 404 (actuator)
for i in $(seq 1 11); do code -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"eve@example.com","password":"wrongWrong1"}'; done                                            # …401, then 429
curl -sI http://localhost:30080/ | grep -iE 'content-security|x-frame|referrer'                              # security headers
kubectl logs -n sentinelcloud deploy/gateway --tail=50 | grep '"log":"audit"'                                 # the trail of all of the above
kubectl exec -n sentinelcloud deploy/frontend -- nc -z -w 2 postgres 5432; echo "exit=$?"                     # non-zero: blocked by NetworkPolicy
```

---

## 7. Verification performed

| What | Result |
|---|---|
| Unit tests for the new security modules: path guard, rate limiter, WebSocket handshake, access rules, secret checks, audit sanitising, zero-dependency HS256 verifier, cookies, lockout, event validation, resilience API security, copies of shared modules | **104 tests, all passing** (`node --test`) |
| Per-service database users on **real PostgreSQL 16**: init script (run twice, idempotent); real migrations as the service user (incl. `citext`, `pgcrypto`); cross-database access, superuser rights, `COPY … PROGRAM`, `CREATE ROLE`, wrong password all refused; new auth SQL (atomic rotation, reuse flags, user updates); **last-admin race with two concurrent sessions** (second one sees 0 admins and rolls back) | All as intended |
| **Real Redis**: no password → `NOAUTH`; CONFIG/DEBUG disabled; the commands notification-service uses still work | As intended |
| **NetworkPolicies on k3s**: stand-in pods with the real labels and ports, the real policy file, 30 allow/deny cases | **30/30**; kubelet probes unaffected |
| Prometheus RBAC on k3s: cAdvisor via kubelet with only `nodes/metrics` | 200 with metrics; node proxy 403; kubelet `/run` 403; `promtool check config` OK; 19 alert tests pass |
| Kubernetes manifests: `kubectl kustomize` + server-side dry run | **86 objects accepted** |
| Docker Compose: `docker compose config` with a generated `.env`; with a missing secret | Valid; refuses to start with a clear message |
| Secret generator: fresh run, idempotent re-run, upgrade from a Phase 11 file; every generated value passes the services' own startup checks | As intended |
| UI under the **exact CSP** in headless Chromium (Resilience page with a running drill) | Renders with **0 CSP violations**; same-origin WebSocket allowed; foreign WebSocket blocked |
| Syntax: all 151 JavaScript files (`node --check`), all 110 Java files (javac parser), frontend bundle | No errors |
| **Independent code review** of everything that couldn't be executed here (Express pipeline, auth routes, ws options, Spring handlers and config) | Found 3 bugs that would have broken things (a zod chain crash at startup, nginx `$host` dropping the port so the live feed got 403, a YAML key in the wrong place) plus 4 smaller gaps — **all fixed** |

**Not run in this environment, to be honest about it:** the Express, Spring
and frontend code against their real libraries (npm and Maven registries are
blocked here), so the existing supertest/pg-mem and JUnit suites were
updated but not executed, and nginx itself wasn't started. Run `npm test` in
each Node service, `mvn test` in the Spring services, and the §6 demo after
building the images.

---

## 8. Accepted risks and limitations

| Risk | Why accepted / mitigation | Upgrade path |
|---|---|---|
| **One shared HS256 key**: any service holding `JWT_ACCESS_SECRET` could mint tokens | Simple, and every service needs to verify. The key is only in the Secret, and NetworkPolicies isolate services | RS256/EdDSA: only auth-service holds the private key |
| An access token stays valid up to **15 min** after a role change or deactivation | Refresh tokens are revoked immediately; the short TTL bounds the rest | Token deny-list in Redis |
| Rate limits and lockout are **in memory per replica** (N replicas ⇒ up to N× the limit) | No extra moving parts; still stops scripted abuse | Redis-backed store (Redis is already deployed) |
| **RabbitMQ: one shared user** | Consumers validate every event; the broker is reachable only from event services | Per-service users with topic permissions |
| **No TLS inside the cluster**, no mTLS | Local single-node clusters; NetworkPolicies limit who can connect | Service mesh (Linkerd/Istio) |
| Secrets are base64 in etcd (not encrypted at rest) on local clusters | Local only | etcd encryption / an external secret manager |
| resilience-service may **delete any pod** in the namespace | Pod names are random, so RBAC can't name them. Only the drill code uses it, it requires SYSTEM_ADMIN, and it is audited | ValidatingAdmissionPolicy limiting deletes to drill targets |
| Fault injection is enabled in the base manifests | Needed for the Resilience Demo; token + NetworkPolicy + gateway block | Move `CHAOS_ENABLED` into a demo-only overlay |
| Audit log goes to stdout (not tamper-proof, not retained) | Standard for containers; easy to ship | Ship to Loki/ELK with retention; consider WORM storage |
| `/auth/docs` and service API docs are visible (auth docs publicly, others to signed-in users) | Coursework documentation | Disable springdoc / swagger in production |
| Spring Boot 3.3.x patch line; no automated dependency scanning | Patch version bumped | Spring Boot 3.5.x; `npm audit` / OWASP dependency-check / Trivy in CI |

## 9. Reporting a problem

This is a student project. If you find a security issue, contact the author
privately rather than opening a public issue.
