// The ledger: an append-only, double-entry, hash-chained journal. It is the source of truth for who is owed what.
// Contract:
//   - every entry is a set of postings that sums to zero (sats never appear or vanish);
//   - only `ext:*` accounts (the outside world) may go negative; everything else is refused with INSUFFICIENT_FUNDS;
//   - an idempotency key applies once: a replay returns the first entry, a replay with different money is a CONFLICT;
//   - each entry stores sha256(previous hash + its own content), so history cannot be edited quietly.
// Callers: apps/gateway services (every money movement), reserve snapshots, the verify page (via the API).
import { createHash } from "node:crypto";
import { AppError, type Clock, newId, toSafeInt } from "@melax/core";
import type { Db, Migration } from "./db.ts";

export const ledgerMigrations: Migration[] = [
  {
    name: "ledger/001-init",
    sql: [
      `CREATE TABLE accounts (
         account TEXT PRIMARY KEY,
         balance BIGINT NOT NULL DEFAULT 0
       )`,
      `CREATE TABLE journal (
         seq BIGINT PRIMARY KEY,
         id TEXT NOT NULL UNIQUE,
         ts BIGINT NOT NULL,
         kind TEXT NOT NULL,
         idem_key TEXT NOT NULL UNIQUE,
         meta JSONB NOT NULL,
         body_hash TEXT NOT NULL,
         prev_hash TEXT NOT NULL,
         hash TEXT NOT NULL
       )`,
      `CREATE TABLE postings (
         journal_seq BIGINT NOT NULL REFERENCES journal(seq),
         account TEXT NOT NULL,
         delta BIGINT NOT NULL,
         PRIMARY KEY (journal_seq, account)
       )`,
      `CREATE INDEX postings_account ON postings(account, journal_seq)`,
      `CREATE TABLE ledger_head (
         id INT PRIMARY KEY CHECK (id = 1),
         seq BIGINT NOT NULL,
         hash TEXT NOT NULL
       )`,
      `INSERT INTO ledger_head (id, seq, hash) VALUES (1, 0, '${"0".repeat(64)}')`,
    ],
  },
];

export interface Posting {
  account: string;
  /** Signed whole sats. Positive credits the account. */
  delta: number;
}

export interface Entry {
  kind: string;
  idemKey: string;
  postings: Posting[];
  meta?: Record<string, unknown>;
}

export interface Posted {
  seq: number;
  id: string;
  hash: string;
  duplicate: boolean;
}

const ACCOUNT_RE = /^[a-z][a-z0-9_]*(:[A-Za-z0-9_.-]+)*$/;

/** Accounts that mirror the world outside the gateway. They are the only ones allowed below zero. */
export function isExternal(account: string): boolean {
  return account.startsWith("ext:");
}

/** Sorted object keys, so the same content always hashes the same way (jsonb does not keep key order). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  return (
    "{" +
    Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k]))
      .join(",") +
    "}"
  );
}

function canonicalPostings(postings: Posting[]): Posting[] {
  if (!Array.isArray(postings) || postings.length < 2) throw new AppError("BAD_INPUT", "an entry needs at least two postings");
  const merged = new Map<string, number>();
  for (const p of postings) {
    if (typeof p.account !== "string" || !ACCOUNT_RE.test(p.account)) throw new AppError("BAD_INPUT", "bad account name");
    if (typeof p.delta !== "number" || !Number.isSafeInteger(p.delta) || p.delta === 0) throw new AppError("BAD_AMOUNT", "posting must be a non-zero whole number of sats");
    merged.set(p.account, (merged.get(p.account) ?? 0) + p.delta);
  }
  const out = [...merged.entries()].map(([account, delta]) => ({ account, delta })).sort((a, b) => (a.account < b.account ? -1 : 1));
  if (out.length < 2 || out.some((p) => p.delta === 0 || !Number.isSafeInteger(p.delta))) throw new AppError("BAD_INPUT", "postings cancel out on the same account");
  if (out.reduce((s, p) => s + p.delta, 0) !== 0) throw new AppError("BAD_INPUT", "postings do not sum to zero");
  return out;
}

function bodyHash(kind: string, postings: Posting[], meta: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson({ kind, postings, meta })).digest("hex");
}

function entryHash(prev: string, seq: number, id: string, ts: number, idemKey: string, body: string): string {
  return createHash("sha256").update([prev, seq, id, ts, idemKey, body].join("|")).digest("hex");
}

/**
 * Write one entry. Runs inside the caller's transaction if there is one, so a money movement and the
 * rows that describe it (proofs, trade state, receipts) commit or roll back together.
 */
