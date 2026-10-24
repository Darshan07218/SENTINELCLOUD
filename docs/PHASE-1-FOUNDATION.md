# Phase 1 — Project Foundation

> **Note (Phases 12–13).** Commands and behaviour in this phase document
> predate the security hardening and the engineering review. Notably: sign-up
> always creates a `CITIZEN` (no `role` field), the refresh token is an
> httpOnly cookie (login returns `accessToken`, not `session.accessToken`),
> every service except `/auth/docs` requires a Bearer token, and secrets come
> from `./scripts/generate-secrets.sh`. Current commands:
> [`SYSTEM-REFERENCE.md`](SYSTEM-REFERENCE.md), [`../SECURITY.md`](../SECURITY.md).


> **Phase 12 note:** setup and access changed since this phase was written.
> Generate secrets with `./scripts/generate-secrets.sh` instead of copying
> `.env.example`; sign-up now always creates a `CITIZEN`; and in Docker
> Compose the application services no longer publish their own ports
> (`localhost:8081`–`8088`) — use the gateway, e.g.
> `http://localhost:8080/api/v1/<service>/…` (API docs:
> `/api/v1/auth/docs`). See [`SECURITY.md`](../SECURITY.md).

## Goal

Establish the skeleton every later phase builds on, and prove — with
running containers, not just file structure — that these six things
work:

1. **Networking** — every container can reach every other container by name
2. **Service discovery** — the gateway and frontend find services without hardcoded IPs
3. **Database connectivity** — every service that owns data can reach its Postgres database
4. **Message broker connectivity** — every service that will publish/subscribe to events can reach RabbitMQ
5. **Frontend/backend connectivity** — the browser can reach the gateway, and the gateway can reach every service
6. **Health-check endpoints** — every service exposes `/health` (liveness) and, where it has dependencies, a readiness check

No domain business logic (hospital beds, ambulance dispatch, blood
inventory, power grid, disaster events, authentication) exists yet —
by design. That starts in Phase 2.

---

## Architecture established in this phase

```
Browser (localhost:5173)
   │  fetch("http://localhost:8080/health")
   │  fetch("http://localhost:8080/health/services")
   ▼
API Gateway (container: gateway, :8080)
   │  proxies /api/v1/<name>/* to each service (routes exist, but every
   │  downstream service currently only implements /health — real routes
   │  land as each service gets its business logic in later phases)
   │  aggregates all downstream /health calls for /health/services
   ├──► auth-service:8081        ──► auth_db (Postgres)
   ├──► hospital-service:8082    ──► hospital_db (Postgres) + RabbitMQ
   ├──► ambulance-service:8083   ──► ambulance_db (Postgres) + RabbitMQ
   ├──► blood-bank-service:8084  ──► blood_db (Postgres) + RabbitMQ  [Spring Boot]
   ├──► power-service:8085       ──► power_db (Postgres) + RabbitMQ  [Spring Boot]
   └──► disaster-service:8086    ──► disaster_db (Postgres) + RabbitMQ

notification-service:8087 (WebSocket, proxied via gateway /ws/live)
   ──► Redis
   ──► RabbitMQ

All services on Docker network: sentinelcloud-net
Service discovery: Docker Compose's embedded DNS resolves container
  names (e.g. "postgres", "rabbitmq", "hospital-service") to the right
  container automatically — no separate service registry is needed at
  this scale.
```

**Single shared Postgres instance, multiple databases.** Rather than
running six separate Postgres containers (heavy on a student laptop),
`infrastructure/postgres-init/init-multiple-databases.sh` creates one
database per service (`auth_db`, `hospital_db`, `ambulance_db`,
`blood_db`, `power_db`, `disaster_db`) inside a single container on
first startup. Each service still only ever connects to its own
database — true database-per-service isolation at the connection
level, just sharing a container for resource efficiency. The image
used is `postgis/postgis:16-3.4-alpine` (not plain `postgres`) so the
PostGIS extension is already available in the image for when the
Disaster and Power services need geospatial queries in later phases —
nothing needs to change in Phase 1 for that to work later.

**Health check pattern (consistent across every Node service):**
- `GET /health` → always `200` if the process is up (liveness)
- `GET /health/ready` → `200` only if every dependency (Postgres and/or
  RabbitMQ and/or Redis, depending on the service) is actually
  reachable right now; `503` otherwise (readiness)

**Health check pattern (Spring Boot services — blood-bank-service, power-service):**
Spring Boot Actuator provides this out of the box. `management.endpoints.web.base-path`
is set to `/` in `application.yml` so the endpoints land at the same
paths as the Node services:
- `GET /health` → aggregated status across Postgres (`db`), RabbitMQ (`rabbit`), disk space, etc.
- `GET /health/liveness` and `GET /health/readiness` → Kubernetes-style probe groups (ready for Phase 12)
- `GET /prometheus` → Prometheus scrape endpoint (already wired into `infrastructure/prometheus/prometheus.yml`, will start reporting real data once metrics matter more, in Phase 10)

---

## Files created

