# Phase 2 — Authentication and Authorization

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

A production-style auth system: registration, login, password hashing,
JWT access + refresh tokens, logout, and role-based access control
(RBAC) enforced centrally at the API Gateway. Frontend gets real login
and registration pages plus protected routing.

Per the phase rule, **only auth-service, gateway, and frontend were
touched** — hospital/ambulance/blood-bank/power/disaster/notification
services are untouched from Phase 1.

---

## Architecture

```
Browser
  │ 1. POST /api/v1/auth/register  { email, password, fullName, role }
  │ 2. POST /api/v1/auth/login     { email, password }
  ▼
Gateway (:8080)
  │  /api/v1/auth/register, /login, /refresh, /docs* are PUBLIC —
  │  proxied straight through, no auth check.
  │  Everything else under /api/v1/* requires a valid access token.
  ▼
auth-service (:8081)
  │  - bcryptjs hashes the password (never stored/returned in plaintext)
  │  - user row created in auth_db.users, linked to a role in auth_db.roles
  │  - on login: verifies password, issues:
  │      accessToken  (JWT, 15 min, HS256, claims: sub/email/role)
  │      refreshToken (JWT, 7 days, claims: sub/jti) — its SHA-256 hash
  │                    is stored in auth_db.refresh_tokens for revocation
  ▼
auth_db (Postgres) — roles, users, refresh_tokens, schema_migrations
```

### Subsequent authenticated request

```
Browser
  │ GET /api/v1/auth/me
  │ Authorization: Bearer <accessToken>
  ▼
Gateway
  │  requireAuth middleware verifies the JWT signature + expiry + issuer
  │  LOCALLY using JWT_ACCESS_SECRET (shared with auth-service via env) —
  │  no network round trip to auth-service just to check a token is valid.
  │  req.user = { id, email, role } is attached from the token's claims.
  │
  │  If the request is a write (POST/PUT/PATCH/DELETE) against a domain
  │  prefix (hospitals/ambulances/blood-banks/power/disasters), a second
  │  middleware checks req.user.role against that prefix's allow-list
  │  (services/gateway/src/routeAccessRules.js) and 403s if it doesn't match.
  ▼
Proxied to the target service (here, back to auth-service's own /me,
which independently re-verifies the token — defense in depth, in case
auth-service is ever reached directly on :8081 bypassing the gateway).
```

### Why HS256 (shared secret) instead of RS256 (public/private key pair)

The original architecture doc flagged RS256 as the production-grade
choice — it lets the gateway verify tokens with a public key it can
safely hold, without ever knowing the private signing key. For this
project's scope (one gateway, one auth-service, both under the same
docker-compose.yml, deployed together) that asymmetry doesn't buy much
extra safety, and a shared `JWT_ACCESS_SECRET` env var is far simpler
to set up and explain. This is documented here explicitly as a
deliberate scope trade-off, not an oversight — switching to RS256
later would only mean changing utils/jwt.js in both services, not the
overall architecture.

### Refresh token rotation

Every call to `POST /refresh` invalidates the refresh token it was
given and issues a brand new one (see
`refreshTokenRepository.rotate()`). This means a refresh token is
single-use: if one were ever stolen and used by an attacker, the
legitimate user's next refresh attempt would fail — a detectable signal
that something is wrong, rather than both parties silently sharing one
long-lived token indefinitely.

---

## Files created

