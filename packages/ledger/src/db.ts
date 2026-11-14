// Database access for the whole gateway: one tiny interface, two drivers.
// Contract: `query` runs one parameterised statement; `tx` runs a function inside one transaction and
// rolls everything back if it throws. Nested `tx` calls join the outer transaction.
// Why not an ORM: every money path is plain SQL a reviewer can read, and the same SQL runs on real
// Postgres (production, integration tests) and on PGlite (unit and property tests, no Docker).
// Callers: ledger.ts, @melax/vault, apps/gateway.
import { toSafeInt } from "@melax/core";

export type Row = Record<string, unknown>;

export interface Db {
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function normalise(rows: unknown[]): Row[] {
  for (const row of rows as Row[]) {
    for (const k of Object.keys(row)) {
      const v = row[k];
      if (typeof v === "bigint") row[k] = toSafeInt(v);
      else if (v instanceof Uint8Array && !Buffer.isBuffer(v)) row[k] = Buffer.from(v);
    }
  }
  return rows as Row[];
}

// ---------- PGlite (tests) ----------

type PgliteLike = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  transaction<T>(fn: (tx: PgliteLike) => Promise<T>): Promise<T | undefined>;
  close?(): Promise<void>;
};

function wrapPglite(conn: PgliteLike, root: PgliteLike | null): Db {
  const self: Db = {
    async query<T = Row>(sql: string, params: unknown[] = []) {
      const r = await conn.query(sql, params);
      return normalise(r.rows) as T[];
    },
    async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      if (root !== null) return fn(self); // already inside a transaction
      let out: T | undefined;
      await conn.transaction(async (tx) => {
        out = await fn(wrapPglite(tx, conn));
      });
      return out as T;
    },
    async close() {
      if (root === null) await conn.close?.();
    },
  };
  return self;
}

/** In-process Postgres for tests. Each call is a fresh, empty database. */
export async function createMemoryDb(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite();
  await (pg as unknown as { waitReady: Promise<void> }).waitReady;
  return wrapPglite(pg as unknown as PgliteLike, null);
}

// ---------- node-postgres (production) ----------

type PgClientLike = { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>; release?(err?: boolean): void };
type PgPoolLike = PgClientLike & { connect(): Promise<PgClientLike>; end(): Promise<void> };

function wrapPg(pool: PgPoolLike, client: PgClientLike | null): Db {
  const conn = client ?? pool;
  const self: Db = {
    async query<T = Row>(sql: string, params: unknown[] = []) {
      const r = await conn.query(sql, params);
      return normalise(r.rows) as T[];
    },
    async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      if (client !== null) return fn(self);
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const out = await fn(wrapPg(pool, c));
        await c.query("COMMIT");
        return out;
      } catch (e) {
        try {
          await c.query("ROLLBACK");
        } catch {
          /* connection is gone; the server rolls back on its own */
        }
        throw e;
      } finally {
        c.release?.();
      }
    },
    async close() {
      if (client === null) await pool.end();
    },
  };
  return self;
}

export async function createPgDb(connectionString: string, opts: { max?: number } = {}): Promise<Db> {
  const pg = (await import("pg")).default;
  pg.types.setTypeParser(20, (v: string) => toSafeInt(v)); // int8 -> checked JS number
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10 });
  return wrapPg(pool as unknown as PgPoolLike, null);
}

// ---------- migrations ----------

export interface Migration {
  /** Unique, ordered name, e.g. "ledger/001-init". */
  name: string;
  sql: string[];
}

/** Applies each migration once, in the order given, inside its own transaction. Safe to call on every boot. */
export async function migrate(db: Db, migrations: Migration[]): Promise<string[]> {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)");
  const applied: string[] = [];
  for (const m of migrations) {
    await db.tx(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(727274)");
      const seen = await tx.query("SELECT 1 FROM schema_migrations WHERE name = $1", [m.name]);
      if (seen.length > 0) return;
      for (const statement of m.sql) await tx.query(statement);
      await tx.query("INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)", [m.name, Date.now()]);
      applied.push(m.name);
    });
  }
  return applied;
}

/** Test helper: empty every table (keeping the schema) so one in-memory database can serve a whole test file. */
export async function truncateAll(db: Db): Promise<void> {
  const tables = await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'");
  if (tables.length === 0) return;
  await db.query(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  if (tables.some((t) => t.tablename === "ledger_head")) {
    await db.query(`INSERT INTO ledger_head (id, seq, hash) VALUES (1, 0, '${"0".repeat(64)}')`);
  }
}