export async function post(db: Db, clock: Clock, entry: Entry): Promise<Posted> {
  if (typeof entry.idemKey !== "string" || entry.idemKey.length < 1 || entry.idemKey.length > 200) throw new AppError("BAD_INPUT", "bad idempotency key");
  if (typeof entry.kind !== "string" || !entry.kind) throw new AppError("BAD_INPUT", "bad entry kind");
  const postings = canonicalPostings(entry.postings);
  const meta = entry.meta ?? {};
  const body = bodyHash(entry.kind, postings, meta);

  return db.tx(async (tx) => {
    // One writer at a time: the head row is the lock that orders the chain.
    const head = (await tx.query<{ seq: number; hash: string }>("SELECT seq, hash FROM ledger_head WHERE id = 1 FOR UPDATE"))[0]!;

    const prior = await tx.query<{ seq: number; id: string; hash: string; body_hash: string }>("SELECT seq, id, hash, body_hash FROM journal WHERE idem_key = $1", [entry.idemKey]);
    if (prior.length > 0) {
      const p = prior[0]!;
      if (p.body_hash !== body) throw new AppError("CONFLICT", "idempotency key reused with different content", { idemKey: entry.idemKey });
      return { seq: toSafeInt(p.seq), id: p.id, hash: p.hash, duplicate: true };
    }

    for (const p of postings) {
      await tx.query("INSERT INTO accounts (account, balance) VALUES ($1, 0) ON CONFLICT (account) DO NOTHING", [p.account]);
      const row = (await tx.query<{ balance: number }>("UPDATE accounts SET balance = balance + $2 WHERE account = $1 RETURNING balance", [p.account, p.delta]))[0]!;
      if (toSafeInt(row.balance) < 0 && !isExternal(p.account)) {
        throw new AppError("INSUFFICIENT_FUNDS", "account would go negative", { account: p.account });
      }
    }

    const seq = toSafeInt(head.seq) + 1;
    const id = newId("jrn", clock);
    const ts = clock.now();
    const hash = entryHash(head.hash, seq, id, ts, entry.idemKey, body);
    await tx.query("INSERT INTO journal (seq, id, ts, kind, idem_key, meta, body_hash, prev_hash, hash) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)", [
      seq,
      id,
      ts,
      entry.kind,
      entry.idemKey,
      JSON.stringify(meta),
      body,
      head.hash,
      hash,
    ]);
    for (const p of postings) await tx.query("INSERT INTO postings (journal_seq, account, delta) VALUES ($1, $2, $3)", [seq, p.account, p.delta]);
    await tx.query("UPDATE ledger_head SET seq = $1, hash = $2 WHERE id = 1", [seq, hash]);
    return { seq, id, hash, duplicate: false };
  });
}

export async function balance(db: Db, account: string): Promise<number> {
  const r = await db.query<{ balance: number }>("SELECT balance FROM accounts WHERE account = $1", [account]);
  return r.length ? toSafeInt(r[0]!.balance) : 0;
}

export async function allBalances(db: Db, prefix = ""): Promise<Map<string, number>> {
  const rows = await db.query<{ account: string; balance: number }>("SELECT account, balance FROM accounts WHERE account LIKE $1 ORDER BY account", [prefix.replace(/[%_\\]/g, "\\$&") + "%"]);
  return new Map(rows.map((r) => [r.account, toSafeInt(r.balance)]));
}

