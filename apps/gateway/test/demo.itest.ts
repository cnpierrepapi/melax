// The demo's money paths against the real Nutshell mint and real LND nodes on regtest: the top-up
// button, the deposit it rests on, and the seed. Postgres runs in-process (PGlite) unless
// TEST_DATABASE_URL is set. Needs: docker compose up, bash scripts/dev-creds.sh.
// Faults are injected at the network edge of this process only.
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MintClient } from "@melax/cashu";
import { shortDate } from "@melax/i18n";
import { type Db, balance, truncateAll, verifyLedger } from "@melax/ledger";
import { LndBackend } from "@melax/lightning";
import { DEMO_PEOPLE, DEMO_PIN, seedAgents, seedDemo } from "../src/demo.ts";
import { buildHttp } from "../src/http.ts";
import { type TestApp, dial, inbox, logWords, newDb, signUp, testApp } from "./helpers.ts";

/** The six people seedDemo opens. The two agents after them are seedAgents' job. */
const SHOPPERS = DEMO_PEOPLE.filter((p) => !p.agent);

const keys = resolve(import.meta.dirname, "../../../.keys");
const lnd = (name: string, port: number) =>
  LndBackend.fromFiles({ baseUrl: `https://localhost:${port}`, macaroonPath: `${keys}/lnd-${name}/admin.macaroon`, tlsCertPath: `${keys}/lnd-${name}/tls.cert` });
const MINT = process.env.MINT_URL ?? "http://localhost:3338";

const AWA = "+221771234567";
const MOUSSA = "+221781112233";
const AWA_PIN = "48291";
const MOUSSA_PIN = "73915";

let db: Db;
let mint: MintClient;
let gw: LndBackend;
let world: LndBackend;
let T: TestApp;
let http: FastifyInstance;
let pepper: string;
const allLogs: string[] = [];

const realFetch = globalThis.fetch;
function fault(match: string, mode: "lost-reply" | "down"): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(match)) {
      if (mode === "lost-reply") await realFetch(input, init);
      throw new TypeError("fetch failed (injected " + mode + ")");
    }
    return realFetch(input, init);
  }) as typeof fetch;
}
const heal = () => {
  globalThis.fetch = realFetch;
};

const idOf = async (phone: string) => (await T.app.users.findByPhone(phone))!.id;
const sats = async (phone: string) => balance(db, `user:${await idOf(phone)}:spendable`);
const fund = (body: unknown) => http.inject({ method: "POST", url: "/sim/fund", headers: { "content-type": "application/json" }, payload: JSON.stringify(body) });

async function expectConsistent(): Promise<void> {
  const a = await T.app.vault.auditAll();
  expect(a.mismatches).toEqual([]);
  expect(a.ledgerSat).toBe(a.proofsSat);
  expect((await verifyLedger(db)).problems).toEqual([]);
  // Nothing is left in between: every sat that arrived on the node became somebody's ecash.
  expect(await balance(db, "float:node")).toBe(0);
  expect(await balance(db, "float:minting")).toBe(0);
}

/** Start a fresh app on the same database (a restart), keeping the clock and the server secret. */
function start(env: Record<string, string> = {}): void {
  T = testApp(db, { mint, ln: gw, world, clock: T?.clock, env: { MELAX_PEPPER: pepper, STEP_BUDGET_MS: "60000", ...env } });
  const push = T.logs.push.bind(T.logs);
  T.logs.push = (...lines: string[]) => {
    allLogs.push(...lines);
    return push(...lines);
  };
  http = buildHttp(T.app);
}

beforeAll(async () => {
  db = await newDb();
  mint = await MintClient.connect(MINT);
  gw = lnd("gw", 18081);
  world = lnd("world", 18082);
});
beforeEach(async () => {
  heal();
  await truncateAll(db);
  pepper = randomBytes(32).toString("hex");
  T = undefined as unknown as TestApp;
  start();
});
afterAll(async () => {
  heal();
  await gw?.close();
  await world?.close();
  await db?.close();
});

