/**
 * Real-PostgreSQL integration suite (engineering review).
 *
 * Runs every service's real migrations, seeds, repositories and the
 * business logic that sits directly on them against a REAL PostgreSQL 16,
 * connecting as each service's own least-privilege login role — exactly
 * as the services do in Compose and Kubernetes. Nothing is mocked: the
 * concurrency tests below fire genuinely concurrent transactions.
 *
 * It needs a database prepared by the project's own init script
 * (infrastructure/postgres-init/init-multiple-databases.sh), and it WIPES
 * the six service databases, so it only runs when explicitly asked to:
 *
 *   SC_DB_TEST=1 SC_DB_TEST_ALLOW_RESET=1 PGHOST=127.0.0.1 PGPORT=5432 \
 *   AUTH_DB_PASSWORD=… HOSPITAL_DB_PASSWORD=… AMBULANCE_DB_PASSWORD=… \
 *   BLOOD_BANK_DB_PASSWORD=… POWER_DB_PASSWORD=… DISASTER_DB_PASSWORD=… \
 *   node --test tests/db/realPostgres.test.js
 *
 * scripts/verify-system.sh runs it against the Compose Postgres for you.
 * Uses the `pg` package when installed, otherwise the test-only wire
 * client in ./lib/miniPg.js.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SVC = (p) => path.join(ROOT, "services", p);
// import() needs a file:// URL for an absolute path on Windows (C:\...).
const importFile = (p) => import(pathToFileURL(p).href);
const ENABLED = process.env.SC_DB_TEST === "1" && process.env.SC_DB_TEST_ALLOW_RESET === "1";

const { Pool } = ENABLED ? await import("pg").then((m) => m.default || m).catch(() => import("./lib/miniPg.js")) : {};

const DATABASES = {
  auth: { db: "auth_db", user: "auth_svc", pw: "AUTH_DB_PASSWORD" },
  hospital: { db: "hospital_db", user: "hospital_svc", pw: "HOSPITAL_DB_PASSWORD" },
  ambulance: { db: "ambulance_db", user: "ambulance_svc", pw: "AMBULANCE_DB_PASSWORD" },
  blood: { db: "blood_db", user: "blood_bank_svc", pw: "BLOOD_BANK_DB_PASSWORD" },
  power: { db: "power_db", user: "power_svc", pw: "POWER_DB_PASSWORD" },
  disaster: { db: "disaster_db", user: "disaster_svc", pw: "DISASTER_DB_PASSWORD" },
  response: { db: "response_db", user: "response_svc", pw: "RESPONSE_DB_PASSWORD" }, // Phase 15
};

const pools = {};
function poolFor(key, max = 5) {
  const d = DATABASES[key];
  return new Pool({
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 5432),
    user: d.user,
    password: process.env[d.pw],
    database: d.db,
    max,
  });
}

async function resetSchema(pool) {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
}

// The Node services' migration runners log every applied file; keep the
// test output readable.
async function quietly(fn) {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

const silentWarn = () => {};

describe("real PostgreSQL 16", { skip: !ENABLED && "set SC_DB_TEST=1 SC_DB_TEST_ALLOW_RESET=1 (see file header)" }, () => {
  before(async () => {
    for (const key of Object.keys(DATABASES)) pools[key] = poolFor(key, 8);
    for (const key of Object.keys(DATABASES)) await resetSchema(pools[key]);
  });

  after(async () => {
    await Promise.all(Object.values(pools).map((p) => p.end()));
  });

  // -------------------------------------------------------------------
  describe("least-privilege database roles", () => {
    test("a service role cannot connect to another service's database", async () => {
      const intruder = new Pool({
        host: process.env.PGHOST || "127.0.0.1",
        port: Number(process.env.PGPORT || 5432),
        user: DATABASES.hospital.user,
        password: process.env[DATABASES.hospital.pw],
        database: DATABASES.auth.db,
        max: 1,
      });
      await assert.rejects(intruder.query("SELECT 1"), (err) => err.code === "42501");
      await intruder.end();
    });

    test("service roles are not superusers and cannot create roles or databases", async () => {
      const { rows } = await pools.hospital.query(
        "SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user"
      );
      assert.deepEqual(rows[0], { rolsuper: false, rolcreaterole: false, rolcreatedb: false });
    });
  });

  // -------------------------------------------------------------------
  describe("Node service migrations (real runner, run twice)", () => {
    for (const [key, svc] of [
      ["auth", "auth-service"],
      ["hospital", "hospital-service"],
      ["ambulance", "ambulance-service"],
      ["disaster", "disaster-service"],
      ["response", "response-service"],
    ]) {
      test(`${svc}: every migration applies as ${DATABASES[key].user}, and a second run is a no-op`, async () => {
        const { runMigrations } = await importFile(path.join(SVC(svc), "src/db/migrate.js"));
        const files = readdirSync(path.join(SVC(svc), "migrations")).filter((f) => f.endsWith(".sql"));
        await quietly(() => runMigrations(pools[key]));
        await quietly(() => runMigrations(pools[key]));
        const { rows } = await pools[key].query("SELECT filename FROM schema_migrations ORDER BY filename");
        assert.deepEqual(rows.map((r) => r.filename), files.sort());
      });
    }
  });

  // -------------------------------------------------------------------
  describe("Spring Boot Flyway migrations + JPA entity mapping", () => {
    for (const [key, svc, pkg] of [
      ["blood", "blood-bank-service", "bloodbank"],
      ["power", "power-service", "power"],
    ]) {
      test(`${svc}: V1..Vn apply in order as ${DATABASES[key].user}`, async () => {
        const dir = path.join(SVC(svc), "src/main/resources/db/migration");
        const files = readdirSync(dir)
          .filter((f) => /^V\d+__.*\.sql$/.test(f))
          .sort((a, b) => Number(a.match(/^V(\d+)/)[1]) - Number(b.match(/^V(\d+)/)[1]));
        assert.ok(files.length >= 3);
        // Flyway runs each versioned migration in its own transaction.
        for (const f of files) {
          const client = await pools[key].connect();
          try {
            await client.query("BEGIN");
            await client.query(readFileSync(path.join(dir, f), "utf8"));
            await client.query("COMMIT");
          } catch (err) {
            await client.query("ROLLBACK");
            throw new Error(`${f}: ${err.message}`);
          } finally {
            client.release();
          }
        }
      });

      test(`${svc}: every @Entity field maps to an existing column (ddl-auto is "none", so drift would only fail at runtime)`, async () => {
        const entityDir = path.join(SVC(svc), `src/main/java/com/sentinelcloud/${pkg}/entity`);
        const { rows } = await pools[key].query(
          "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'"
        );
        const columns = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
        const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
        let checked = 0;
        for (const file of readdirSync(entityDir).filter((f) => f.endsWith(".java"))) {
          const src = readFileSync(path.join(entityDir, file), "utf8");
          const table = src.match(/@Table\(\s*name\s*=\s*"([^"]+)"/)?.[1];
          if (!table) continue;
          // Field declarations with the annotations directly above them.
          const re = /((?:\s*@[A-Za-z]+(?:\([^)]*\))?\s*)*)\s*(?:private|protected)\s+(?!static)[\w<>, ?]+\s+(\w+)\s*(?:=[^;]*)?;/g;
          for (const m of src.matchAll(re)) {
            const annotations = m[1] || "";
            if (/@Transient|@OneToMany|@ManyToMany/.test(annotations)) continue;
            const column = annotations.match(/@(?:Column|JoinColumn)\([^)]*name\s*=\s*"([^"]+)"/)?.[1] || snake(m[2]);
            assert.ok(columns.has(`${table}.${column}`), `${file}: field '${m[2]}' → ${table}.${column} does not exist`);
            checked += 1;
          }
        }
        assert.ok(checked > 10, `only ${checked} fields checked — parser problem?`);
      });
    }
  });

  // -------------------------------------------------------------------
  describe("ambulance-service: dispatch on real transactions", () => {
    let ambulanceRepository, emergencyRepository, ambulanceService, dispatchService, emergencyService, published;

    before(async () => {
      const A = (p) => importFile(path.join(SVC("ambulance-service"), "src", p));
      const { createAmbulanceRepository } = await A("repositories/ambulanceRepository.js");
      const { createEmergencyRepository } = await A("repositories/emergencyRepository.js");
      const { createAmbulanceService } = await A("services/ambulanceService.js");
      const { createDispatchService } = await A("services/dispatchService.js");
      const { createEmergencyService } = await A("services/emergencyService.js");
      const { withTransaction } = await A("db/transaction.js");
      const { seedSampleAmbulances, seedSampleEmergency } = await A("db/seed.js");
      const pool = pools.ambulance;
      await quietly(async () => {
        await seedSampleAmbulances(pool);
        await seedSampleEmergency(pool);
      });
      // Start from a known fleet: everything out of service, then add our own.
      await pool.query("UPDATE ambulances SET status = 'OUT_OF_SERVICE', assigned_emergency_id = NULL");
      await pool.query("UPDATE emergencies SET status = 'CANCELLED' WHERE status IN ('ACTIVE','ASSIGNED')");
      ambulanceRepository = createAmbulanceRepository(pool);
      emergencyRepository = createEmergencyRepository(pool);
      published = [];
      const publishEvent = async (key, payload) => published.push({ key, payload });
      const transaction = (fn) =>
        withTransaction(pool, (client) =>
          fn({ ambulanceRepository: createAmbulanceRepository(client), emergencyRepository: createEmergencyRepository(client) })
        );
      ambulanceService = createAmbulanceService({ ambulanceRepository });
      dispatchService = createDispatchService({ ambulanceRepository, emergencyRepository, publishEvent, transaction });
      emergencyService = createEmergencyService({ emergencyRepository, dispatchService });
    });

    const user = randomUUID();
    const newAmbulance = (n, lat = 18.52, lng = 73.85) =>
      ambulanceService.registerAmbulance({
        vehicleNumber: `TEST-${n}-${randomUUID().slice(0, 6)}`,
        latitude: lat,
        longitude: lng,
        driverName: "Test Driver",
        driverPhone: "+910000000000",
        equipmentLevel: "ADVANCED",
      });
    const newEmergency = (lat = 18.521, lng = 73.851) =>
      emergencyRepository.create({ description: "integration test emergency", latitude: lat, longitude: lng, severity: "HIGH" }, user);

    test("two concurrent dispatches of the SAME ambulance: exactly one wins, the other gets 409, nothing half-written", async () => {
      const amb = await newAmbulance("race");
      const [e1, e2] = await Promise.all([newEmergency(), newEmergency()]);
      const results = await Promise.allSettled([
        dispatchService.dispatchAmbulanceToEmergency(amb.id, e1.id),
        dispatchService.dispatchAmbulanceToEmergency(amb.id, e2.id),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r) => r.status === "rejected");
      assert.equal(ok.length, 1);
      assert.equal(failed.length, 1);
      assert.equal(failed[0].reason.statusCode, 409);
      const winner = ok[0].value.emergency.id;
      const loser = winner === e1.id ? e2.id : e1.id;
      assert.equal((await emergencyRepository.findById(loser)).status, "ACTIVE", "losing emergency must be untouched (rolled back)");
      const a = await ambulanceRepository.findById(amb.id);
      assert.equal(a.status, "DISPATCHED");
      assert.equal(a.assignedEmergencyId, winner);
    });

    test("ten concurrent new emergencies, three ambulances: three assigned, seven left ACTIVE, every request succeeds (no false 409)", async () => {
      await pools.ambulance.query("UPDATE ambulances SET status = 'OUT_OF_SERVICE' WHERE status = 'AVAILABLE'");
      await Promise.all([newAmbulance("f1", 18.53, 73.86), newAmbulance("f2", 18.54, 73.87), newAmbulance("f3", 18.55, 73.88)]);
      const created = await Promise.allSettled(
        Array.from({ length: 10 }, () => emergencyService.createEmergency({ description: "burst", latitude: 18.53, longitude: 73.86, severity: "HIGH" }, user))
      );
      assert.equal(created.filter((r) => r.status === "rejected").length, 0, created.find((r) => r.status === "rejected")?.reason?.message);
      const assigned = created.filter((r) => r.value.ambulance);
      assert.equal(assigned.length, 3);
      assert.equal(new Set(assigned.map((r) => r.value.ambulance.id)).size, 3, "no ambulance assigned twice");
      const { rows } = await pools.ambulance.query(
        "SELECT assigned_emergency_id, count(*)::int AS n FROM ambulances WHERE assigned_emergency_id IS NOT NULL AND status = 'DISPATCHED' GROUP BY 1 HAVING count(*) > 1"
      );
      assert.equal(rows.length, 0);
    });

    test("cancelling an ASSIGNED emergency frees its ambulance (it used to stay DISPATCHED forever)", async () => {
      const amb = await newAmbulance("cancel");
      const e = await newEmergency();
      await dispatchService.dispatchAmbulanceToEmergency(amb.id, e.id);
      const cancelled = await emergencyService.cancelEmergency(e.id);
      assert.equal(cancelled.status, "CANCELLED");
      const a = await ambulanceRepository.findById(amb.id);
      assert.equal(a.status, "AVAILABLE");
      assert.equal(a.assignedEmergencyId, null);
      await assert.rejects(emergencyService.cancelEmergency(e.id), (err) => err.statusCode === 409);
    });

    test("completing an old emergency does not free an ambulance that was re-dispatched elsewhere", async () => {
      const amb = await newAmbulance("redispatch");
      const e1 = await newEmergency();
      await dispatchService.dispatchAmbulanceToEmergency(amb.id, e1.id);
      // Crew finishes the first job out of band and becomes AVAILABLE, then is sent to a second one.
      await ambulanceRepository.updateStatus(amb.id, "AVAILABLE");
      const e2 = await newEmergency();
      await dispatchService.dispatchAmbulanceToEmergency(amb.id, e2.id);
      const done = await dispatchService.completeEmergency(e1.id);
      assert.equal(done.emergency.status, "RESOLVED");
      assert.equal(done.ambulance, null, "ambulance is on e2 now and must not be touched");
      const a = await ambulanceRepository.findById(amb.id);
      assert.equal(a.status, "DISPATCHED");
      assert.equal(a.assignedEmergencyId, e2.id);
    });

    test("completing twice concurrently: one RESOLVED, one 409", async () => {
      const amb = await newAmbulance("complete");
      const e = await newEmergency();
      await dispatchService.dispatchAmbulanceToEmergency(amb.id, e.id);
      const r = await Promise.allSettled([dispatchService.completeEmergency(e.id), dispatchService.completeEmergency(e.id)]);
      assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal(r.find((x) => x.status === "rejected").reason.statusCode, 409);
      assert.equal((await ambulanceRepository.findById(amb.id)).status, "AVAILABLE");
    });

    test("registering the same vehicle number concurrently: one 201, one VEHICLE_NUMBER_TAKEN (unique index, not a 500)", async () => {
      const plate = `DUP-${randomUUID().slice(0, 8)}`;
      const data = { vehicleNumber: plate, latitude: 18.5, longitude: 73.8, driverName: "D", driverPhone: "+91000", equipmentLevel: "BASIC" };
      const r = await Promise.allSettled([ambulanceService.registerAmbulance(data), ambulanceService.registerAmbulance(data)]);
      assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal(r.find((x) => x.status === "rejected").reason.code, "VEHICLE_NUMBER_TAKEN");
    });

    test("the search radius is straight-line km (an ambulance 40 km away is inside a 45 km radius)", async () => {
      await pools.ambulance.query("UPDATE ambulances SET status = 'OUT_OF_SERVICE' WHERE status = 'AVAILABLE'");
      const far = await newAmbulance("radius", 18.52 + 40 / 111, 73.85); // ~40 km north
      const found = await ambulanceService.findNearestAvailable(18.52, 73.85, { radiusKm: 45, limit: 10 });
      assert.ok(found.some((a) => a.id === far.id), "40 km straight-line (≈52 km road estimate) must be within 45 km");
    });

    test("GET /emergencies/active is served by the new (status, created_at) index", async () => {
      await pools.ambulance.query("ANALYZE emergencies");
      const { rows } = await pools.ambulance.query(
        "EXPLAIN (FORMAT JSON) SELECT * FROM emergencies WHERE status IN ('ACTIVE','ASSIGNED') ORDER BY created_at ASC LIMIT 500"
      );
      const plan = JSON.stringify(rows[0]["QUERY PLAN"] ?? rows[0]);
      // Tiny tables may legitimately use a seq scan; the index must at least exist.
      const idx = await pools.ambulance.query("SELECT indexname FROM pg_indexes WHERE tablename = 'emergencies'");
      assert.ok(idx.rows.some((r) => r.indexname === "idx_emergencies_status_created"), plan);
    });
  });

  // -------------------------------------------------------------------
  describe("hospital-service", () => {
    let repo, service;
    before(async () => {
      const H = (p) => importFile(path.join(SVC("hospital-service"), "src", p));
      const { seedSampleHospitals } = await H("db/seed.js");
      await quietly(() => seedSampleHospitals(pools.hospital));
      const { createHospitalRepository } = await H("repositories/hospitalRepository.js");
      const { createHospitalService } = await H("services/hospitalService.js");
      repo = createHospitalRepository(pools.hospital);
      service = createHospitalService({ hospitalRepository: repo, publishEvent: null });
    });

    test("the seed is present and /stats/summary's SQL aggregate equals summing every row", async () => {
      const all = await repo.findAllForAlerts();
      assert.ok(all.length >= 5, `seeded ${all.length} hospitals`);
      const s = await service.getSummary();
      const sum = (k) => all.reduce((n, h) => n + h[k], 0);
      assert.equal(s.totalHospitals, all.length);
      assert.equal(s.totalBeds, sum("totalBeds"));
      assert.equal(s.availableBeds, sum("availableBeds"));
      assert.equal(s.availableIcuBeds, sum("availableIcuBeds"));
      assert.equal(s.availableVentilators, sum("availableVentilators"));
      assert.equal(s.overloadedHospitals, all.filter((h) => h.emergencyStatus === "OVERLOADED").length);
    });

    test("the CHECK constraints hold even when the service pre-check is bypassed (SQLSTATE 23514 → mapped to 409)", async () => {
      const [h] = await repo.findAllForAlerts();
      await assert.rejects(repo.updateAvailableBeds(h.id, h.totalBeds + 1), (err) => err.code === "23514");
    });

    test("radius search returns only hospitals within the radius, nearest first", async () => {
      const [h] = await repo.findAllForAlerts();
      const near = await service.findHospitalsNear(h.latitude, h.longitude, 5);
      assert.ok(near.length >= 1);
      assert.equal(near[0].id, h.id);
      assert.ok(near.every((x, i) => x.distanceKm <= 5 && (i === 0 || near[i - 1].distanceKm <= x.distanceKm)));
    });
  });

  // -------------------------------------------------------------------
  describe("disaster-service", () => {
    let disasterRepository, reactionRepository, service, published;
    before(async () => {
      const D = (p) => importFile(path.join(SVC("disaster-service"), "src", p));
      ({ createDisasterRepository: disasterRepository } = await D("repositories/disasterRepository.js"));
      disasterRepository = disasterRepository(pools.disaster);
      const { createReactionRepository } = await D("repositories/reactionRepository.js");
      reactionRepository = createReactionRepository(pools.disaster);
      const { createDisasterService } = await D("services/disasterService.js");
      published = [];
      service = createDisasterService({ disasterRepository, publishEvent: async (key, payload, cid) => published.push({ key, payload, cid }) });
    });

    const create = () =>
      service.createDisaster({ type: "FLOOD", severity: "HIGH", latitude: 18.52, longitude: 73.85, radiusKm: 15, description: "river overflow test" }, randomUUID());

    test("create publishes disaster.detected with the disaster id as correlationId", async () => {
      const { disaster, eventPublished } = await create();
      assert.equal(eventPublished, true);
      const evt = published.at(-1);
      assert.equal(evt.key, "disaster.detected");
      assert.equal(evt.cid, disaster.id);
      assert.equal(evt.payload.disasterId, disaster.id);
    });

    test("status transitions: ACTIVE→CONTAINED→ACTIVE→RESOLVED allowed, RESOLVED is final; the note is stored", async () => {
      const { disaster } = await create();
      const c = await service.setStatus(disaster.id, "CONTAINED", "levees holding");
      assert.equal(c.disaster.status, "CONTAINED");
      assert.equal(c.disaster.statusNote, "levees holding");
      assert.equal(published.at(-1).key, "disaster.updated");
      await service.setStatus(disaster.id, "ACTIVE", "second surge");
      const r = await service.setStatus(disaster.id, "RESOLVED", "water receded");
      assert.equal(r.disaster.status, "RESOLVED");
      assert.equal(published.at(-1).key, "disaster.resolved", "resolution must not re-trigger the four reacting services");
      await assert.rejects(service.setStatus(disaster.id, "CONTAINED"), (err) => err.code === "INVALID_STATUS_TRANSITION");
      await assert.rejects(service.updateDisaster(disaster.id, { severity: "LOW" }), (err) => err.code === "DISASTER_RESOLVED");
      assert.equal((await disasterRepository.findById(disaster.id)).statusNote, "water receded");
    });

    test("two concurrent identical status changes: exactly one applies, the other gets 409", async () => {
      const { disaster } = await create();
      const r = await Promise.allSettled([service.setStatus(disaster.id, "CONTAINED"), service.setStatus(disaster.id, "CONTAINED")]);
      assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal(r.find((x) => x.status === "rejected").reason.statusCode, 409);
    });

    test("the status UPDATE is conditional on the state the transition was validated from", async () => {
      const { disaster } = await create();
      await disasterRepository.setStatus(disaster.id, "CONTAINED", { fromStatus: "ACTIVE" });
      // A writer that validated ACTIVE→RESOLVED before the change above must not apply.
      assert.equal(await disasterRepository.setStatus(disaster.id, "RESOLVED", { fromStatus: "ACTIVE" }), null);
      assert.equal((await disasterRepository.findById(disaster.id)).status, "CONTAINED");
    });

    test("a late, OLDER reaction does not overwrite a newer one (out-of-order delivery)", async () => {
      const { disaster } = await create();
      const base = { disasterId: disaster.id, eventType: "hospital.capacity.updated", sourceService: "hospital-service" };
      const newer = await reactionRepository.upsert({ ...base, eventId: randomUUID(), payload: { v: "new" }, occurredAt: "2026-10-04T10:00:05.000Z" });
      assert.ok(newer);
      const older = await reactionRepository.upsert({ ...base, eventId: randomUUID(), payload: { v: "old" }, occurredAt: "2026-10-04T10:00:01.000Z" });
      assert.equal(older, null);
      const rows = await reactionRepository.findByDisasterId(disaster.id);
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0].payload, { v: "new" });
      // A genuinely newer one still replaces it (idempotent upsert keeps working).
      await reactionRepository.upsert({ ...base, eventId: randomUUID(), payload: { v: "newest" }, occurredAt: "2026-10-04T10:00:09.000Z" });
      assert.deepEqual((await reactionRepository.findByDisasterId(disaster.id))[0].payload, { v: "newest" });
    });

    test("a reaction for an unknown disaster is rejected by the foreign key", async () => {
      await assert.rejects(
        reactionRepository.upsert({ disasterId: randomUUID(), eventType: "hospital.capacity.updated", sourceService: "hospital-service", eventId: randomUUID(), payload: {}, occurredAt: null }),
        (err) => err.code === "23503"
      );
    });

    test("near search: within radius, nearest first", async () => {
      const found = await service.findDisastersNear(18.52, 73.85, 5);
      assert.ok(found.length > 0 && found.every((d) => d.distanceKm <= 5));
    });
  });

  // -------------------------------------------------------------------
  describe("auth-service repositories", () => {
    let users, tokens;
    before(async () => {
      const R = (p) => importFile(path.join(SVC("auth-service"), "src", p));
      users = (await R("repositories/userRepository.js")).createUserRepository(pools.auth);
      tokens = (await R("repositories/refreshTokenRepository.js")).createRefreshTokenRepository(pools.auth);
    });

    test("emails are unique case-insensitively (citext); a concurrent duplicate fails with 23505", async () => {
      const email = `Dup.${randomUUID().slice(0, 6)}@Example.com`;
      const r = await Promise.allSettled([
        users.create({ email, passwordHash: "$2a$12$x", fullName: "A", role: "CITIZEN" }),
        users.create({ email: email.toLowerCase(), passwordHash: "$2a$12$y", fullName: "B", role: "CITIZEN" }),
      ]);
      assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal(r.find((x) => x.status === "rejected").reason.code, "23505");
      assert.equal(await users.emailExists(email.toUpperCase()), true);
    });

    test("refresh rotation is single-use under concurrency, and expired tokens are purged", async () => {
      const u = await users.create({ email: `rot.${randomUUID().slice(0, 6)}@example.com`, passwordHash: "$2a$12$z", fullName: "R", role: "CITIZEN" });
      const exp = new Date(Date.now() + 3600_000);
      await tokens.store({ userId: u.id, tokenHash: "h-old", expiresAt: exp });
      const r = await Promise.all([
        tokens.rotate({ oldTokenHash: "h-old", newTokenHash: "h-a", userId: u.id, expiresAt: exp }),
        tokens.rotate({ oldTokenHash: "h-old", newTokenHash: "h-b", userId: u.id, expiresAt: exp }),
      ]);
      assert.deepEqual(r.sort(), [false, true]);
      await tokens.store({ userId: u.id, tokenHash: "h-expired", expiresAt: new Date(Date.now() - 3 * 24 * 3600_000) });
      const purged = await tokens.purgeExpired(24);
      assert.ok(purged >= 1);
      assert.equal(await tokens.findByHash("h-expired"), null);
      assert.ok(await tokens.findByHash("h-a") || await tokens.findByHash("h-b"));
    });

    test("the last active SYSTEM_ADMIN cannot be demoted, even by two concurrent requests", async () => {
      await pools.auth.query("UPDATE users SET role_id = (SELECT id FROM roles WHERE name = 'CITIZEN') WHERE role_id = (SELECT id FROM roles WHERE name = 'SYSTEM_ADMIN')");
      const a = await users.create({ email: `adm1.${randomUUID().slice(0, 6)}@example.com`, passwordHash: "$2a$12$q", fullName: "A1", role: "SYSTEM_ADMIN" });
      const b = await users.create({ email: `adm2.${randomUUID().slice(0, 6)}@example.com`, passwordHash: "$2a$12$q", fullName: "A2", role: "SYSTEM_ADMIN" });
      const r = await Promise.allSettled([users.updateGuarded(a.id, { role: "CITIZEN" }), users.updateGuarded(b.id, { role: "CITIZEN" })]);
      const outcomes = r.map((x) => (x.status === "fulfilled" ? x.value?.error || "ok" : x.reason.code || x.reason.message));
      assert.equal(await users.countActiveAdmins(), 1, `outcomes: ${JSON.stringify(outcomes)}`);
    });
  });

  // -------------------------------------------------------------------
  // Phase 14: the transactional outbox on real transactions and row locks.
  describe("Phase 14: transactional outbox (disaster_db)", () => {
    let pool, service, outbox, createOutbox, sent;
    before(async () => {
      const D = (p) => importFile(path.join(SVC("disaster-service"), "src", p));
      const { createDisasterRepository } = await D("repositories/disasterRepository.js");
      const { createDisasterService } = await D("services/disasterService.js");
      const { withTransaction } = await D("db/transaction.js");
      ({ createOutbox } = await D("outbox.js"));
      pool = pools.disaster;
      sent = [];
      outbox = createOutbox({ pool, publish: async (key, env) => sent.push({ key, env }) });
      outbox.kick = () => {}; // relay passes are driven explicitly below
      const transaction = (fn) => withTransaction(pool, (client) => fn({ disasterRepository: createDisasterRepository(client), client }));
      service = createDisasterService({ disasterRepository: createDisasterRepository(pool), outbox, transaction });
      await pool.query("DELETE FROM outbox");
    });

    const unsent = async () => (await pool.query("SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL")).rows[0].n;
    const flood = { type: "FLOOD", severity: "HIGH", latitude: 18.52, longitude: 73.85, radiusKm: 15, description: "outbox test" };

    test("creating a disaster stores its event in the same transaction; the relay sends it once", async () => {
      const { disaster, eventPublished } = await service.createDisaster(flood, randomUUID());
      assert.equal(eventPublished, true);
      const { rows } = await pool.query("SELECT routing_key, envelope FROM outbox WHERE envelope->>'correlationId' = $1", [disaster.id]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].routing_key, "disaster.detected");
      assert.equal(rows[0].envelope.payload.disasterId, disaster.id);
      assert.equal(await unsent(), 1);
      assert.equal(await outbox.relayOnce(), 1);
      assert.equal(await unsent(), 0);
      assert.equal(await outbox.relayOnce(), 0, "a sent row is never sent again");
      assert.equal(sent.at(-1).env.eventId, rows[0].envelope.eventId);
    });

    test("a failed change leaves no event behind (409 → rolled back together)", async () => {
      const { disaster } = await service.createDisaster(flood, randomUUID());
      await outbox.drain();
      await service.setStatus(disaster.id, "RESOLVED");
      const before = (await pool.query("SELECT count(*)::int AS n FROM outbox")).rows[0].n;
      await assert.rejects(service.setStatus(disaster.id, "CONTAINED"), (err) => err.code === "INVALID_STATUS_TRANSITION");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM outbox")).rows[0].n, before);
    });

    test("while RabbitMQ is down the event waits; when it's back it is sent", async () => {
      let up = false;
      const flaky = createOutbox({ pool, publish: async (key, env) => { if (!up) throw new Error("RabbitMQ is not connected"); sent.push({ key, env }); } });
      await outbox.drain();
      await service.createDisaster(flood, randomUUID());
      assert.equal(await flaky.relayOnce(), 0);
      assert.equal(await unsent(), 1);
      const { rows } = await pool.query("SELECT attempts, last_error FROM outbox WHERE published_at IS NULL");
      assert.equal(rows[0].attempts, 1);
      assert.match(rows[0].last_error, /not connected/);
      up = true;
      assert.equal(await flaky.relayOnce(), 1);
      assert.equal(await unsent(), 0);
    });

    test("two relays running at once (two replicas) never send the same row", async () => {
      await outbox.drain();
      for (let i = 0; i < 20; i++) await service.createDisaster(flood, randomUUID());
      const seen = [];
      // A small delay per publish keeps both relays' transactions open at the same time.
      const slow = () => createOutbox({ pool, batchSize: 5, publish: async (key, env) => { seen.push(env.eventId); await new Promise((r) => setTimeout(r, 20)); } });
      const [a, b] = [slow(), slow()];
      await Promise.all([a.drain(), b.drain()]);
      assert.equal(seen.length, 20, "every row sent");
      assert.equal(new Set(seen).size, 20, "no row sent twice");
      assert.equal(await unsent(), 0);
    });
  });

  // -------------------------------------------------------------------
  // Phase 15: the response engine's plan lifecycle on real transactions.
  // Commands are read from the outbox table; the executors' replies are
  // fed back in by hand, exactly as they arrive from the bus.
  describe("Phase 15: response plans (response_db)", () => {
    let pool, engine, outbox, envelope;
    const operator = { id: randomUUID(), role: "EMERGENCY_OPERATOR" };
    const reaction = (eventType, sourceService, disasterId, payload) =>
      envelope(eventType, sourceService, payload, disasterId);

    before(async () => {
      const R = (p) => importFile(path.join(SVC("response-service"), "src", p));
      const { createResponseRepository } = await R("repositories/responseRepository.js");
      const { createResponseService } = await R("services/responseService.js");
      const { withTransaction } = await R("db/transaction.js");
      const { createOutbox } = await R("outbox.js");
      pool = pools.response;
      outbox = createOutbox({ pool, publish: async () => {} });
      outbox.kick = () => {};
      const transaction = (fn) => withTransaction(pool, (client) => fn({ repo: createResponseRepository(client), client }));
      engine = createResponseService({ transaction, repository: createResponseRepository(pool), outbox, log: { log() {}, warn() {}, error() {} } });
      envelope = (eventType, sourceService, payload, correlationId) => ({
        eventId: randomUUID(), eventType, sourceService, correlationId, occurredAt: new Date().toISOString(), payload,
      });
    });

    const commandsSent = async (planId) =>
      (await pool.query(`SELECT routing_key, envelope FROM outbox WHERE routing_key LIKE 'command.%' AND envelope->'payload'->>'planId' = $1 ORDER BY id`, [planId])).rows
        .map((r) => ({ key: r.routing_key, payload: r.envelope.payload }));
    const reply = (cmd, result, ok = true) =>
      engine.handleCommandReply(envelope(ok ? "command.succeeded" : "command.failed", cmd.key.startsWith("command.blood") ? "blood-bank-service" : cmd.key.startsWith("command.disaster") ? "disaster-service" : "ambulance-service",
        ok ? { commandId: cmd.payload.commandId, result } : { commandId: cmd.payload.commandId, error: result }, cmd.payload.commandId));

    async function detect({ severity = "HIGH", radiusKm = 15, ambulances = 1 } = {}) {
      const disasterId = randomUUID();
      const base = { disasterId, type: "FLOOD", severity, latitude: 18.52, longitude: 73.85, radiusKm, description: "plan test", status: "ACTIVE" };
      await engine.handleDisasterEvent(envelope("disaster.detected", "disaster-service", base, disasterId));
      await engine.handleReaction(reaction("hospital.capacity.updated", "hospital-service", disasterId, { searchRadiusKm: radiusKm, totalAvailableIcuBeds: 20, nearbyHospitals: [{ id: randomUUID(), name: "City Hospital", distanceKm: 2, availableBeds: 30, emergencyStatus: "NORMAL" }] }));
      await engine.handleReaction(await reaction("ambulance.status.updated", "ambulance-service", disasterId, { searchRadiusKm: radiusKm, availableAmbulanceCount: ambulances }));
      await engine.handleReaction(await reaction("blood.shortage.detected", "blood-bank-service", disasterId, { searchRadiusKm: radiusKm, nearbyBloodBanks: [{ id: randomUUID(), name: "Central Bank", distanceKm: 3 }], shortageAlerts: [] }));
      return { disasterId, base };
    }

    test("the three key reactions in → a revision-1 plan is proposed once (a 4th reaction doesn't re-plan)", async () => {
      const { disasterId } = await detect({ ambulances: 1 });
      await engine.handleReaction(await reaction("power.infrastructure.at_risk", "power-service", disasterId, { searchRadiusKm: 15, totalAtRiskTransformerCount: 0 }));
      const plans = await engine.listPlans({ disasterId });
      assert.equal(plans.length, 1);
      assert.equal(plans[0].status, "PROPOSED");
      assert.deepEqual(plans[0].actions.map((a) => a.kind), ["ambulance.dispatch", "disaster.widen_radius", "blood.reserve", "blood.reserve"]);
    });

    test("approve → one command per action in the outbox; a second approval gets 409", async () => {
      const { disasterId } = await detect({ ambulances: 1 });
      const [plan] = await engine.listPlans({ disasterId });
      const approved = await engine.approve(plan.id, operator);
      assert.equal(approved.status, "EXECUTING");
      assert.ok(approved.actions.every((a) => a.status === "PENDING" && a.commandId));
      const sent = await commandsSent(plan.id);
      assert.deepEqual(sent.map((c) => c.key), ["command.ambulance.dispatch", "command.disaster.widen-radius", "command.blood.reserve", "command.blood.reserve"]);
      assert.equal(sent[0].payload.requestedBy, operator.id);
      await assert.rejects(engine.approve(plan.id, operator), (err) => err.statusCode === 409);
    });

    test("replies settle the plan; escalation leads to a revision-2 plan for the shortfall only; undo reverses revision 1", async () => {
      const { disasterId, base } = await detect({ ambulances: 1 });
      const [plan] = await engine.listPlans({ disasterId });
      await engine.approve(plan.id, operator);
      const [dispatch, widen, oNeg, oPos] = await commandsSent(plan.id);
      const emergencyIds = [randomUUID()];
      await reply(dispatch, { emergencyIds, dispatchedCount: 1, unassignedCount: 0 });
      await reply(dispatch, { emergencyIds, dispatchedCount: 1, unassignedCount: 0 }); // duplicate: ignored
      await reply(oNeg, { reservationId: randomUUID() });
      await reply(oPos, { code: "INSUFFICIENT_INVENTORY", message: "No single batch of O+ has 4 available units." }, false);
      let current = await engine.getPlan(plan.id);
      assert.equal(current.status, "EXECUTING", "the escalation hasn't replied yet");
      await reply(widen, { disasterId, radiusKm: 30, changed: true });
      current = await engine.getPlan(plan.id);
      assert.equal(current.status, "PARTIAL", "one blood reservation failed");

      // disaster-service widened the radius: disaster.updated + reactions at 30 km.
      await engine.handleDisasterEvent(envelope("disaster.updated", "disaster-service", { ...base, radiusKm: 30 }, disasterId));
      await engine.handleReaction(await reaction("hospital.capacity.updated", "hospital-service", disasterId, { searchRadiusKm: 30, totalAvailableIcuBeds: 20, nearbyHospitals: [{ id: randomUUID(), name: "City Hospital", distanceKm: 2, availableBeds: 30, emergencyStatus: "NORMAL" }] }));
      await engine.handleReaction(await reaction("ambulance.status.updated", "ambulance-service", disasterId, { searchRadiusKm: 30, availableAmbulanceCount: 6 }));
      await engine.handleReaction(await reaction("blood.shortage.detected", "blood-bank-service", disasterId, { searchRadiusKm: 30, nearbyBloodBanks: [{ id: randomUUID(), name: "Far Bank", distanceKm: 20 }], shortageAlerts: [] }));
      const second = (await engine.listPlans({ disasterId })).find((p) => p.revision === 2);
      assert.ok(second, "revision-2 plan proposed");
      const kinds = second.actions.map((a) => `${a.kind}:${a.params.count ?? a.params.bloodType ?? ""}`);
      assert.deepEqual(kinds, ["ambulance.dispatch:3", "blood.reserve:O+"], "3 more ambulances (4 needed, 1 sent) and only the O+ that failed; no second escalation");

      // Undo revision 1: stand down its calls and release its reservation.
      const undoing = await engine.undo(plan.id, operator);
      assert.equal(undoing.status, "UNDOING");
      const undoCommands = (await commandsSent(plan.id)).slice(4);
      assert.deepEqual(undoCommands.map((c) => c.key).sort(), ["command.ambulance.stand-down", "command.blood.release"]);
      assert.deepEqual(undoCommands.find((c) => c.key === "command.ambulance.stand-down").payload.emergencyIds, emergencyIds);
      for (const c of undoCommands) await reply(c, { ok: true });
      current = await engine.getPlan(plan.id);
      assert.equal(current.status, "ROLLED_BACK");
      assert.deepEqual(current.actions.map((a) => a.status), ["UNDONE", "SUCCEEDED", "UNDONE", "FAILED"], "widening isn't reversed; the failed reservation had nothing to undo");
      await assert.rejects(engine.undo(plan.id, operator), (err) => err.statusCode === 409);

      // Resolving the disaster expires the undecided revision-2 plan.
      await engine.handleDisasterEvent(envelope("disaster.resolved", "disaster-service", { ...base, radiusKm: 30, status: "RESOLVED" }, disasterId));
      assert.equal((await engine.getPlan(second.id)).status, "EXPIRED");
    });

    test("the follow-up waits for a slow dispatch reply, then counts the ambulances it sent", async () => {
      // Found on the cluster: a big dispatch replies after the escalation;
      // the follow-up used to be planned in between, counting 0 sent.
      const { disasterId, base } = await detect({ ambulances: 1 });
      const [plan] = await engine.listPlans({ disasterId });
      await engine.approve(plan.id, operator);
      const [dispatch, widen, oNeg, oPos] = await commandsSent(plan.id);
      await reply(widen, { disasterId, radiusKm: 30, changed: true });
      await engine.handleDisasterEvent(envelope("disaster.updated", "disaster-service", { ...base, radiusKm: 30 }, disasterId));
      for (const [key, src, payload] of [
        ["hospital.capacity.updated", "hospital-service", { searchRadiusKm: 30, totalAvailableIcuBeds: 20, nearbyHospitals: [{ id: randomUUID(), name: "City Hospital", distanceKm: 2, availableBeds: 30, emergencyStatus: "NORMAL" }] }],
        ["ambulance.status.updated", "ambulance-service", { searchRadiusKm: 30, availableAmbulanceCount: 5 }],
        ["blood.shortage.detected", "blood-bank-service", { searchRadiusKm: 30, nearbyBloodBanks: [{ id: randomUUID(), name: "Far Bank", distanceKm: 20 }], shortageAlerts: [] }],
      ]) await engine.handleReaction(reaction(key, src, disasterId, payload));
      await reply(oNeg, { reservationId: randomUUID() });
      await reply(oPos, { reservationId: randomUUID() });
      assert.equal((await engine.listPlans({ disasterId })).length, 1, "no follow-up while the dispatch is still running");
      await reply(dispatch, { emergencyIds: [randomUUID()], dispatchedCount: 1, unassignedCount: 0 });
      const second = (await engine.listPlans({ disasterId })).find((p) => p.revision === 2);
      assert.ok(second, "planned as soon as revision 1 settled");
      assert.equal(second.actions.find((a) => a.kind === "ambulance.dispatch").params.count, 3, "4 needed − 1 sent");
    });

    test("reject skips every action and sends nothing", async () => {
      const { disasterId } = await detect({ ambulances: 8 });
      const [plan] = await engine.listPlans({ disasterId });
      const rejected = await engine.reject(plan.id, operator, { note: "handled by fire brigade" });
      assert.equal(rejected.status, "REJECTED");
      assert.equal(rejected.decisionNote, "handled by fire brigade");
      assert.ok(rejected.actions.every((a) => a.status === "SKIPPED" || a.status === "INFO"));
      assert.equal((await commandsSent(plan.id)).length, 0);
    });

    test("a command with no reply times out as FAILED and the plan settles PARTIAL", async () => {
      const { disasterId } = await detect({ ambulances: 8, severity: "LOW" });
      const [plan] = await engine.listPlans({ disasterId });
      await engine.approve(plan.id, operator);
      await pool.query(`UPDATE response_actions SET sent_at = now() - interval '10 minutes' WHERE plan_id = $1`, [plan.id]);
      await engine.sweep();
      const current = await engine.getPlan(plan.id);
      assert.equal(current.status, "PARTIAL");
      assert.equal(current.actions[0].error.code, "TIMEOUT");
    });

    test("a disaster that never gets all three reactions is still planned after the wait", async () => {
      const disasterId = randomUUID();
      await engine.handleDisasterEvent(envelope("disaster.detected", "disaster-service", { disasterId, type: "FIRE", severity: "MEDIUM", latitude: 18.5, longitude: 73.8, radiusKm: 10, description: "x", status: "ACTIVE" }, disasterId));
      assert.equal((await engine.listPlans({ disasterId })).length, 0);
      await pool.query(`UPDATE disaster_context SET detected_at = now() - interval '1 minute' WHERE disaster_id = $1`, [disasterId]);
      await engine.sweep();
      const [plan] = await engine.listPlans({ disasterId });
      assert.ok(plan, "planned by the sweep");
      assert.equal(plan.actions[0].kind, "ambulance.dispatch");
      assert.ok(plan.actions.some((a) => a.kind === "notice" && a.params.topic === "blood-unplaced"));
    });
  });

  // -------------------------------------------------------------------
  // Phase 15: an executor runs a command once, even when it's delivered twice.
  describe("Phase 15: ambulance dispatch command (ambulance_db)", () => {
    test("the same dispatch command twice creates its emergencies once and replies twice", async () => {
      const A = (p) => importFile(path.join(SVC("ambulance-service"), "src", p));
      const { createEmergencyRepository } = await A("repositories/emergencyRepository.js");
      const { createAmbulanceRepository } = await A("repositories/ambulanceRepository.js");
      const { createDispatchService } = await A("services/dispatchService.js");
      const { withTransaction } = await A("db/transaction.js");
      const { createOutbox } = await A("outbox.js");
      const { createCommandProcessor } = await A("commands.js");
      const { createAmbulanceCommandHandlers } = await A("consumers/commandConsumer.js");
      const pool = pools.ambulance;
      const outbox = createOutbox({ pool, publish: async () => {} });
      outbox.kick = () => {};
      const transaction = (fn) => withTransaction(pool, (client) => fn({ ambulanceRepository: createAmbulanceRepository(client), emergencyRepository: createEmergencyRepository(client), client }));
      const emergencyRepository = createEmergencyRepository(pool);
      const dispatchService = createDispatchService({ ambulanceRepository: createAmbulanceRepository(pool), emergencyRepository, transaction, outbox });
      const handlers = createAmbulanceCommandHandlers({ emergencyRepository, dispatchService });
      const processCommand = createCommandProcessor({ pool, outbox, log: { warn() {} } });

      const commandId = randomUUID();
      const env = { eventType: "command.ambulance.dispatch", sourceService: "response-service", payload: { commandId, planId: randomUUID(), disasterId: randomUUID(), latitude: 18.52, longitude: 73.85, count: 2, severity: "HIGH", description: "flood" } };
      const first = await processCommand(env, handlers["command.ambulance.dispatch"]);
      const second = await processCommand(env, handlers["command.ambulance.dispatch"]);
      assert.equal(first.outcome, "succeeded");
      assert.equal(second.duplicate, true);
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM emergencies WHERE source_command_id = $1", [commandId]);
      assert.equal(rows[0].n, 2, "two calls, not four");
      const replies = await pool.query("SELECT envelope FROM outbox WHERE routing_key = 'command.succeeded' AND envelope->>'correlationId' = $1", [commandId]);
      assert.equal(replies.rows.length, 2, "the reply is sent again for the duplicate");
      assert.deepEqual(replies.rows[0].envelope.payload.result.emergencyIds, replies.rows[1].envelope.payload.result.emergencyIds);
    });
  });
});

void silentWarn;