```
services/auth-service/
├── migrations/
│   ├── 0001_create_roles_and_users.sql
│   └── 0002_create_refresh_tokens.sql
├── src/
│   ├── db/migrate.js              (lightweight SQL migration runner)
│   ├── db/seed.js                 (idempotent SYSTEM_ADMIN bootstrap)
│   ├── utils/password.js          (bcryptjs hash/verify)
│   ├── utils/jwt.js               (access/refresh token sign/verify)
│   ├── middleware/validate.js     (Zod-based body validation)
│   ├── middleware/auth.js         (auth-service's own requireAuth)
│   ├── schemas/authSchemas.js     (Zod: register/login/refresh/logout)
│   ├── repositories/userRepository.js
│   ├── repositories/refreshTokenRepository.js
│   ├── routes/authRoutes.js       (POST /register, /login, /refresh, /logout, GET /me)
│   └── openapi.yaml               (served via Swagger UI at /docs)
└── tests/
    ├── utils.test.js              (password + JWT unit tests)
    ├── validation.test.js         (Zod schema unit tests)
    └── authRoutes.integration.test.js  (full HTTP flow against an in-memory Postgres)

services/gateway/
├── src/
│   ├── middleware/auth.js         (requireAuth, requireRole)
│   └── routeAccessRules.js        (public paths + per-domain write-role table)
└── tests/
    └── auth.test.js               (middleware + route-rules unit tests)

frontend/src/
├── auth/
│   ├── AuthContext.jsx            (login/register/logout/silent-refresh, useAuth())
│   └── ProtectedRoute.jsx
└── pages/
    ├── LoginPage.jsx
    └── RegisterPage.jsx

docs/
└── PHASE-2-AUTH.md                (this file)
```

## Files modified

- `services/auth-service/src/index.js` — rewritten to wire migrations, seeding, the real auth router, Swagger docs, and a centralized error handler (was a Phase 1 stub with 501 placeholders)
- `services/auth-service/src/db.js` — added `waitForDb()` retry helper used before running migrations
- `services/auth-service/package.json` — added bcryptjs, jsonwebtoken, zod, express-rate-limit, swagger-ui-express, yaml, pg-mem + supertest (dev)
- `services/auth-service/Dockerfile` — now also copies `migrations/` into the image
- `services/auth-service/.env.example` — added JWT/bcrypt/default-admin variables
- `services/gateway/src/index.js` — added the two auth-enforcement middlewares in front of the proxy routes
- `services/gateway/package.json` — added jsonwebtoken
- `frontend/src/App.jsx` — rewritten with `BrowserRouter`, `AuthProvider`, header with user info/logout, and routes for `/login`, `/register`, and the protected `/`
- `frontend/src/lib/api.js` — added `registerUser`, `loginUser`, `refreshTokens`, `logoutUser`, `fetchCurrentUser`, and a normalized `ApiError`
- `frontend/src/pages/SystemHealthDashboard.jsx` — added a "Your Session" panel that calls the protected `/api/v1/auth/me` endpoint via `authFetch`
- `frontend/package.json` — added react-router-dom
- `.env.example` (root) — added the same JWT/bcrypt/default-admin variables, referenced by both auth-service and gateway
- `docker-compose.yml` — auth-service now receives the new env vars; gateway now receives `JWT_ACCESS_SECRET`
- `docs/ROADMAP.md` — Phase 2 marked done, Phase 3 now "next"

**Not modified:** hospital-service, ambulance-service, blood-bank-service, power-service, disaster-service, notification-service, and all Phase 1 infrastructure config (Postgres init script, Prometheus config, other Dockerfiles).

---

## Roles

| Role | Self-registerable? | Notes |
|---|---|---|
| `CITIZEN` | Yes (default) | Read-only baseline — can reach any authenticated GET |
| `EMERGENCY_OPERATOR` | Yes | + write access to `ambulances`, `disasters` |
| `HOSPITAL_ADMIN` | Yes | + write access to `hospitals`, `blood-banks` |
| `INFRASTRUCTURE_ADMIN` | Yes | + write access to `power` |
| `SYSTEM_ADMIN` | **No** | Full write access everywhere; only created via the one-time bootstrap seed (`DEFAULT_ADMIN_EMAIL`/`DEFAULT_ADMIN_PASSWORD` in `.env`) |

---

## Exact commands to run

```bash
cd sentinelcloud
# .env already exists from Phase 1 — add the new variables from
# .env.example if you're reusing an old .env file (JWT_*, BCRYPT_SALT_ROUNDS,
# DEFAULT_ADMIN_*). A fresh `cp .env.example .env` picks them up automatically.

docker compose up --build
```

auth-service now, on startup: waits for Postgres → runs both
migrations (creating `roles`, `users`, `refresh_tokens`,
`schema_migrations`) → seeds the default `SYSTEM_ADMIN` (from
`DEFAULT_ADMIN_EMAIL`/`DEFAULT_ADMIN_PASSWORD`) if none exists yet →
starts listening.