describe("the top-up button", () => {
  it("moves real sats from the world node into the user's ecash, shows in the history and texts the owner", async () => {
    await signUp(T.app, AWA, AWA_PIN, "Awa");
    const worldBefore = (await world.balance()).spendableSat;

    const r = await fund({ phone: "771234567", fcfa: 5000 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, fcfa: 5000, sats: 12_500 });

    expect(await sats(AWA)).toBe(12_500);
    expect(worldBefore - (await world.balance()).spendableSat).toBeGreaterThanOrEqual(12_500);
    const live = await T.app.vault.liveProofs(`user:${await idOf(AWA)}`);
    expect(live.reduce((s, p) => s + p.amount, 0)).toBe(12_500);

    const history = dial(T.app, AWA);
    await history.open();
    expect(await history.run("8", AWA_PIN)).toBe(`${shortDate(T.clock.now())} +5 000 F Lightning\n0 Menu`);
    expect((await inbox(T.app, AWA)).at(-1)).toBe("Melax: recu 5 000 F par Lightning. Solde: 5 000 F.");
    expect(await db.query("SELECT kind, amount_sat, amount_fcfa, counterparty, spend FROM txlog")).toEqual([{ kind: "deposit", amount_sat: 12_500, amount_fcfa: 5000, counterparty: "Lightning", spend: false }]);

    const sms = (await http.inject({ method: "GET", url: "/sim/sms?phone=771234567" })).json() as { messages: Array<{ kind: string }> };
    expect(sms.messages.map((m) => m.kind)).toEqual(["welcome", "deposit"]);

    await expectConsistent();
    expect(await T.app.vault.verifyHoldingsWithMint()).toMatchObject({ notUnspent: 0 });
  });

  it("what was topped up can be sent on, and a deposit does not count toward the spending limits", async () => {
    await signUp(T.app, AWA, AWA_PIN, "Awa");
    await signUp(T.app, MOUSSA, MOUSSA_PIN, "Moussa");
    expect((await fund({ phone: AWA, fcfa: 25_000 })).statusCode).toBe(200);
    expect((await fund({ phone: AWA, fcfa: 25_000 })).statusCode).toBe(200);
    const s = dial(T.app, AWA);
    await s.open();
    expect(await s.run("2", "781112233", "500", "1", AWA_PIN)).toBe("Envoye: 500 F a Moussa.\nRecu no 1003\nSolde: 49 500 F");
    const limits = dial(T.app, AWA);
    await limits.open();
    expect(await limits.run("9", "5")).toContain("Reste aujourd'hui: 49 500 F");
    await expectConsistent();
  });

  it("the mint's reply is lost while it issues the ecash: recovery credits once, with the history row and the SMS", async () => {
    await signUp(T.app, AWA, AWA_PIN, "Awa");
    fault("/v1/mint/bolt11", "lost-reply");
    const r = await fund({ phone: AWA, fcfa: 5000 });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ ok: false, pending: true });
    expect(await sats(AWA)).toBe(0);
    expect(await balance(db, "float:minting")).toBe(12_500); // the sats are in, the ecash is not booked yet
    expect(await db.query("SELECT 1 FROM txlog")).toHaveLength(0);
    expect((await inbox(T.app, AWA)).some((t) => t.includes("Lightning"))).toBe(false);

    heal();
    start(); // a restart: nothing in memory
    expect(await T.app.vault.recover()).toMatchObject({ checked: 1, done: 1 });
    expect(await T.app.vault.recover()).toMatchObject({ checked: 0 });
    expect(await sats(AWA)).toBe(12_500);
    expect(await db.query("SELECT kind, amount_fcfa FROM txlog")).toEqual([{ kind: "deposit", amount_fcfa: 5000 }]);
    expect((await inbox(T.app, AWA)).filter((t) => t === "Melax: recu 5 000 F par Lightning. Solde: 5 000 F.")).toHaveLength(1);
    await expectConsistent();
    expect(await T.app.vault.verifyHoldingsWithMint()).toMatchObject({ notUnspent: 0 });
  }, 240_000);
});

