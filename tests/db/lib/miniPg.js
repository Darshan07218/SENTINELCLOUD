/**
 * TEST-ONLY minimal PostgreSQL client (wire protocol v3), used by the
 * real-database integration suite when the `pg` npm package isn't
 * installed (e.g. an offline CI runner). The services themselves always
 * use `pg`; this exposes just the subset of its API they rely on:
 *
 *   new Pool({ host, port, user, password, database, max })
 *   pool.query(text, values?) -> { rows, rowCount, fields }
 *   pool.connect() -> client { query, release(err?) }
 *   pool.on("error", fn), pool.end()
 *
 * Supports SCRAM-SHA-256 / md5 / cleartext authentication, the simple
 * query protocol (multi-statement migrations) and the extended protocol
 * with text parameters ($1, $2 …). Result values are parsed like `pg`
 * does by default: int2/int4/float/oid -> number, int8/numeric -> string,
 * bool -> boolean, json/jsonb -> object, timestamp(tz)/date -> Date.
 * Errors carry `code` (SQLSTATE), `detail` and `constraint`, like `pg`.
 */
import net from "node:net";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

const PARSERS = {
  16: (v) => v === "t", // bool
  20: (v) => v, // int8 → string (pg default)
  21: Number,
  23: Number,
  26: Number,
  700: Number,
  701: Number,
  1700: (v) => v, // numeric → string (pg default)
  114: JSON.parse,
  3802: JSON.parse,
  1082: (v) => new Date(`${v}T00:00:00`),
  1114: (v) => new Date(`${v.replace(" ", "T")}Z`),
  1184: (v) => new Date(v.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")),
};

function serialize(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return "\\x" + value.toString("hex");
  if (Array.isArray(value)) {
    return "{" + value.map((v) => (v === null || v === undefined ? "NULL" : `"${String(serialize(v)).replace(/(["\\])/g, "\\$1")}"`)).join(",") + "}";
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

class Writer {
  constructor() {
    this.parts = [];
  }
  int32(n) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    this.parts.push(b);
    return this;
  }
  int16(n) {
    const b = Buffer.alloc(2);
    b.writeInt16BE(n);
    this.parts.push(b);
    return this;
  }
  cstr(s) {
    this.parts.push(Buffer.from(s, "utf8"), Buffer.from([0]));
    return this;
  }
  bytes(buf) {
    this.parts.push(buf);
    return this;
  }
  msg(type) {
    const body = Buffer.concat(this.parts);
    const head = Buffer.alloc(type ? 5 : 4);
    if (type) {
      head.write(type, 0, "ascii");
      head.writeInt32BE(body.length + 4, 1);
    } else head.writeInt32BE(body.length + 4, 0);
    return Buffer.concat([head, body]);
  }
}

function parseError(buf) {
  const fields = {};
  let i = 0;
  while (i < buf.length && buf[i] !== 0) {
    const code = String.fromCharCode(buf[i]);
    const end = buf.indexOf(0, i + 1);
    fields[code] = buf.toString("utf8", i + 1, end);
    i = end + 1;
  }
  const err = new Error(fields.M || "postgres error");
  Object.assign(err, { code: fields.C, severity: fields.S, detail: fields.D, constraint: fields.n, table: fields.t, column: fields.c });
  return err;
}

export class Client extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.buffer = Buffer.alloc(0);
    this.queue = [];
    this.current = null;
    this.ready = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const { host = "127.0.0.1", port = 5432, user, database, password } = this.config;
      this.socket = net.connect({ host, port });
      this.socket.on("error", (err) => {
        if (!this.ready) reject(err);
        else this.fail(err);
      });
      this.socket.on("close", () => this.fail(new Error("Connection terminated")));
      this.socket.on("data", (chunk) => this.onData(chunk));
      this.onReady = resolve;
      this.onStartupError = reject;
      this.socket.on("connect", () => {
        const w = new Writer().int32(196608).cstr("user").cstr(user).cstr("database").cstr(database || user).cstr("client_encoding").cstr("UTF8").bytes(Buffer.from([0]));
        this.socket.write(w.msg());
      });
      this.password = password;
    });
  }

  fail(err) {
    const pending = [this.current, ...this.queue].filter(Boolean);
    this.current = null;
    this.queue = [];
    for (const q of pending) q.reject(err);
    if (this.ready && !this.ending) this.emit("error", err);
    this.ready = false;
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 5) {
      const type = String.fromCharCode(this.buffer[0]);
      const len = this.buffer.readInt32BE(1);
      if (this.buffer.length < len + 1) return;
      const body = this.buffer.subarray(5, len + 1);
      this.buffer = this.buffer.subarray(len + 1);
      this.handle(type, body);
    }
  }

  handle(type, body) {
    switch (type) {
      case "R":
        return this.auth(body);
      case "S":
      case "K":
      case "N":
      case "1":
      case "2":
      case "3":
      case "n":
      case "s":
        return;
      case "Z":
        if (!this.ready) {
          this.ready = true;
          return this.onReady(this);
        }
        if (this.current) {
          const q = this.current;
          this.current = null;
          if (q.error) q.reject(q.error);
          else q.resolve(q.results.length === 1 ? q.results[0] : q.results[q.results.length - 1]);
        }
        return this.pump();
      case "E": {
        const err = parseError(body);
        if (!this.ready) return this.onStartupError(err);
        if (this.current) this.current.error = err;
        return;
      }
      case "T": {
        const n = body.readInt16BE(0);
        const fields = [];
        let i = 2;
        for (let f = 0; f < n; f++) {
          const end = body.indexOf(0, i);
          const name = body.toString("utf8", i, end);
          i = end + 1;
          const typeOid = body.readInt32BE(i + 6);
          fields.push({ name, dataTypeID: typeOid });
          i += 18;
        }
        this.current.fields = fields;
        this.current.rows = [];
        return;
      }
      case "D": {
        const n = body.readInt16BE(0);
        let i = 2;
        const row = {};
        for (let c = 0; c < n; c++) {
          const len = body.readInt32BE(i);
          i += 4;
          const field = this.current.fields[c];
          if (len === -1) row[field.name] = null;
          else {
            const text = body.toString("utf8", i, i + len);
            i += len;
            const parse = PARSERS[field.dataTypeID];
            row[field.name] = parse ? parse(text) : text;
          }
        }
        this.current.rows.push(row);
        return;
      }
      case "C": {
        const tag = body.toString("utf8", 0, body.length - 1);
        const m = tag.match(/(\d+)$/);
        this.current.results.push({ rows: this.current.rows || [], fields: this.current.fields || [], rowCount: m ? Number(m[1]) : null, command: tag.split(" ")[0] });
        this.current.rows = null;
        this.current.fields = null;
        return;
      }
      case "I":
        this.current.results.push({ rows: [], fields: [], rowCount: null });
        return;
      default:
        return;
    }
  }

  auth(body) {
    const kind = body.readInt32BE(0);
    if (kind === 0) return; // AuthenticationOk
    if (kind === 3) return this.socket.write(new Writer().cstr(this.password).msg("p"));
    if (kind === 5) {
      const salt = body.subarray(4, 8);
      const inner = createHash("md5").update(this.password + this.config.user).digest("hex");
      const outer = createHash("md5").update(Buffer.concat([Buffer.from(inner), salt])).digest("hex");
      return this.socket.write(new Writer().cstr("md5" + outer).msg("p"));
    }
    if (kind === 10) {
      this.clientNonce = randomBytes(18).toString("base64");
      this.clientFirstBare = `n=*,r=${this.clientNonce}`;
      const first = Buffer.from("n,," + this.clientFirstBare);
      return this.socket.write(new Writer().cstr("SCRAM-SHA-256").int32(first.length).bytes(first).msg("p"));
    }
    if (kind === 11) {
      const serverFirst = body.toString("utf8", 4);
      const attrs = Object.fromEntries(serverFirst.split(",").map((kv) => [kv[0], kv.slice(2)]));
      if (!attrs.r.startsWith(this.clientNonce)) return this.onStartupError(new Error("SCRAM nonce mismatch"));
      const salted = pbkdf2Sync(this.password, Buffer.from(attrs.s, "base64"), Number(attrs.i), 32, "sha256");
      const clientKey = createHmac("sha256", salted).update("Client Key").digest();
      const storedKey = createHash("sha256").update(clientKey).digest();
      const finalBare = `c=biws,r=${attrs.r}`;
      const authMessage = `${this.clientFirstBare},${serverFirst},${finalBare}`;
      const signature = createHmac("sha256", storedKey).update(authMessage).digest();
      const proof = Buffer.from(clientKey.map((b, i) => b ^ signature[i]));
      this.expectedServerSig = createHmac("sha256", createHmac("sha256", salted).update("Server Key").digest()).update(authMessage).digest("base64");
      return this.socket.write(new Writer().bytes(Buffer.from(`${finalBare},p=${proof.toString("base64")}`)).msg("p"));
    }
    if (kind === 12) {
      const v = body.toString("utf8", 4).replace(/^v=/, "");
      if (v !== this.expectedServerSig) this.onStartupError(new Error("SCRAM server signature mismatch"));
      return;
    }
    this.onStartupError(new Error(`unsupported auth method ${kind}`));
  }

  query(text, values) {
    if (typeof text === "object") ({ text, values } = text);
    return new Promise((resolve, reject) => {
      this.queue.push({ text, values, resolve, reject, results: [], rows: null, fields: null });
      this.pump();
    });
  }

  pump() {
    if (this.current || !this.ready || this.queue.length === 0) return;
    this.current = this.queue.shift();
    const { text, values } = this.current;
    if (!values || values.length === 0) {
      this.socket.write(new Writer().cstr(text).msg("Q"));
      return;
    }
    const params = values.map(serialize);
    const bind = new Writer().cstr("").cstr("").int16(0).int16(params.length);
    for (const p of params) {
      if (p === null) bind.int32(-1);
      else {
        const b = Buffer.from(p, "utf8");
        bind.int32(b.length).bytes(b);
      }
    }
    bind.int16(0);
    this.socket.write(
      Buffer.concat([
        new Writer().cstr("").cstr(text).int16(0).msg("P"),
        bind.msg("B"),
        new Writer().bytes(Buffer.from("P")).cstr("").msg("D"),
        new Writer().cstr("").int32(0).msg("E"),
        new Writer().msg("S"),
      ])
    );
  }

  end() {
    this.ending = true;
    return new Promise((resolve) => {
      if (!this.socket || this.socket.destroyed) return resolve();
      this.socket.once("close", resolve);
      this.socket.end(new Writer().msg("X"));
    });
  }
}

export class Pool extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = config;
    this.max = config.max || 10;
    this.idle = [];
    this.all = new Set();
    this.waiters = [];
  }

  async connect() {
    if (this.idle.length) return this.idle.pop();
    if (this.all.size < this.max) {
      const client = new Client(this.config);
      this.all.add(client);
      try {
        await client.connect();
      } catch (err) {
        this.all.delete(client);
        throw err;
      }
      client.on("error", (err) => {
        this.all.delete(client);
        this.emit("error", err, client);
      });
      client.release = (err) => {
        if (err) {
          this.all.delete(client);
          client.end();
        } else if (this.waiters.length) this.waiters.shift()(client);
        else this.idle.push(client);
      };
      return client;
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async query(text, values) {
    const client = await this.connect();
    try {
      return await client.query(text, values);
    } finally {
      client.release();
    }
  }

  get totalCount() {
    return this.all.size;
  }

  async end() {
    await Promise.all([...this.all].map((c) => c.end()));
    this.all.clear();
    this.idle = [];
  }
}

export default { Pool, Client };