### Running the test suites

```bash
# Auth Service — unit + integration tests (in-memory DB, no Docker needed)
cd services/auth-service
npm install
npm test

# Gateway — middleware unit tests
cd ../gateway
npm install
npm test
```

Expected: all tests pass (`# pass N`, `# fail 0` in Node's test runner
output). The integration suite exercises the *actual* route handlers
and repository SQL against an in-memory Postgres (via `pg-mem`), not
mocks of them — see the comment at the top of
`authRoutes.integration.test.js` for the one documented simplification
(CITEXT → TEXT in the test schema, since pg-mem doesn't implement the
citext extension; the Zod layer already normalizes email casing before
it reaches the repository, so this doesn't weaken what's being tested).

> **Sandbox note:** these test suites were written and syntax-checked
> (`node --check` on every file) in an environment without npm
> registry access, so `npm install && npm test` itself was not run
> end-to-end here. Run it in your own environment per the commands
> above — if anything doesn't pass, paste me the failure and I'll fix
> it before we move to Phase 3.

---

## API documentation

Interactive Swagger UI, publicly reachable (no login required to view
it):

- Direct: **http://localhost:8081/docs**
- Via gateway: **http://localhost:8080/api/v1/auth/docs**

Raw OpenAPI JSON at `/openapi.json` on either of the above.

---

## Demonstration

All commands below assume the stack is running (`docker compose up`)
and use the seeded `SYSTEM_ADMIN` plus two freshly-registered accounts.
Swap in your own values if you changed `.env`.

### 0. Register a citizen and an emergency operator

```bash
curl -s -X POST http://localhost:8080/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"citizen@example.com","password":"CitizenPass1","fullName":"Casey Citizen","role":"CITIZEN"}'

curl -s -X POST http://localhost:8080/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"operator@example.com","password":"OperatorPass1","fullName":"Riley Operator","role":"EMERGENCY_OPERATOR"}'
```
Both return `201` with the created user (no password in the response).

### 1. Citizen login

```bash
curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"citizen@example.com","password":"CitizenPass1"}' | tee citizen_session.json
```
`200` with `accessToken`, `refreshToken`, and `user.role: "CITIZEN"`.

### 2. Emergency operator login

```bash
curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"operator@example.com","password":"OperatorPass1"}' | tee operator_session.json
```
`200` with `user.role: "EMERGENCY_OPERATOR"`.

### 3. Unauthorized request (no token)

```bash
curl -i http://localhost:8080/api/v1/auth/me
```
Expect **`401`**:
```json
{"error":{"code":"UNAUTHENTICATED","message":"Missing or malformed Authorization header."}}
```

### 4. Authorized request (valid token)

```bash
CITIZEN_TOKEN=$(python3 -c "import json;print(json.load(open('citizen_session.json'))['accessToken'])")
curl -i http://localhost:8080/api/v1/auth/me -H "Authorization: Bearer $CITIZEN_TOKEN"
```
Expect **`200`** with the citizen's own profile.

### 5. Role-based authorization — citizen blocked from a write, operator allowed

The disaster-service has no business routes yet (Phase 3), but the
gateway's role check runs *before* proxying, so this is fully
demonstrable now:

```bash
# Citizen attempts to create a disaster — should be blocked with 403
curl -i -X POST http://localhost:8080/api/v1/disasters \
  -H "Authorization: Bearer $CITIZEN_TOKEN" \
  -H "Content-Type: application/json" -d '{}'
```
Expect **`403`**:
```json
{"error":{"code":"FORBIDDEN","message":"Role 'CITIZEN' is not permitted to perform this action."}}
```

```bash
OPERATOR_TOKEN=$(python3 -c "import json;print(json.load(open('operator_session.json'))['accessToken'])")
curl -i -X POST http://localhost:8080/api/v1/disasters \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" -d '{}'
```
Expect **`404`** (not 403!) — the gateway's role check passes, so it
proxies through to disaster-service, which returns 404 because it has
no route for `POST /` yet (Phase 3 territory). Getting a 404 instead of
a 403 here is itself proof the authorization layer worked correctly.