describe("a deposit", () => {
  it("is credited once per payment, to one user, however often it is asked for", async () => {
    await signUp(T.app, AWA, AWA_PIN, "Awa");
    await signUp(T.app, MOUSSA, MOUSSA_PIN, "Moussa");
    const inv = await gw.makeInvoice({ amountSat: 2500, memo: "test deposit" });
    expect((await world.pay({ bolt11: inv.bolt11, maxFeeSat: 20 })).status).toBe("succeeded");

    const awa = await idOf(AWA);
    expect(await T.app.wallet.deposit({ userId: awa, paymentHash: inv.paymentHash })).toEqual({ ok: true, sats: 2500, fcfa: 1000 });
    expect(await T.app.wallet.deposit({ userId: awa, paymentHash: inv.paymentHash })).toEqual({ ok: true, sats: 2500, fcfa: 1000 });
    // the same payment claimed for someone else
    expect(await T.app.wallet.deposit({ userId: await idOf(MOUSSA), paymentHash: inv.paymentHash })).toEqual({ ok: false, err: "GENERIC" });

    expect(await sats(AWA)).toBe(2500);
    expect(await sats(MOUSSA)).toBe(0);
    expect(await db.query("SELECT 1 FROM txlog")).toHaveLength(1);
    expect((await inbox(T.app, AWA)).filter((t) => t.includes("Lightning"))).toHaveLength(1);
    await expectConsistent();
  });

  it("an invoice nobody paid credits nothing, on the real node", async () => {
    await signUp(T.app, AWA, AWA_PIN, "Awa");
    const inv = await gw.makeInvoice({ amountSat: 2500, memo: "never paid" });
    expect(await T.app.wallet.deposit({ userId: await idOf(AWA), paymentHash: inv.paymentHash })).toEqual({ ok: false, err: "NOT_PAID" });
    expect(await T.app.wallet.deposit({ userId: await idOf(AWA), paymentHash: "ef".repeat(32) })).toEqual({ ok: false, err: "NOT_PAID" });
    expect(await db.query("SELECT 1 FROM journal")).toHaveLength(0);
    expect(await sats(AWA)).toBe(0);
  });
});

describe("the seed", () => {
  it("on an empty database: six funded accounts with a history each, books that match, and a state page that leaks nothing", async () => {
    expect(await seedDemo(T.app)).toEqual({ seeded: true, funded: true });
    expect(await db.query("SELECT 1 FROM users")).toHaveLength(6);

    // 1 BTC = 40 000 000 F in tests: 1 F is 2.5 sats. Top-ups, then the five payments.
    const expected: Record<string, number> = { Awa: 15_000 - 2500 + 500, Moussa: 8000 + 1000 - 500, Fatou: 12_000 + 2500 - 1000, Ibrahima: 5000 - 1500, Aminata: 20_000 - 3000 + 1500, Cheikh: 3000 + 3000 };
    for (const p of SHOPPERS) {
      expect(await sats(p.phone), p.name).toBe(expected[p.name]! * 2.5);
      const rows = await db.query("SELECT 1 FROM txlog WHERE user_id = $1", [await idOf(p.phone)]);
      expect(rows.length, p.name).toBeGreaterThanOrEqual(2);
    }
    await expectConsistent();
    expect(await T.app.vault.verifyHoldingsWithMint()).toMatchObject({ notUnspent: 0 });

    // A seeded person can use the wallet straight away with the shared code.
    const s = dial(T.app, DEMO_PEOPLE[0]!.phone);
    await s.open();
    expect(await s.run("1", DEMO_PIN)).toBe("Solde: 13 000 F\n(32 500 sats)\n1 BTC = 40 000 000 F\n0 Menu");

    // Running it again changes nothing.
    expect(await seedDemo(T.app)).toEqual({ seeded: false, funded: false });
    expect(await db.query("SELECT 1 FROM users")).toHaveLength(6);

    // The state page, searched for everything it must not hold.
    const r = await http.inject({ method: "GET", url: "/sim/state" });
    const state = r.json() as { entries: Array<{ kind: string; lines: Array<{ account: string; sats: number }> }>; totals: { ledgerSat: number; ecashSat: number; match: boolean }; mint: { name: string; keyset: string } };
    const total = Object.values(expected).reduce((a, b) => a + b, 0) * 2.5;
    expect(state.totals).toEqual({ ledgerSat: total, ecashSat: total, match: true });
    expect(state.mint.name).toBe(mint.name);
    expect(state.mint.keyset).toBe(mint.keysetId);
    expect(state.entries).toHaveLength(20);
    expect(state.entries[0]!.kind).toBe("vault.transfer");
    expect(state.entries[0]!.lines.map((l) => l.account)).toEqual(["Ibrahima:locked", "Aminata:spendable"]);
    for (const p of SHOPPERS) {
      const id = await idOf(p.phone);
      expect(r.body, p.name).not.toContain(id);
      expect(r.body, p.name).not.toContain(p.phone.slice(4));
      for (const proof of await T.app.vault.liveProofs(`user:${id}`)) {
        expect(r.body).not.toContain(proof.secret);
        expect(r.body).not.toContain(proof.C);
      }
    }
    for (const fragment of ["+221", "recv:", "mint:", "seed:", "lnbcrt", "cashu"]) expect(r.body, fragment).not.toContain(fragment);
  }, 240_000);
});