```
sentinelcloud/
├── README.md
├── .gitignore
├── .env.example
├── docker-compose.yml
├── docs/
│   ├── ARCHITECTURE.md
│   ├── ROADMAP.md
│   └── PHASE-1-FOUNDATION.md          (this file)
├── infrastructure/
│   ├── postgres-init/init-multiple-databases.sh
│   └── prometheus/prometheus.yml
├── frontend/
│   ├── package.json, vite.config.js, index.html, Dockerfile, .env.example, .gitignore
│   └── src/main.jsx, App.jsx, lib/api.js, pages/SystemHealthDashboard.jsx
└── services/
    ├── gateway/               package.json, Dockerfile, .env.example, src/{index.js,broker.js}
    ├── auth-service/          package.json, Dockerfile, .env.example, src/{index.js,db.js}
    ├── hospital-service/      package.json, Dockerfile, .env.example, src/{index.js,db.js,broker.js}
    ├── ambulance-service/     package.json, Dockerfile, .env.example, src/{index.js,db.js,broker.js}
    ├── disaster-service/      package.json, Dockerfile, .env.example, src/{index.js,db.js,broker.js}
    ├── notification-service/  package.json, Dockerfile, .env.example, src/{index.js,redis.js,broker.js}
    ├── blood-bank-service/    pom.xml, Dockerfile, .env.example, src/main/java/.../BloodBankServiceApplication.java, src/main/resources/application.yml
    └── power-service/         pom.xml, Dockerfile, .env.example, src/main/java/.../PowerServiceApplication.java, src/main/resources/application.yml
```

Nothing was modified (this is the first phase with code) and nothing
was removed.

---

## Exact commands to run

```bash
cd sentinelcloud
cp .env.example .env
docker compose up --build
```

That single command builds all 9 application images (7 Node, 2 Spring
Boot) and starts all 12 containers (3 infra + 2 monitoring + 7
application services + frontend... — see the full list below).

To run in the background instead of holding your terminal:

```bash
docker compose up --build -d
docker compose logs -f          # tail all logs
docker compose logs -f gateway  # tail just one service
```

---

## Expected output

On a successful `docker compose up --build`, you should see, near the
end of the log output, lines like:

```
sentinelcloud-postgres         | database system is ready to accept connections
sentinelcloud-rabbitmq         | Server startup complete
sentinelcloud-redis            | Ready to accept connections tcp
sentinelcloud-auth-service     | [auth-service] listening on port 8081
sentinelcloud-hospital-service | [hospital-service] connected to RabbitMQ
sentinelcloud-hospital-service | [hospital-service] listening on port 8082
sentinelcloud-ambulance-service| [ambulance-service] listening on port 8083
sentinelcloud-disaster-service | [disaster-service] listening on port 8086
sentinelcloud-notification-service | [notification-service] connected to Redis
sentinelcloud-notification-service | [notification-service] listening on port 8087
sentinelcloud-blood-bank-service   | Tomcat started on port 8084
sentinelcloud-power-service         | Tomcat started on port 8085
sentinelcloud-gateway           | [gateway] connected to RabbitMQ
sentinelcloud-gateway           | [gateway] listening on port 8080
sentinelcloud-frontend          | VITE ready in ... ms
```

`docker compose ps` should then show every service as `Up` (and infra
containers as `Up (healthy)`):

```bash
docker compose ps
```

```
NAME                                  STATUS
sentinelcloud-postgres                Up (healthy)
sentinelcloud-redis                   Up (healthy)
sentinelcloud-rabbitmq                Up (healthy)
sentinelcloud-prometheus              Up
sentinelcloud-grafana                 Up
sentinelcloud-auth-service            Up (healthy)
sentinelcloud-hospital-service        Up (healthy)
sentinelcloud-ambulance-service       Up (healthy)
sentinelcloud-blood-bank-service      Up (healthy)
sentinelcloud-power-service           Up (healthy)
sentinelcloud-disaster-service        Up (healthy)
sentinelcloud-notification-service    Up (healthy)
sentinelcloud-gateway                 Up (healthy)
sentinelcloud-frontend                Up
```

---

## How to verify every service is actually running

### 1. One-shot visual check — the dashboard

Open **http://localhost:5173**. The "System Health" panel polls the
gateway every 5 seconds and shows a green dot next to every service
that answered `/health`. This is the fastest way to see the whole
system at a glance, and it's proving real frontend → gateway →
downstream-service connectivity, not a static mock.

### 2. Gateway's own health

```bash
curl http://localhost:8080/health
```
```json
{"status":"ok","service":"gateway","timestamp":"..."}
```

```bash
curl http://localhost:8080/health/ready
```
`200` with `"status":"ready"` once RabbitMQ is connected; `503` with
`"status":"not_ready"` if not (useful for confirming the broker
connectivity requirement specifically).

### 3. Aggregated health of every downstream service, via the gateway

```bash
curl http://localhost:8080/health/services | python3 -m json.tool
```

Expect a `services` object with one entry per domain service, each
`"status": "up"`. This single endpoint is what the frontend dashboard
consumes.

### 4. Each service directly (bypassing the gateway)

