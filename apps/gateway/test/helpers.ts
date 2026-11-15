// Shared set-up for the gateway tests: an App on an in-process database with a clock the test moves,
// an in-memory SMS adapter, a fixed exchange rate and a log that is captured instead of printed.
import { randomBytes } from "node:crypto";
import { FakeClock, createLogger } from "@melax/core";
import type { MintClient } from "@melax/cashu";
import { type Db, createMemoryDb, createPgDb, ledgerMigrations, migrate } from "@melax/ledger";
import type { LightningBackend } from "@melax/lightning";
import { MemorySms } from "@melax/sms";
import { vaultMigrations } from "@melax/vault";
import { type App, buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { gatewayMigrations } from "../src/schema.ts";

/** 1 BTC = 40 000 000 F in tests, so 500 F is 1 250 sats. */
export const RATE = 40_000_000;

/** Stands where the mint or the node would be in tests that must never reach them. Any use is a test failure. */
export function untouchable<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      throw new Error(`this unit test touched ${what} (${String(prop)})`);
    },
  });
}

export interface TestApp {
  app: App;
  db: Db;
  clock: FakeClock;
  sms: MemorySms;
  /** Every log line written so far, as the JSON text that would reach stdout. */
  logs: string[];
}

/**
 * In-process Postgres (PGlite) by default. Set TEST_DATABASE_URL to run the same tests on a real
 * Postgres server instead: the SQL has to behave the same on both, and only a real server has real
 * concurrency. The tests empty every table, so point it at a database made for them.
 */
export async function newDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  const db = url ? await createPgDb(url) : await createMemoryDb();
  await migrate(db, [...ledgerMigrations, ...vaultMigrations, ...gatewayMigrations]);
  return db;
}

export function testApp(
  db: Db,
  opts: { mint?: MintClient; ln?: LightningBackend; env?: Record<string, string>; clock?: FakeClock; fetch?: (url: string, init?: RequestInit) => Promise<Response> } = {},
): TestApp {
  const clock = opts.clock ?? new FakeClock(Date.now());
  const sms = new MemorySms();
  const logs: string[] = [];
  const config = loadConfig({
    MELAX_PEPPER: randomBytes(32).toString("hex"),
    MELAX_DEMO: "1",
    RATE_FIXED_XOF_PER_BTC: String(RATE),
    ADDRESS_DOMAIN: "melax.sn",
    ...opts.env,
  });
  const app = buildApp({
    db,
    clock,
    log: createLogger({ sink: (line) => logs.push(line), clock, level: "debug" }),
    mint: opts.mint ?? untouchable<MintClient>("the mint"),
    ln: opts.ln ?? untouchable<LightningBackend>("the Lightning node"),
    sms,
    config,
    fetch: opts.fetch,
  });
  return { app, db, clock, sms, logs };
}

let counter = 0;

/** One USSD session through the real runtime, the way a provider adapter would drive it. */
export function dial(app: App, phone: string, shortcut: string[] = []) {
  const sessionId = `test-${Date.now()}-${++counter}`;
  let ended = false;
  const send = async (input: string, first: boolean): Promise<string> => {
    const screen = await app.runtime.handle({ sessionId, phone, input, shortcut: first ? shortcut : [] });
    ended = screen.end;
    return screen.text;
  };
  return {
    sessionId,
    open: () => send("", true),
    type: (input: string) => send(input, false),
    /** Type several inputs and return the last screen. */
    async run(...inputs: string[]): Promise<string> {
      let last = "";
      for (const i of inputs) last = await send(i, false);
      return last;
    },
    get ended() {
      return ended;
    },
  };
}

/** Open an account through the menus, in French. */
export async function signUp(app: App, phone: string, pin: string, name: string): Promise<void> {
  const s = dial(app, phone);
  await s.open();
  const last = await s.run("1", pin, pin, name);
  if (!last.startsWith("Compte cree.")) throw new Error("sign-up did not finish: " + last);
}

/**
 * Every value in the captured log, cut into words. Timestamps are left out: thirteen random-looking
 * digits will sooner or later contain any five-digit code by chance, and that says nothing about a leak.
 */
export function logWords(lines: string[]): { text: string; words: Set<string> } {
  const text = lines.map((l) => l.replace(/"ts":\d+,?/g, "")).join("\n");
  return { text, words: new Set(text.split(/[^0-9A-Za-z+]+/).filter(Boolean)) };
}

/** The SMS texts queued for one number, oldest first. */
export async function inbox(app: App, phone: string): Promise<string[]> {
  return (await app.outbox.list(phone)).map((m) => m.body ?? "");
}