### 6. Refresh + logout

```bash
REFRESH_TOKEN=$(python3 -c "import json;print(json.load(open('citizen_session.json'))['refreshToken'])")
curl -s -X POST http://localhost:8080/api/v1/auth/refresh \
  -H "Content-Type: application/json" -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}"
# → 200 with a brand-new accessToken + refreshToken

curl -i -X POST http://localhost:8080/api/v1/auth/refresh \
  -H "Content-Type: application/json" -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}"
# → 401, the old refresh token was rotated away and can't be reused

curl -i -X POST http://localhost:8080/api/v1/auth/logout \
  -H "Authorization: Bearer $CITIZEN_TOKEN" \
  -H "Content-Type: application/json" -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}"
# → 204
```

### 7. Same demo, in the browser

1. Open **http://localhost:5173** → redirected to `/login` (proves the `/` route is genuinely protected client-side).
2. Click **Register**, create a `CITIZEN` account → redirected to `/login`.
3. Log in → lands on the dashboard; header shows your name, email, and role; the "Your Session" panel shows the result of the authenticated `GET /api/v1/auth/me` call.
4. Click **Log out** → back to `/login`; the underlying refresh token was revoked server-side (verify with step 6's reuse-attempt pattern against the token that was in `localStorage`, now cleared).

---

## Security checklist (what to point to when asked "how is this secure")

- ✅ Passwords are never stored or logged in plaintext — bcryptjs, 12 salt rounds (`utils/password.js`)
- ✅ Passwords are never returned in any API response (`userRepository` never selects `password_hash` into a response payload)
- ✅ All secrets (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, DB credentials, admin bootstrap credentials) come from environment variables, never hardcoded — `utils/jwt.js` refuses to even start if the secrets are missing
- ✅ Every request body is validated with Zod before touching business logic (`middleware/validate.js`) — malformed input gets a `400` with field-level detail, never reaches SQL
- ✅ All SQL is parameterized (`$1, $2, ...`) — no string-concatenated queries anywhere
- ✅ Refresh tokens are stored hashed (SHA-256), never in plaintext, and rotate on every use
- ✅ Login/register are rate-limited (20 requests / 15 min / IP) against credential-stuffing and enumeration
- ✅ Login failure messages are identical for "no such account" vs "wrong password" — no account enumeration
- ✅ Consistent HTTP status codes throughout: `400` validation, `401` unauthenticated, `403` forbidden (wrong role), `404` unknown route, `409` conflict (duplicate email), `429` rate limited, `500` unexpected
- ✅ Defense in depth: both the gateway and auth-service independently verify the access token on auth-service's own protected routes

---

## Known limitations (expected at this stage)

- **Refresh tokens live in `localStorage`** on the frontend, not an
  httpOnly cookie. Documented trade-off in `AuthContext.jsx` — the
  gateway is a stateless reverse proxy and doesn't manage cookie-based
  sessions in this design. A production deployment would change this;
  flagged here rather than silently accepted.
- **No password reset / email verification flow yet.** Out of scope
  for this phase; would be natural additions alongside real email
  infrastructure in a later phase if desired.
- **No account lockout after repeated failed logins** beyond the
  general rate limiter — a dedicated per-account lockout counter is a
  reasonable future hardening step, not implemented here to keep scope
  bounded to what was asked.
- **Domain services (hospital/ambulance/blood-bank/power/disaster)
  still have no real business routes.** The gateway's role-based
  authorization is fully wired and testable today (see demo step 5
  above, where a 403 vs 404 distinguishes "blocked by role" from
  "no route yet") — but there is nothing behind those routes to
  actually protect until Phase 3 onward add them.
- **JWT uses a shared HS256 secret**, not RS256 key pairs — see the
  "Why HS256" note above for the reasoning.
- **`npm install && npm test` was not run in this sandbox** (no
  package registry access) — every file was syntax-checked with
  `node --check`, but you should run the real test suites yourself per
  the commands above and report back if anything fails.
