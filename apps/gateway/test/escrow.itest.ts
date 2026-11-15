// Cash-in and cash-out through an agent, end to end: real hold invoices on the gateway's LND node, the
// agent's wallet is the regtest "world" node, real ecash from the real Nutshell mint. Postgres in-process.
// Faults are injected at the network edge only: fetch to the mint (fault), and wrappers around the two
// Lightning nodes that drop one kind of call (flaky). Neither the mint nor Lightning is mocked.
// Needs: docker compose up, bash scripts/dev-creds.sh.
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppError, HOUR, MINUTE, systemClock } from "@melax/core";
import { MintClient } from "@melax/cashu";
import { deriveKey, open } from "@melax/crypto";
import { type Db, balance, post, truncateAll, verifyLedger } from "@melax/ledger";
import { type LightningBackend, LndBackend } from "@melax/lightning";
import { FLOAT_NODE } from "@melax/vault";
import { type TestApp, dial, inbox, logWords, newDb, signUp, testApp } from "./helpers.ts";

const keys = resolve(import.meta.dirname, "../../../.keys");
const lnd = (name: string, port: number) =>
  LndBackend.fromFiles({ baseUrl: `https://localhost:${port}`, macaroonPath: `${keys}/lnd-${name}/admin.macaroon`, tlsCertPath: `${keys}/lnd-${name}/tls.cert` });
const MINT = process.env.MINT_URL ?? "http://localhost:3338";

const AWA = "+221771234567";
const NDEYE = "+221770000107";
const AWA_PIN = "48291";
const NDEYE_PIN = "61937";
const NDEYE_MOMO = "+221776665544";

let db: Db;
let mint: MintClient;
let gw: LndBackend;
let world: LndBackend;
let T: TestApp;
let pepper: string;
const allLogs: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/**
 * A Lightning node with some calls cut: each name in `cut` makes that call fail as if the connection
 * dropped. The calls still reach nothing; everything else goes to the real node. `then` stays undefined
 * so the wrapper can be returned from an async function.
 */