/** Sum of balances under a prefix, e.g. every `user:` account. */
export async function sumBalances(db: Db, prefix: string): Promise<number> {
  const r = await db.query<{ s: number }>("SELECT COALESCE(SUM(balance), 0)::bigint AS s FROM accounts WHERE account LIKE $1", [prefix.replace(/[%_\\]/g, "\\$&") + "%"]);
  return toSafeInt(r[0]!.s);
}

export interface LedgerCheck {
  ok: boolean;
  entries: number;
  head: string;
  problems: string[];
}

/**
 * Recompute everything from the raw rows: each entry's content hash, the chain, the head pointer,
 * that every entry sums to zero, and that every stored balance equals the sum of its postings.
 */
export async function verifyLedger(db: Db): Promise<LedgerCheck> {
  const problems: string[] = [];
  const journal = await db.query<{ seq: number; id: string; ts: number; kind: string; idem_key: string; meta: Record<string, unknown>; body_hash: string; prev_hash: string; hash: string }>(
    "SELECT seq, id, ts, kind, idem_key, meta, body_hash, prev_hash, hash FROM journal ORDER BY seq",
  );
  const postings = await db.query<{ journal_seq: number; account: string; delta: number }>("SELECT journal_seq, account, delta FROM postings ORDER BY journal_seq, account");
  const bySeq = new Map<number, Posting[]>();
  const sums = new Map<string, number>();
  for (const p of postings) {
    const seq = toSafeInt(p.journal_seq);
    const delta = toSafeInt(p.delta);
    if (!bySeq.has(seq)) bySeq.set(seq, []);
    bySeq.get(seq)!.push({ account: p.account, delta });
    sums.set(p.account, (sums.get(p.account) ?? 0) + delta);
  }

  let prev = "0".repeat(64);
  let expectSeq = 1;
  for (const j of journal) {
    const seq = toSafeInt(j.seq);
    if (seq !== expectSeq) problems.push(`gap in journal: expected seq ${expectSeq}, found ${seq}`);
    expectSeq = seq + 1;
    const lines = bySeq.get(seq) ?? [];
    bySeq.delete(seq);
    if (lines.reduce((s, p) => s + p.delta, 0) !== 0 || lines.length < 2) problems.push(`entry ${seq} does not balance`);
    const body = bodyHash(j.kind, lines, j.meta ?? {});
    if (body !== j.body_hash) problems.push(`entry ${seq} content hash mismatch`);
    if (j.prev_hash !== prev) problems.push(`entry ${seq} previous hash mismatch`);
    const h = entryHash(prev, seq, j.id, toSafeInt(j.ts), j.idem_key, body);
    if (h !== j.hash) problems.push(`entry ${seq} chain hash mismatch`);
    prev = j.hash;
  }
  for (const seq of bySeq.keys()) problems.push(`postings without a journal entry: seq ${seq}`);

  const head = (await db.query<{ seq: number; hash: string }>("SELECT seq, hash FROM ledger_head WHERE id = 1"))[0]!;
  if (toSafeInt(head.seq) !== journal.length || head.hash !== prev) problems.push("ledger head does not match the last entry (hash)");

  const stored = await allBalances(db);
  for (const account of new Set([...stored.keys(), ...sums.keys()])) {
    const a = stored.get(account) ?? 0;
    const b = sums.get(account) ?? 0;
    if (a !== b) problems.push(`balance of ${account} is ${a} but its postings sum to ${b}`);
    if (a < 0 && !isExternal(account)) problems.push(`${account} is negative`);
  }
  if ([...stored.values()].reduce((s, v) => s + v, 0) !== 0) problems.push("balances do not sum to zero");

  return { ok: problems.length === 0, entries: journal.length, head: prev, problems };
}