describe("the seeded agents", () => {
  it("are opened, funded, enrolled and bonded once, on a database seeded before agents existed too", async () => {
    expect(await seedDemo(T.app)).toMatchObject({ seeded: true });
    expect(await seedAgents(T.app)).toEqual({ agents: 2 });
    const people = (await http.inject({ method: "GET", url: "/sim/people" })).json() as { people: Array<{ name: string; agent: boolean }> };
    expect(people.people.map((p) => [p.name, p.agent])).toEqual(DEMO_PEOPLE.map((p) => [p.name, p.agent !== undefined]));
    for (const p of DEMO_PEOPLE.filter((x) => x.agent)) {
      const id = await idOf(p.phone);
      expect(await T.app.agents.bondSats(id), p.name).toBe(p.agent!.bondFcfa * 2.5);
      expect(await sats(p.phone), p.name).toBe((p.fcfa - p.agent!.bondFcfa) * 2.5);
    }
    // again: nothing new
    expect(await seedAgents(T.app)).toEqual({ agents: 2 });
    expect(await db.query("SELECT 1 FROM users")).toHaveLength(8);
    expect(await db.query("SELECT 1 FROM ops WHERE kind = 'transfer' AND owner LIKE 'user:%' AND data->'meta'->>'t' = 'bond_in'")).toHaveLength(2);
    // a cash-in offer from each, best first
    const awa = (await T.app.users.findByPhone(DEMO_PEOPLE[0]!.phone))!;
    expect((await T.app.escrow.offers("cashin", awa, 2000)).map((o) => [o.name, o.sats])).toEqual([["Ndeye", 4950], ["Ousmane", 4925]]);
    await expectConsistent();
  }, 240_000);
});

describe("what the logs hold", () => {
  it("after every test above: no phone number, secret code, name, invoice or token", () => {
    const log = logWords(allLogs);
    for (const event of ["wallet.deposit.done", "wallet.deposit.pending", "demo.seed.done"]) expect(log.text, event).toContain(`"event":"${event}"`);
    for (const fragment of ["771234567", "781112233", "+221", "lnbcrt", "cashuA", "cashuB", ...DEMO_PEOPLE.map((p) => p.phone.slice(4))]) expect(log.text, fragment).not.toContain(fragment);
    for (const word of [AWA_PIN, MOUSSA_PIN, DEMO_PIN, ...DEMO_PEOPLE.map((p) => p.name)]) expect(log.words.has(word), word).toBe(false);
  });
});