function flaky(node: LightningBackend, cut: Set<string>): LightningBackend {
  return new Proxy(node, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && cut.has(prop)) return async () => Promise.reject(new AppError("UPSTREAM", `injected: ${prop} cut`));
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** The agent's wallet, with switches: `silent` takes the payment request and never pays; `refuseNext` makes the next invoice one whose payment the wallet then refuses. */
const agentSwitch = { silent: false, refuseNext: false };
function agentWallet(node: LndBackend): LightningBackend {
  return new Proxy(node, {
    get(target, prop, receiver) {
      if (prop === "pay" && agentSwitch.silent) return async () => ({ status: "pending" as const });
      if (prop === "makeInvoice" && agentSwitch.refuseNext) {
        // A hold invoice the wallet cancels as soon as the payment arrives: a real Lightning failure for the payer.
        return async (req: { amountSat: number; memo?: string; expirySec?: number }) => {
          agentSwitch.refuseNext = false;
          const hash = createHash("sha256").update(randomBytes(32)).digest("hex");
          const inv = await target.makeHoldInvoice({ amountSat: req.amountSat, paymentHash: hash, memo: req.memo, expirySec: req.expirySec });
          void (async () => {
            for (let i = 0; i < 100; i++) {
              const s = await target.lookupInvoice(hash).catch(() => null);
              if (s?.state === "accepted") return void (await target.cancel(hash));
              await sleep(300);
            }
          })();
          return inv;
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

const idOf = async (phone: string) => (await T.app.users.findByPhone(phone))!.id;
const userOf = async (phone: string) => (await T.app.users.findByPhone(phone))!;
const sats = async (phone: string) => balance(db, `user:${await idOf(phone)}:spendable`);
const kinds = async (phone: string) => (await T.app.outbox.list(phone)).map((m) => m.kind);
const stateOf = async (id: string) => (await db.query<{ state: string }>("SELECT state FROM trades WHERE id = $1", [id]))[0]!.state;

/**
 * What the world node holds on the channels it had when `ids` was taken, read until two reads agree
 * (a balance can be read mid-update, rule 16). Only those channels: the regtest helper opens a new
 * channel from the world node whenever it runs low, and that new channel's sats are not part of any
 * payment here. (Defect 41 in docs/BUILD_LOG.md.) A refund or a pay-out to the world node travels
 * over the old channels: a channel the world node just opened has nothing on the far side to send back.
 */
type Snapshot = { ids: Set<string>; sat: number };
async function worldChannels(ids?: Set<string>): Promise<Snapshot> {
  let prev = -1;
  for (let i = 0; i < 40; i++) {
    const chans = (await world.request<{ channels?: Array<{ chan_id: string; local_balance: string }> }>("GET", "/v1/channels")).channels ?? [];
    const keep = ids ?? new Set(chans.map((c) => c.chan_id));
    const now = chans.filter((c) => keep.has(c.chan_id)).reduce((s, c) => s + Number(c.local_balance), 0);
    if (now === prev) return { ids: keep, sat: now };
    prev = now;
    await sleep(600);
  }
  throw new Error("balance never settled");
}
/** The world node now, on the channels of a snapshot. */
const worldNow = async (since: Snapshot): Promise<number> => (await worldChannels(since.ids)).sat;

async function fund(phone: string, amountSat: number): Promise<void> {
  const inv = await gw.makeInvoice({ amountSat, memo: "test deposit" });
  expect((await world.pay({ bolt11: inv.bolt11, maxFeeSat: 20 })).status).toBe("succeeded");
  await post(db, systemClock, { kind: "ln.received", idemKey: `recv:${inv.paymentHash}`, postings: [{ account: "ext:lightning", delta: -amountSat }, { account: FLOAT_NODE, delta: amountSat }] });
  expect((await T.app.vault.mintFor({ idemKey: `mint:${inv.paymentHash}`, owner: `user:${await idOf(phone)}`, amountSat })).status).toBe("done");
}

async function expectConsistent(): Promise<void> {
  const a = await T.app.vault.auditAll();
  expect(a.mismatches).toEqual([]);
  expect(a.ledgerSat).toBe(a.proofsSat);
  expect((await verifyLedger(db)).problems).toEqual([]);
  // No closed trade keeps anything in escrow.
  for (const t of await db.query<{ id: string }>("SELECT id FROM trades WHERE kind = 'cashout' AND state IN ('done', 'refunded', 'failed')")) {
    expect(await T.app.escrow.escrowBalance(t.id), t.id).toBe(0);
  }
}

/** A fresh app on the same database (a restart), keeping the clock. `ln` replaces the gateway's node. */
function start(opts: { ln?: LightningBackend } = {}): TestApp {
  const t = testApp(db, { mint, ln: opts.ln ?? gw, world: agentWallet(world), clock: T?.clock, env: { MELAX_PEPPER: pepper, STEP_BUDGET_MS: "60000", ESCROW_CLTV_BLOCKS: "432", ESCROW_BLOCK_SECONDS: "30" } });
  const push = t.logs.push.bind(t.logs);
  t.logs.push = (...lines: string[]) => {
    allLogs.push(...lines);
    return push(...lines);
  };
  return t;
}

/** Awa with an account, Ndeye an agent on Wave with a 100 000 sat bond. Awa holds `awaSats`. */
async function people(awaSats = 0): Promise<void> {
  await signUp(T.app, AWA, AWA_PIN, "Awa");
  await signUp(T.app, NDEYE, NDEYE_PIN, "Ndeye");
  const ndeye = await userOf(NDEYE);
  await T.app.agents.enroll({ userId: ndeye.id, momo: NDEYE_MOMO, method: "wave", premiumBp: 100, minFcfa: 500, maxFcfa: 50_000, wallet: { kind: "world" } });
  await fund(NDEYE, 110_000);
  expect(await T.app.escrow.bondAdd({ agent: ndeye, fcfa: 40_000, pin: NDEYE_PIN, idemKey: "bond:setup" })).toEqual({ ok: true, sats: 100_000 });
  if (awaSats > 0) await fund(AWA, awaSats);
}

/** Cash-in of `fcfa` started from Awa's phone. Returns the trade id. */
async function cashinByPhone(fcfa: number): Promise<{ id: string; last: string }> {
  const s = dial(T.app, AWA);
  await s.open();
  await s.run("5", String(fcfa), "1");
  const last = await s.type("1");
  const id = (await db.query<{ id: string }>("SELECT id FROM trades ORDER BY created_at DESC LIMIT 1"))[0]!.id;
  return { id, last };
}

async function cashoutByPhone(fcfa: number): Promise<{ id: string; last: string }> {
  const s = dial(T.app, AWA);
  await s.open();
  await s.run("6", String(fcfa), "1", "1");
  const last = await s.type(AWA_PIN);
  const id = (await db.query<{ id: string }>("SELECT id FROM trades ORDER BY created_at DESC LIMIT 1"))[0]!.id;
  return { id, last };
}

async function desk(...keysTyped: string[]): Promise<string> {
  const s = dial(T.app, NDEYE);
  await s.open();
  return s.run("0", "4", ...keysTyped);
}

async function heldOnNode(id: string): Promise<string | undefined> {
  const hash = (await db.query<{ payment_hash: string }>("SELECT payment_hash FROM trades WHERE id = $1", [id]))[0]!.payment_hash;
  return (await gw.lookupInvoice(hash))?.state;
}

beforeAll(async () => {
  db = await newDb();
  mint = await MintClient.connect(MINT);
  gw = lnd("gw", 18081);
  world = lnd("world", 18082);
});
beforeEach(async () => {
  heal();
  agentSwitch.silent = false;
  agentSwitch.refuseNext = false;
  await truncateAll(db);
  pepper = randomBytes(32).toString("hex");
  T = undefined as unknown as TestApp;
  T = start();
});
/** Every preimage of every cash-in of this file, read before the next test empties the database. */
const preimages: string[] = [];
afterEach(async () => {
  const dataKey = deriveKey(Buffer.from(pepper, "hex"), "data");
  for (const r of await db.query<{ id: string; preimage_sealed: Buffer }>("SELECT id, preimage_sealed FROM trades WHERE preimage_sealed IS NOT NULL")) {
    preimages.push(open(dataKey, Buffer.from(r.preimage_sealed), `trade:preimage:${r.id}`).toString("hex"));
  }
});
afterAll(async () => {
  heal();
  await gw?.close();
  await world?.close();
  await db?.close();
});

describe("cash-in", () => {
  it("while held the agent's sats are locked and nobody's books move; after the agent confirms, the user holds the ecash", async () => {
    await people();
    const w0 = await worldChannels();
    const worldBefore = w0.sat;
    const { id, last } = await cashinByPhone(2000);
    // 2 000 F at 40 000 000 F a bitcoin is 5 000 sats; Ndeye's 1 % premium leaves 4 950
    expect(last).toBe("Envoyez 2 000 F par Wave au 77 666 55 44 (Ndeye).\nRef " + (await T.app.escrow.get(id))!.ref + ". Details par SMS.");
    expect(await stateOf(id)).toBe("held");
    expect(await heldOnNode(id)).toBe("accepted");
    expect(worldBefore - (await worldNow(w0))).toBeGreaterThanOrEqual(4950);
    expect(await balance(db, FLOAT_NODE)).toBe(0);
    expect(await sats(AWA)).toBe(0);
    expect(await kinds(AWA)).toEqual(["welcome", "dep_user"]);
    expect((await inbox(T.app, AWA)).at(-1)).toContain("au 77 666 55 44 (Ndeye). Vous recevrez 4 950 sats. Annule apres 45 min.");
    expect(await kinds(NDEYE)).toEqual(["welcome", "dep_agent"]);
    expect((await inbox(T.app, NDEYE)).at(-1)).toContain("77*****67 va vous envoyer 2 000 F par Wave");

    expect(await desk("1")).toContain("avez-vous recu 2 000 F de 77*****67 par Wave?");
    expect(await desk("1", "1", NDEYE_PIN)).toMatch(/^Depot D[0-9A-F]{5} confirme\. 4 950 sats livres au client\.$/);
    expect(await stateOf(id)).toBe("done");
    expect(await sats(AWA)).toBe(4950);
    expect(await heldOnNode(id)).toBe("settled");
    expect(worldBefore - (await worldNow(w0))).toBeGreaterThanOrEqual(4950);
    expect(await db.query("SELECT user_id = $1 AS awa, kind, amount_fcfa, spend FROM txlog WHERE kind LIKE 'cashin%' ORDER BY id", [await idOf(AWA)])).toEqual([
      { awa: true, kind: "cashin", amount_fcfa: 2000, spend: false },
      { awa: false, kind: "cashin_agent", amount_fcfa: -2000, spend: false },
    ]);
    expect((await kinds(AWA)).at(-1)).toBe("cashin");
    expect((await inbox(T.app, AWA)).at(-1)).toMatch(/^Melax: depot D[0-9A-F]{5} recu, \+2 000 F\. Solde: 1 980 F\.$/);
    expect((await kinds(NDEYE)).at(-1)).toBe("dep_agent_done");
    await expectConsistent();
    expect(await T.app.vault.verifyHoldingsWithMint()).toMatchObject({ notUnspent: 0 });
  });

  it("nobody confirms for 45 minutes: every sat goes back to the agent's wallet, and both are told", async () => {
    await people();
    const w0 = await worldChannels();
    const worldBefore = w0.sat;
    const { id } = await cashinByPhone(2000);
    expect(await stateOf(id)).toBe("held");
    T.clock.advance(44 * MINUTE);
    await T.app.escrow.sweep();
    expect(await stateOf(id)).toBe("held");
    T.clock.advance(2 * MINUTE);
    await T.app.escrow.sweep();
    expect(await stateOf(id)).toBe("expired");
    expect(await heldOnNode(id)).toBe("cancelled");
    expect(await worldNow(w0)).toBe(worldBefore);
    expect(await sats(AWA)).toBe(0);
    expect((await kinds(AWA)).at(-1)).toBe("dep_cancel");
    expect((await kinds(NDEYE)).at(-1)).toBe("dep_cancel");
    // a confirmation after the end changes nothing
    expect(await T.app.escrow.agentConfirm({ agent: await userOf(NDEYE), tradeId: id, pin: NDEYE_PIN })).toMatchObject({ ok: false, err: "STATE" });
    await expectConsistent();
  });

  it("confirm and time-out at the same moment, from two processes, many times: exactly one wins and the books agree", async () => {
    await people();
    const ndeye = await userOf(NDEYE);
    const other = start(); // a second process on the same database
    const outcomes: string[] = [];
    for (let round = 0; round < 6; round++) {
      const { id } = await cashinByPhone(1000);
      expect(await stateOf(id)).toBe("held");
      T.clock.advance(45 * MINUTE);
      const [confirmed] = await Promise.all([T.app.escrow.agentConfirm({ agent: ndeye, tradeId: id, pin: NDEYE_PIN }), other.app.escrow.sweep()]);
      await other.app.escrow.sweep();
      const state = await stateOf(id);
      expect(["done", "expired"]).toContain(state);
      expect(confirmed.ok).toBe(state === "done");
      expect(await heldOnNode(id)).toBe(state === "done" ? "settled" : "cancelled");
      outcomes.push(state);
    }
    const credited = outcomes.filter((s) => s === "done").length;
    expect(await sats(AWA)).toBe(credited * 2475);
    expect(await db.query("SELECT 1 FROM txlog WHERE kind = 'cashin'")).toHaveLength(credited);
    await expectConsistent();
  }, 240_000);

  it("the process dies after the confirmation is stored and before the node settled: a restart settles and credits once", async () => {
    await people();
    const { id } = await cashinByPhone(2000);
    // The gateway's node stops answering settle: as if the process died on its way there.
    T = start({ ln: flaky(gw, new Set(["settle"])) });
    const r = await T.app.escrow.agentConfirm({ agent: await userOf(NDEYE), tradeId: id, pin: NDEYE_PIN });
    expect(r).toMatchObject({ ok: true, trade: { state: "settling" } });
    expect(await heldOnNode(id)).toBe("accepted");
    expect(await sats(AWA)).toBe(0);

    T = start(); // the restart
    T.clock.advance(MINUTE);
    await T.app.escrow.sweep();
    await T.app.escrow.sweep();
    expect(await stateOf(id)).toBe("done");
    expect(await heldOnNode(id)).toBe("settled");
    expect(await sats(AWA)).toBe(4950);
    expect(await db.query("SELECT 1 FROM ops WHERE kind = 'mint' AND owner = $1", [`user:${await idOf(AWA)}`])).toHaveLength(1);
    expect((await kinds(AWA)).filter((k) => k === "cashin")).toHaveLength(1);
    await expectConsistent();
  });

  it("the mint's reply is lost while crediting: recovery credits once", async () => {
    await people();
    const { id } = await cashinByPhone(2000);
    fault("/v1/mint/bolt11", "lost-reply");
    await T.app.escrow.agentConfirm({ agent: await userOf(NDEYE), tradeId: id, pin: NDEYE_PIN });
    expect(await stateOf(id)).toBe("settling");
    expect(await sats(AWA)).toBe(0);
    heal();
    T = start();
    expect(await T.app.vault.recover()).toMatchObject({ done: 1 });
    await T.app.escrow.sweep();
    expect(await stateOf(id)).toBe("done");
    expect(await sats(AWA)).toBe(4950);
    expect((await kinds(AWA)).filter((k) => k === "cashin")).toHaveLength(1);
    await expectConsistent();
  }, 300_000);

  it("rule 15: a payment held on a closed trade is cancelled on sight, and a late payment to a cancelled invoice fails", async () => {
    await people();
    const w0 = await worldChannels();
    const worldBefore = w0.sat;
    // The time-out happens while the gateway's node does not answer cancel: the agent's sats stay held.
    T = start({ ln: flaky(gw, new Set(["cancel"])) });
    const { id } = await cashinByPhone(2000);
    T.clock.advance(46 * MINUTE);
    await T.app.escrow.sweep();
    expect(await stateOf(id)).toBe("expired");
    expect(await heldOnNode(id)).toBe("accepted");
    // The next sweep, with the node answering again, sees a held payment on a closed trade and cancels it.
    T = start();
    await T.app.escrow.sweep();
    expect(await heldOnNode(id)).toBe("cancelled");
    expect(await worldNow(w0)).toBe(worldBefore);

    // An agent who pays too late: the trade ended before the payment came.
    agentSwitch.silent = true;
    const late = await T.app.escrow.startCashin({ user: await userOf(AWA), agentId: await idOf(NDEYE), fcfa: 1000, sats: 2475, idemKey: "late", waitMs: 600 });
    expect(late).toMatchObject({ ok: true, trade: { state: "open" } });
    const lateId = late.ok ? late.trade.id : "";
    T.clock.advance(11 * MINUTE);
    await T.app.escrow.sweep();
    expect(await stateOf(lateId)).toBe("expired");
    const bolt11 = (await db.query<{ bolt11: string }>("SELECT bolt11 FROM trades WHERE id = $1", [lateId]))[0]!.bolt11;
    expect((await world.pay({ bolt11, maxFeeSat: 20, timeoutSec: 20 })).status).not.toBe("succeeded");
    expect(await heldOnNode(lateId)).toBe("cancelled");
    expect(await worldNow(w0)).toBe(worldBefore);
    expect(await sats(AWA)).toBe(0);
    await expectConsistent();
  });

  it("the agent's open cash-ins cannot pass the bond", async () => {
    await people();
    // Bond: 100 000 sats. 40 000 F is 99 000 sats with the premium; a second cash-in of any size does not fit.
    const ndeye = await idOf(NDEYE);
    const first = await T.app.escrow.startCashin({ user: await userOf(AWA), agentId: ndeye, fcfa: 40_000, sats: 99_000, idemKey: "big" });
    expect(first).toMatchObject({ ok: true, trade: { state: "held" } });
    await signUp(T.app, "+221761239876", "26804", "Fatou");
    const fatou = await userOf("+221761239876");
    expect(await T.app.escrow.offers("cashin", fatou, 1000)).toEqual([]);
    expect(await T.app.escrow.startCashin({ user: fatou, agentId: ndeye, fcfa: 1000, sats: 2475, idemKey: "second" })).toMatchObject({ ok: false, err: "BOND" });
    await T.app.escrow.cancel({ user: await userOf(AWA), tradeId: first.ok ? first.trade.id : "" });
    expect(await T.app.escrow.offers("cashin", fatou, 1000)).toHaveLength(1);
    await expectConsistent();
  });
});

describe("cash-out", () => {
  it("sats leave the user for escrow, the agent marks sent, the user confirms, the agent's wallet is paid; the fee comes out of the allowance and the rest comes back", async () => {
    await people(20_000);
    const w0 = await worldChannels();
    const worldBefore = w0.sat;
    const { id, last } = await cashoutByPhone(2000);
    const ref = (await T.app.escrow.get(id))!.ref;
    expect(last).toBe(`Retrait ${ref} lance. Ndeye vous envoie 2 000 F par Wave.\nConfirmez la reception au menu 6.`);
    // 5 050 sats plus a fee allowance of 26
    expect(await stateOf(id)).toBe("locked");
    expect(await T.app.escrow.escrowBalance(id)).toBe(5076);
    expect(await sats(AWA)).toBe(20_000 - 5076);
    expect((await inbox(T.app, NDEYE)).at(-1)).toBe(`Melax ${ref}: envoyez 2 000 F par Wave au 77 123 45 67 (Awa). Puis marquez-le envoye: #2580#, Espace agent.`);
    expect((await T.app.wallet.limitsView(await userOf(AWA))).dayLeftFcfa).toBe(48_000);

    expect(await desk("2", "1", NDEYE_PIN)).toBe("Note. Le client doit confirmer la reception.");
    expect(await stateOf(id)).toBe("sent");
    expect((await kinds(AWA)).at(-1)).toBe("wd_user_sent");

    const s = dial(T.app, AWA);
    await s.open();
    expect(await s.type("6")).toBe(`Retrait ${ref}: avez-vous recu 2 000 F de Ndeye?\n1 Oui, recu\n2 Pas encore\n3 Litige`);
    await s.type("1");
    expect(await s.type(AWA_PIN)).toBe(`Merci. Retrait ${ref} termine.`);
    expect(await stateOf(id)).toBe("done");
    expect((await worldNow(w0)) - worldBefore).toBe(5050);
    expect(await T.app.escrow.escrowBalance(id)).toBe(0);
    const fee = 20_000 - 5050 - (await sats(AWA));
    expect(fee).toBeGreaterThanOrEqual(0);
    expect(fee).toBeLessThanOrEqual(26);
    expect((await kinds(AWA)).at(-1)).toBe("cashout");
    expect((await kinds(NDEYE)).at(-1)).toBe("wd_done_agent");
    expect(await db.query("SELECT kind, amount_fcfa, spend FROM txlog WHERE kind LIKE 'cashout%' ORDER BY id")).toEqual([
      { kind: "cashout", amount_fcfa: -2000, spend: true },
      { kind: "cashout_agent", amount_fcfa: 2000, spend: false },
    ]);
    await expectConsistent();
    expect(await T.app.vault.verifyHoldingsWithMint()).toMatchObject({ notUnspent: 0 });
  });

  it("refunded after 45 minutes with no 'sent': the user has every sat back and the day's limit room too", async () => {
    await people(20_000);
    const { id } = await cashoutByPhone(2000);
    T.clock.advance(46 * MINUTE);
    await T.app.escrow.sweep();
    expect(await stateOf(id)).toBe("refunded");
    expect(await sats(AWA)).toBe(20_000);
    expect(await T.app.escrow.escrowBalance(id)).toBe(0);
    expect((await T.app.wallet.limitsView(await userOf(AWA))).dayLeftFcfa).toBe(50_000);
    expect((await kinds(AWA)).at(-1)).toBe("wd_cancel");
    expect((await kinds(NDEYE)).at(-1)).toBe("wd_cancel");
    await expectConsistent();
  });

  it("the agent declines: refunded at once", async () => {
    await people(20_000);
    const { id } = await cashoutByPhone(2000);
    expect(await desk("2", "2", NDEYE_PIN)).toMatch(/^Retrait R[0-9A-F]{5} annule\.$/);
    expect(await stateOf(id)).toBe("refunded");
    expect(await sats(AWA)).toBe(20_000);
    await expectConsistent();
  });

  it("the pay-out fails: nothing is lost, and the trade is paid later with a fresh invoice", async () => {
    await people(20_000);
    const w0 = await worldChannels();
    const worldBefore = w0.sat;
    const { id } = await cashoutByPhone(2000);
    agentSwitch.refuseNext = true;
    const r = await T.app.escrow.userConfirm({ user: await userOf(AWA), tradeId: id, pin: AWA_PIN });
    expect(r).toMatchObject({ ok: true, trade: { state: "paying" } });
    expect(await db.query("SELECT status FROM ops WHERE idem_key = $1", [`cashout:${id}:pay:0`])).toEqual([{ status: "failed" }]);
    expect(await T.app.escrow.escrowBalance(id)).toBe(5076);
    expect(await worldNow(w0)).toBe(worldBefore);
    await expectConsistent();

    T.clock.advance(MINUTE);
    await T.app.escrow.sweep(); // counts the failed attempt
    await T.app.escrow.sweep(); // pays under cashout:<id>:pay:1
    await T.app.escrow.sweep(); // the change
    expect(await stateOf(id)).toBe("done");
    expect(await db.query("SELECT status FROM ops WHERE idem_key = $1", [`cashout:${id}:pay:1`])).toEqual([{ status: "done" }]);
    expect((await worldNow(w0)) - worldBefore).toBe(5050);
    expect(await T.app.escrow.escrowBalance(id)).toBe(0);
    await expectConsistent();
  });
});

describe("disputes", () => {
  it("cash-out: the agent says sent, the user says nothing, it becomes a dispute; decided for the user, the sats go back", async () => {
    await people(20_000);
    const { id } = await cashoutByPhone(2000);
    await desk("2", "1", NDEYE_PIN);
    T.clock.advance(46 * MINUTE);
    await T.app.escrow.sweep();
    expect(await stateOf(id)).toBe("disputed");
    expect((await kinds(AWA)).at(-1)).toBe("dispute");
    expect((await kinds(NDEYE)).at(-1)).toBe("dispute");
    T.clock.advance(24 * HOUR);
    await T.app.escrow.sweep();
    expect(await stateOf(id)).toBe("disputed"); // nothing moves until someone decides

    expect(await T.app.escrow.decide({ tradeId: id, winner: "user", arbiter: "op1", note: "no Wave transfer found" })).toMatchObject({ ok: true, trade: { state: "refunded" } });
    expect(await sats(AWA)).toBe(20_000);
    expect(await T.app.escrow.decide({ tradeId: id, winner: "agent", arbiter: "op1" })).toMatchObject({ ok: false, err: "STATE" });
    expect(await db.query("SELECT actor, action, subject = $1 AS same, data->>'winner' AS winner FROM audit_log", [id])).toEqual([{ actor: "op1", action: "escrow.decide", same: true, winner: "user" }]);
    await expectConsistent();
  });

  it("cash-out: the user disputes; decided for the agent, the agent is paid", async () => {
    await people(20_000);
    const w0 = await worldChannels();
    const worldBefore = w0.sat;
    const { id } = await cashoutByPhone(2000);
    await desk("2", "1", NDEYE_PIN);
    const s = dial(T.app, AWA);
    await s.open();
    await s.type("6");
    expect(await s.type("3")).toMatch(/^Litige ouvert pour R[0-9A-F]{5}\./);
    expect(await T.app.escrow.decide({ tradeId: id, winner: "agent", arbiter: "op1" })).toMatchObject({ ok: true, trade: { state: "done" } });
    expect((await worldNow(w0)) - worldBefore).toBe(5050);
    expect((await kinds(NDEYE)).filter((k) => k === "dispute_result")).toHaveLength(1);
    await expectConsistent();
  });

  it("cash-in: decided for the user while the payment is still held, it settles", async () => {
    await people();
    const { id } = await cashinByPhone(2000);
    const s = dial(T.app, AWA);
    await s.open();
    await s.type("5");
    expect(await s.type("1")).toMatch(/^Litige ouvert pour D[0-9A-F]{5}\./);
    T.clock.advance(50 * MINUTE);
    await T.app.escrow.sweep();
    expect(await stateOf(id)).toBe("disputed"); // past the window, but a dispute waits for the hard cap
    expect(await heldOnNode(id)).toBe("accepted");
    expect(await T.app.escrow.decide({ tradeId: id, winner: "user", arbiter: "op1" })).toMatchObject({ ok: true, trade: { state: "done" } });
    expect(await heldOnNode(id)).toBe("settled");
    expect(await sats(AWA)).toBe(4950);
    expect(await T.app.agents.bondSats(await idOf(NDEYE))).toBe(100_000);
    await expectConsistent();
  });

  it("cash-in: the hard cap comes first; the agent gets the sats back, and a decision for the user is paid from the bond", async () => {
    await people();
    const w0 = await worldChannels();
    const worldBefore = w0.sat;
    const { id } = await cashinByPhone(2000);
    await T.app.escrow.dispute({ user: await userOf(AWA), tradeId: id });
    T.clock.advance(3 * HOUR + MINUTE);
    await T.app.escrow.sweep();
    expect(await stateOf(id)).toBe("released");
    expect(await heldOnNode(id)).toBe("cancelled");
    expect(await worldNow(w0)).toBe(worldBefore);
    // the released trade still leans on the bond until it is decided
    expect(await T.app.agents.bondedSats(await idOf(NDEYE))).toBe(4950);
    expect(await T.app.escrow.decide({ tradeId: id, winner: "user", arbiter: "op1" })).toMatchObject({ ok: true, trade: { state: "done" } });
    expect(await sats(AWA)).toBe(4950);
    expect(await T.app.agents.bondSats(await idOf(NDEYE))).toBe(100_000 - 4950);
    expect(await T.app.agents.bondedSats(await idOf(NDEYE))).toBe(0);
    expect(await db.query("SELECT kind FROM txlog WHERE kind IN ('cashin', 'slash') ORDER BY id")).toEqual([{ kind: "cashin" }, { kind: "slash" }]);
    await expectConsistent();
  });

  it("cash-in: decided for the agent while held, the payment goes back", async () => {
    await people();
    const w0 = await worldChannels();
    const worldBefore = w0.sat;
    const { id } = await cashinByPhone(2000);
    await T.app.escrow.dispute({ user: await userOf(AWA), tradeId: id });
    expect(await T.app.escrow.decide({ tradeId: id, winner: "agent", arbiter: "op1" })).toMatchObject({ ok: true, trade: { state: "rejected" } });
    expect(await heldOnNode(id)).toBe("cancelled");
    expect(await worldNow(w0)).toBe(worldBefore);
    expect(await sats(AWA)).toBe(0);
    await expectConsistent();
  });
});

describe("bonds", () => {
  it("cannot be withdrawn while a trade is open; can once it is closed, and the offer pauses", async () => {
    await people();
    const ndeye = await userOf(NDEYE);
    const { id } = await cashinByPhone(2000);
    expect(await desk("3", "2", NDEYE_PIN)).toBe("Impossible: un depot, un retrait ou un litige est ouvert.");
    expect(await T.app.agents.bondSats(ndeye.id)).toBe(100_000);
    await T.app.escrow.agentConfirm({ agent: ndeye, tradeId: id, pin: NDEYE_PIN });
    const before = await sats(NDEYE);
    expect(await desk("3", "2", NDEYE_PIN)).toBe("Caution retiree: 100 000 sats. Votre offre est en pause.");
    expect(await T.app.agents.bondSats(ndeye.id)).toBe(0);
    expect(await sats(NDEYE)).toBe(before + 100_000);
    expect((await T.app.agents.get(ndeye.id))!.active).toBe(false);
    expect(await T.app.escrow.offers("cashin", await userOf(AWA), 1000)).toEqual([]);
    await expectConsistent();
  });
});

describe("many trades at random", () => {
  it("starts, confirmations, declines, disputes and clock jumps in any order end with the books right and no closed escrow above zero", async () => {
    await people(60_000);
    const ndeye = await userOf(NDEYE);
    const others: string[] = [];
    for (let i = 0; i < 3; i++) {
      const phone = `+22176000020${i}`;
      await signUp(T.app, phone, "26804", `Client${String.fromCharCode(65 + i)}`);
      await fund(phone, 15_000);
      others.push(phone);
    }
    const phones = [AWA, ...others];
    const pinOf = (p: string) => (p === AWA ? AWA_PIN : "26804");
    let seed = Number(process.env.ESCROW_SEED ?? Date.now() % 100_000);
    const rnd = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const steps = Number(process.env.ESCROW_STEPS ?? 30);
    for (let i = 0; i < steps; i++) {
      const phone = phones[rnd(phones.length)]!;
      const u = await userOf(phone);
      const open = await T.app.escrow.openTradeOf(u);
      const pick = rnd(8);
      if (!open) {
        if (pick < 4) {
          const fcfa = 500 + rnd(4) * 500;
          await T.app.escrow.startCashin({ user: u, agentId: ndeye.id, fcfa, sats: Math.floor(fcfa * 2.5 * 0.99), idemKey: `r${i}` });
        } else {
          const fcfa = 500 + rnd(4) * 500;
          await T.app.escrow.startCashout({ user: u, agentId: ndeye.id, fcfa, sats: Math.ceil(fcfa * 2.5 * 1.01), pin: pinOf(phone), idemKey: `r${i}` });
        }
      } else if (open.kind === "cashin") {
        if (pick < 3) await T.app.escrow.agentConfirm({ agent: ndeye, tradeId: open.id, pin: NDEYE_PIN });
        else if (pick < 4) await T.app.escrow.cancel({ user: u, tradeId: open.id });
        else if (pick < 5) await T.app.escrow.dispute({ user: u, tradeId: open.id });
        else if (pick < 6) await T.app.escrow.decide({ tradeId: open.id, winner: rnd(2) ? "user" : "agent", arbiter: "op1" });
        else T.clock.advance([10 * MINUTE, 46 * MINUTE, 3 * HOUR][rnd(3)]!);
      } else {
        if (pick < 2) await T.app.escrow.agentSent({ agent: ndeye, tradeId: open.id, pin: NDEYE_PIN });
        else if (pick < 4) await T.app.escrow.userConfirm({ user: u, tradeId: open.id, pin: pinOf(phone) });
        else if (pick < 5) await T.app.escrow.agentDecline({ agent: ndeye, tradeId: open.id, pin: NDEYE_PIN });
        else if (pick < 6) await T.app.escrow.dispute({ user: u, tradeId: open.id });
        else if (pick < 7) await T.app.escrow.decide({ tradeId: open.id, winner: rnd(2) ? "user" : "agent", arbiter: "op1" });
        else T.clock.advance([10 * MINUTE, 46 * MINUTE][rnd(2)]!);
      }
      await T.app.escrow.sweep();
    }
    // let everything that can finish, finish
    for (let i = 0; i < 4; i++) {
      T.clock.advance(4 * HOUR);
      await T.app.escrow.sweep();
    }
    for (const t of await db.query<{ id: string; state: string }>("SELECT id, state FROM trades WHERE state IN ('disputed', 'released')")) {
      await T.app.escrow.decide({ tradeId: t.id, winner: "user", arbiter: "op1" });
    }
    await T.app.escrow.sweep();
    const states = await db.query<{ state: string }>("SELECT state FROM trades");
    expect(states.length).toBeGreaterThan(3);
    for (const s of states) expect(["done", "expired", "rejected", "refunded", "failed"], JSON.stringify(states)).toContain(s.state);
    expect(await T.app.agents.bondedSats(ndeye.id)).toBe(0);
    await expectConsistent();
    expect(await T.app.vault.verifyHoldingsWithMint()).toMatchObject({ notUnspent: 0 });
  }, 600_000);
});

describe("privacy", () => {
  it("the logs of this whole file hold no number, code, name, invoice or preimage", async () => {
    const log = logWords(allLogs);
    expect(allLogs.length).toBeGreaterThan(100);
    for (const event of ["escrow.cashin.started", "escrow.cashout.started", "escrow.move", "escrow.decided"]) expect(log.text, event).toContain(`"event":"${event}"`);
    for (const fragment of ["771234567", "770000107", "776665544", "77 123 45 67", "77 666 55 44", "77 000 01 07", "+221", "lnbcrt", "cashuA", "cashuB"]) expect(log.text, fragment).not.toContain(fragment);
    for (const word of [AWA_PIN, NDEYE_PIN, "26804", "Awa", "Ndeye", "ClientA", "ClientB", "ClientC"]) expect(log.words.has(word), word).toBe(false);
    // the preimage of every cash-in of every test above
    expect(preimages.length).toBeGreaterThan(20);
    for (const p of preimages) expect(log.text).not.toContain(p);
  });
});