```bash
curl http://localhost:8081/health   # auth-service
curl http://localhost:8082/health   # hospital-service
curl http://localhost:8083/health   # ambulance-service
curl http://localhost:8084/health   # blood-bank-service (Spring Actuator)
curl http://localhost:8085/health   # power-service (Spring Actuator)
curl http://localhost:8086/health   # disaster-service
curl http://localhost:8087/health   # notification-service
```

And their readiness variants (Node services use `/health/ready`,
Spring services use `/health/readiness`):

```bash
curl http://localhost:8081/health/ready
curl http://localhost:8082/health/ready
curl http://localhost:8083/health/ready
curl http://localhost:8084/health/readiness
curl http://localhost:8085/health/readiness
curl http://localhost:8086/health/ready
curl http://localhost:8087/health/ready
```

Each Node readiness response lists its actual dependency status, e.g.:
```json
{
  "status": "ready",
  "service": "hospital-service",
  "dependencies": { "postgres": "connected", "rabbitmq": "connected" },
  "timestamp": "..."
}
```

### 5. Message broker — RabbitMQ management UI

Open **http://localhost:15672** and log in with the credentials from
your `.env` (`RABBITMQ_DEFAULT_USER` / `RABBITMQ_DEFAULT_PASS`, both
default to `sentinel` / `sentinel_dev_password`). Under **Connections**
you should see one open connection per service that talks to RabbitMQ:
gateway, hospital-service, ambulance-service, blood-bank-service,
power-service, disaster-service, notification-service — 7 total.

### 6. Database connectivity — inspect Postgres directly

```bash
docker compose exec postgres psql -U sentinel -l
```
Should list `auth_db`, `hospital_db`, `ambulance_db`, `blood_db`,
`power_db`, `disaster_db` alongside the default `postgres`/`template`
databases — proof the multi-database init script ran.

### 7. WebSocket round-trip (frontend/backend realtime path)

```bash
# requires the `websocat` tool, or use any browser WS console instead:
# in the browser devtools console at http://localhost:5173, run:
#   const ws = new WebSocket("ws://localhost:8080/ws/live");
#   ws.onmessage = (e) => console.log(e.data);
```
You should immediately receive a `{"type":"welcome", ...}` message,
then a `{"type":"heartbeat", ...}` message every 15 seconds — proof the
gateway's WebSocket proxy and the notification-service's WS server are
both working end to end.

### 8. Prometheus targets (expected to show "down" — this is normal for Phase 1)

Open **http://localhost:9090/targets**. Every target will show as
`DOWN` because no service exposes `/metrics` yet — that's Phase 10.
The scrape config itself being present and attempting connections
confirms the monitoring container is wired correctly; nothing further
is expected here until later.

---

## Known limitations (expected at this stage — not bugs)

- **No authentication works yet.** `POST /register` and `POST /login`
  on the Auth Service both return `501 Not Implemented` with an
  explanatory message. This is intentional — Phase 2 implements real
  user storage and JWT issuance.
- **No domain data exists.** There are no hospitals, ambulances,
  blood banks, substations, or disasters yet — no tables, no seed
  data. Every service's database is genuinely empty (`SELECT 1` is
  the only query any service runs).
- **The gateway's `/api/v1/*` proxy routes exist but have nothing real
  to proxy to yet** beyond each service's own `/health`. Calling e.g.
  `GET /api/v1/hospitals/anything` will reach hospital-service and get
  a `404` from its catch-all handler — proving the proxy path works,
  even though there's no real route behind it yet.
- **Prometheus targets show "down."** Expected — see above.
- **The frontend has one page.** The System Health Dashboard is the
  only view; domain dashboards (hospital capacity, ambulance map,
  etc.) are built starting Phase 7–9.
- **No tests exist yet.** Unit/integration test suites are Phase 11.
- **The frontend Docker image runs the Vite dev server**, not a
  production build — intentional for fast iteration during
  development; a production Nginx-based build is added closer to
  submission.

---

## If something doesn't come up healthy

- **A service shows `Up` but not `(healthy)` for a while after
  startup** — this is usually normal. Node services wait up to ~30s
  retrying the RabbitMQ connection (Compose starts containers close
  together even with `depends_on`/healthchecks); Spring Boot services
  can take 15–25s to finish booting the JVM before Actuator responds.
  Give it a minute, then re-run `docker compose ps`.
- **`docker compose logs <service>` shows `ECONNREFUSED` for
  Postgres/RabbitMQ repeatedly and never recovers** — check that
  `.env` exists (copied from `.env.example`) and that
  `POSTGRES_USER`/`POSTGRES_PASSWORD`/`RABBITMQ_DEFAULT_USER`/
  `RABBITMQ_DEFAULT_PASS` match what the dependent service's
  environment block in `docker-compose.yml` references.
- **Port already in use on the host** — another process (or a
  previous `docker compose up` you forgot to stop) is holding one of
  8080–8087, 5173, 5432, 6379, 5672, 15672, 9090, or 3000. Either stop
  that process or change the relevant `*_PORT` value in `.env`.
- **Full reset** if things get into a strange state:
  ```bash
  docker compose down -v
  docker compose up --build
  ```
