// The escrow engine's refusals and its privacy, with no mint and no Lightning node: every refusal here
// must happen before anything reaches the network, so the mint, the gateway's node and the agents'
// wallets are stand-ins that fail the test when touched. The money paths run in escrow.itest.ts.
import { afterAll, describe, expect, it } from "vitest";
import { DAY, MINUTE } from "@melax/core";
import { type Db, post, truncateAll } from "@melax/ledger";
import type { LightningBackend } from "@melax/lightning";
import { buildHttp } from "../src/http.ts";
import { RATE, logWords, newDb, testApp, untouchable } from "./helpers.ts";

const AWA = "+221771234567";
const NDEYE = "+221770000107";
const OUSMANE = "+221780000108";
const PIN = "48291";
const AGENT_PIN = "61937";
const NDEYE_MOMO = "+221776665544";
const OPERATOR_SECRET = "op-" + "x".repeat(30);

/**
 * One database for the file, emptied before each test. On PGlite a new database per test would do, but
 * with TEST_DATABASE_URL every test shares one Postgres database (defect 53).
 */
let shared: Db | undefined;
afterAll(async () => {
  await shared?.close();
});

async function setup(env: Record<string, string> = {}) {
  shared ??= await newDb();
  await truncateAll(shared);
  const db = shared;
  const T = testApp(db, { world: untouchable<LightningBackend>("an agent's wallet"), env });
  const awa = await T.app.users.register({ phone: AWA, pin: PIN, name: "Awa", lang: "fr" });
  const ndeye = await T.app.users.register({ phone: NDEYE, pin: AGENT_PIN, name: "Ndeye", lang: "fr" });
  await T.app.agents.enroll({ userId: ndeye.id, momo: NDEYE_MOMO, method: "wave", premiumBp: 100, minFcfa: 500, maxFcfa: 50_000, wallet: { kind: "world" } });
  const refresh = async () => ({ awa: (await T.app.users.byId(awa.id))!, ndeye: (await T.app.users.byId(ndeye.id))! });
  return { T, db, ...(await refresh()) };
}

/** Books sats straight into an account's ledger. Unit tests only: there are no proofs behind them. */
async function credit(T: Awaited<ReturnType<typeof setup>>["T"], account: string, sats: number) {
  await post(T.db, T.clock, { kind: "test.credit", idemKey: `test:${account}:${sats}:${Math.random()}`, postings: [{ account: "ext:ecash", delta: -sats }, { account, delta: sats }] });
}

/** A trade row in a given state, for testing who may move it. */
async function tradeRow(T: Awaited<ReturnType<typeof setup>>["T"], a: { kind: "cashin" | "cashout"; state: string; userId: string; agentId: string; sats?: number }) {
  const id = `t_fixture_${Math.random().toString(36).slice(2)}`;
  const now = T.clock.now();
  await T.db.query(
    `INSERT INTO trades (id, ref, idem_key, kind, state, user_id, agent_id, fcfa, sats, lock_sats, rate, method, deadline_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1000, $8, $8, $9, 'wave', $10, $11, $11)`,
    [id, "X" + id.slice(-5).toUpperCase(), "fixture:" + id, a.kind, a.state, a.userId, a.agentId, a.sats ?? 2500, RATE, now + 45 * MINUTE, now],
  );
  return id;
}

describe("starting a trade is refused before any money or any network is touched", () => {
  it("cash-in: amount outside the agent's range, agent off, agent is the user, no agent fits", async () => {
    const { T, awa, ndeye } = await setup();
    await credit(T, `bond:${ndeye.id}:spendable`, 1_000_000);
    const start = (fcfa: number, user = awa) => T.app.escrow.startCashin({ user, agentId: ndeye.id, fcfa, sats: Math.floor((fcfa * 1e8) / RATE * 0.99), idemKey: `k:${Math.random()}` });
    expect(await start(400)).toMatchObject({ ok: false, err: "RANGE" });
    expect(await start(60_000)).toMatchObject({ ok: false, err: "RANGE" });
    expect(await start(1000, ndeye)).toMatchObject({ ok: false, err: "SELF" });
    await T.app.agents.setActive(ndeye.id, false);
    expect(await start(1000)).toMatchObject({ ok: false, err: "AGENT_OFF" });
    expect(await T.app.escrow.offers("cashin", awa, 1000)).toEqual([]);
    await T.app.agents.setActive(ndeye.id, true);
    expect(await T.app.escrow.offers("cashin", awa, 400)).toEqual([]);
    expect(await T.app.escrow.offers("cashin", ndeye, 1000)).toEqual([]);
    const offers = await T.app.escrow.offers("cashin", awa, 1000);
    expect(offers).toEqual([{ agentId: ndeye.id, name: "Ndeye", method: "wave", sats: 2475 }]);
    expect(await db_count(T, "trades")).toBe(0);
  });

  it("cash-in: refused when the agent's open cash-ins plus this one pass the bond", async () => {
    const { T, awa, ndeye } = await setup();
    await credit(T, `bond:${ndeye.id}:spendable`, 3000);
    const other = await T.app.users.register({ phone: "+221761239876", pin: "26804", name: "Fatou", lang: "fr" });
    await tradeRow(T, { kind: "cashin", state: "held", userId: other.id, agentId: ndeye.id, sats: 2000 });
    // 1000 F is 2 475 sats with the agent's 1 % premium: 2 000 + 2 475 > 3 000
    const r = await T.app.escrow.startCashin({ user: awa, agentId: ndeye.id, fcfa: 1000, sats: 2475, idemKey: "k1" });
    expect(r).toMatchObject({ ok: false, err: "BOND" });
    expect(await T.app.escrow.offers("cashin", awa, 1000)).toEqual([]);
    // 400 sats of headroom fit a smaller amount
    expect(await T.app.escrow.offers("cashin", awa, 500)).toHaveLength(0); // 1 237 sats, still too many
    await credit(T, `bond:${ndeye.id}:spendable`, 1475);
    expect(await T.app.escrow.offers("cashin", awa, 1000)).toHaveLength(1);
  });

  it("disputed and released cash-ins still count against the bond", async () => {
    const { T, awa, ndeye } = await setup();
    await credit(T, `bond:${ndeye.id}:spendable`, 5000);
    for (const [i, state] of ["disputed", "released", "settling", "bonding"].entries()) {
      const u = await T.app.users.register({ phone: `+22176000012${i}`, pin: "26804", name: "Fatou", lang: "fr" });
      await tradeRow(T, { kind: "cashin", state, userId: u.id, agentId: ndeye.id, sats: 1000 });
    }
    expect(await T.app.escrow.startCashin({ user: awa, agentId: ndeye.id, fcfa: 1000, sats: 2475, idemKey: "k2" })).toMatchObject({ ok: false, err: "BOND" });
  });

  it("one open trade per user, of either kind", async () => {
    const { T, awa, ndeye } = await setup();
    await credit(T, `bond:${ndeye.id}:spendable`, 1_000_000);
    const ousmane = await T.app.users.register({ phone: OUSMANE, pin: AGENT_PIN, name: "Ousmane", lang: "wo" });
    await T.app.agents.enroll({ userId: ousmane.id, momo: "+221781234000", method: "om", premiumBp: 200, minFcfa: 500, maxFcfa: 50_000, wallet: { kind: "world" } });
    await tradeRow(T, { kind: "cashout", state: "sent", userId: awa.id, agentId: ousmane.id });
    expect(await T.app.escrow.startCashin({ user: awa, agentId: ndeye.id, fcfa: 1000, sats: 2475, idemKey: "k3" })).toMatchObject({ ok: false, err: "OPEN_TRADE" });
    expect(await T.app.escrow.startCashout({ user: awa, agentId: ndeye.id, fcfa: 1000, sats: 2525, pin: PIN, idemKey: "k4" })).toMatchObject({ ok: false, err: "OPEN_TRADE" });
  });

  it("the sats on the confirm screen must still be about what the francs are worth", async () => {
    const { T, awa, ndeye } = await setup();
    await credit(T, `bond:${ndeye.id}:spendable`, 1_000_000);
    expect(await T.app.escrow.startCashin({ user: awa, agentId: ndeye.id, fcfa: 1000, sats: 3000, idemKey: "k5" })).toMatchObject({ ok: false, err: "GENERIC" });
    expect(await T.app.escrow.startCashin({ user: awa, agentId: ndeye.id, fcfa: 1000, sats: 0, idemKey: "k6" })).toMatchObject({ ok: false, err: "GENERIC" });
  });

  it("cash-out: refused over a limit and over the balance, and with a wrong code", async () => {
    const { T, awa, ndeye } = await setup();
    await credit(T, `user:${awa.id}:spendable`, 20_000); // 8 000 F
    expect(await T.app.escrow.startCashout({ user: awa, agentId: ndeye.id, fcfa: 1000, sats: 2525, pin: "11111", idemKey: "k7" })).toMatchObject({ ok: false, err: "PIN_WRONG" });
    // tier 0 allows 25 000 F per operation
    expect(await T.app.escrow.startCashout({ user: awa, agentId: ndeye.id, fcfa: 30_000, sats: 75_750, pin: PIN, idemKey: "k8" })).toMatchObject({ ok: false, err: "LIMIT", reason: "PER_TX" });
    // a first cash-out with this agent is capped like a first payment to anyone: 10 000 F at tier 0
    expect(await T.app.escrow.startCashout({ user: awa, agentId: ndeye.id, fcfa: 12_000, sats: 30_300, pin: PIN, idemKey: "k8b" })).toMatchObject({ ok: false, err: "LIMIT", reason: "NEW_RECIPIENT" });
    // 9 000 F needs 22 725 sats plus a fee allowance of 114; Awa has 20 000
    expect(await T.app.escrow.startCashout({ user: awa, agentId: ndeye.id, fcfa: 9000, sats: 22_725, pin: PIN, idemKey: "k9" })).toMatchObject({ ok: false, err: "INSUFFICIENT_FUNDS", balanceFcfa: 8000 });
    expect(await db_count(T, "trades")).toBe(0);
  });

  it("cash-out: a cash-out that has locked counts toward the day's limit until it is refunded", async () => {
    const { T, awa, ndeye } = await setup();
    await credit(T, `user:${awa.id}:spendable`, 400_000);
    // Three earlier cash-outs today (20 000, 20 000 and 10 000 F), the last one refunded:
    // 40 000 F of the 50 000 F day is used, 10 000 F is left.
    const row = "INSERT INTO txlog (user_id, ts, kind, amount_sat, amount_fcfa, counterparty, counterparty_id, receipt_no, ref, spend) VALUES ($1, $2, $3, $4, $5, 'Ndeye', $6, $7, $8, TRUE)";
    await T.db.query(row, [awa.id, T.clock.now(), "cashout", -50_500, -20_000, ndeye.id, 1, "op_a"]);
    await T.db.query(row, [awa.id, T.clock.now(), "cashout", -50_500, -20_000, ndeye.id, 2, "op_b"]);
    await T.db.query(row, [awa.id, T.clock.now(), "cashout", -25_250, -10_000, ndeye.id, 3, "op_c"]);
    await T.db.query(row, [awa.id, T.clock.now(), "cashout_refund", 25_250, 10_000, ndeye.id, 4, "op_c"]);
    const r = await T.app.escrow.startCashout({ user: awa, agentId: ndeye.id, fcfa: 15_000, sats: 37_875, pin: PIN, idemKey: "k10" });
    expect(r).toMatchObject({ ok: false, err: "LIMIT", reason: "PER_DAY", allowedFcfa: 10_000 });
    T.clock.advance(DAY);
    expect((await T.app.wallet.limitsView(awa)).dayLeftFcfa).toBe(50_000);
  });
});

describe("only the right person, with their own code, moves a trade", () => {
  it("only the trade's agent can confirm, decline or mark sent, and only with their code", async () => {
    const { T, awa, ndeye } = await setup();
    const ousmane = await T.app.users.register({ phone: OUSMANE, pin: "53182", name: "Ousmane", lang: "wo" });
    await T.app.agents.enroll({ userId: ousmane.id, momo: "+221781234000", method: "om", premiumBp: 200, minFcfa: 500, maxFcfa: 50_000, wallet: { kind: "world" } });
    const cin = await tradeRow(T, { kind: "cashin", state: "held", userId: awa.id, agentId: ndeye.id });
    const fatou = await T.app.users.register({ phone: "+221761239876", pin: "26804", name: "Fatou", lang: "fr" });
    const cout = await tradeRow(T, { kind: "cashout", state: "locked", userId: fatou.id, agentId: ndeye.id });

    // another agent, with their own right code
    expect(await T.app.escrow.agentConfirm({ agent: ousmane, tradeId: cin, pin: "53182" })).toMatchObject({ ok: false, err: "NOT_FOUND" });
    expect(await T.app.escrow.agentSent({ agent: ousmane, tradeId: cout, pin: "53182" })).toMatchObject({ ok: false, err: "NOT_FOUND" });
    expect(await T.app.escrow.agentDecline({ agent: ousmane, tradeId: cout, pin: "53182" })).toMatchObject({ ok: false, err: "NOT_FOUND" });
    // the user of the trade, posing as its agent
    expect(await T.app.escrow.agentConfirm({ agent: awa, tradeId: cin, pin: PIN })).toMatchObject({ ok: false, err: "NOT_FOUND" });
    // the right agent with a wrong code
    expect(await T.app.escrow.agentConfirm({ agent: ndeye, tradeId: cin, pin: "11111" })).toMatchObject({ ok: false, err: "PIN_WRONG" });
    expect(await T.app.escrow.agentSent({ agent: ndeye, tradeId: cout, pin: "11111" })).toMatchObject({ ok: false, err: "PIN_WRONG" });
    expect(await T.app.escrow.agentDecline({ agent: ndeye, tradeId: cout, pin: "11111" })).toMatchObject({ ok: false, err: "PIN_WRONG" });
    // the user's code is not the agent's code
    expect(await T.app.escrow.agentConfirm({ agent: ndeye, tradeId: cin, pin: PIN })).toMatchObject({ ok: false, err: "PIN_WRONG" });

    const states = await T.db.query<{ id: string; state: string }>("SELECT id, state FROM trades ORDER BY id");
    expect(Object.fromEntries(states.map((s) => [s.id, s.state]))).toEqual({ [cin]: "held", [cout]: "locked" });
  });

  it("marking sent moves no money, so a right code from the right agent is enough, once", async () => {
    const { T, awa, ndeye } = await setup();
    const cout = await tradeRow(T, { kind: "cashout", state: "locked", userId: awa.id, agentId: ndeye.id });
    expect(await T.app.escrow.agentSent({ agent: ndeye, tradeId: cout, pin: AGENT_PIN })).toMatchObject({ ok: true });
    expect(await T.app.escrow.agentSent({ agent: ndeye, tradeId: cout, pin: AGENT_PIN })).toMatchObject({ ok: false, err: "STATE" });
    expect(await T.app.escrow.agentDecline({ agent: ndeye, tradeId: cout, pin: AGENT_PIN })).toMatchObject({ ok: false, err: "STATE" });
    expect((await T.db.query<{ state: string }>("SELECT state FROM trades WHERE id = $1", [cout]))[0]!.state).toBe("sent");
    expect((await T.app.outbox.list(AWA)).map((m) => m.kind)).toEqual(["welcome", "wd_user_sent"]);
  });

  it("only the trade's user can confirm a cash-out, and only with their code", async () => {
    const { T, awa, ndeye } = await setup();
    const fatou = await T.app.users.register({ phone: "+221761239876", pin: "26804", name: "Fatou", lang: "fr" });
    const cout = await tradeRow(T, { kind: "cashout", state: "sent", userId: awa.id, agentId: ndeye.id });
    expect(await T.app.escrow.userConfirm({ user: fatou, tradeId: cout, pin: "26804" })).toMatchObject({ ok: false, err: "NOT_FOUND" });
    expect(await T.app.escrow.userConfirm({ user: ndeye, tradeId: cout, pin: AGENT_PIN })).toMatchObject({ ok: false, err: "NOT_FOUND" });
    expect(await T.app.escrow.userConfirm({ user: awa, tradeId: cout, pin: "11111" })).toMatchObject({ ok: false, err: "PIN_WRONG" });
    expect(await T.app.escrow.userConfirm({ user: awa, tradeId: cout, pin: AGENT_PIN })).toMatchObject({ ok: false, err: "PIN_WRONG" });
    expect((await T.db.query<{ state: string }>("SELECT state FROM trades WHERE id = $1", [cout]))[0]!.state).toBe("sent");
  });

  it("only the trade's user can open a dispute, and a dispute is opened once", async () => {
    const { T, awa, ndeye } = await setup();
    const cout = await tradeRow(T, { kind: "cashout", state: "sent", userId: awa.id, agentId: ndeye.id });
    expect(await T.app.escrow.dispute({ user: ndeye, tradeId: cout })).toMatchObject({ ok: false, err: "NOT_FOUND" });
    expect(await T.app.escrow.dispute({ user: awa, tradeId: cout })).toMatchObject({ ok: true });
    expect(await T.app.escrow.dispute({ user: awa, tradeId: cout })).toMatchObject({ ok: false, err: "STATE" });
    const kinds = async (phone: string) => (await T.app.outbox.list(phone)).map((m) => m.kind);
    expect(await kinds(AWA)).toContain("dispute");
    expect(await kinds(NDEYE)).toContain("dispute");
  });

  it("a decision needs a dispute, a known winner and an arbiter, and is written to the audit log", async () => {
    const { T, awa, ndeye } = await setup();
    const held = await tradeRow(T, { kind: "cashin", state: "held", userId: awa.id, agentId: ndeye.id });
    expect(await T.app.escrow.decide({ tradeId: held, winner: "user", arbiter: "op1", note: "" })).toMatchObject({ ok: false, err: "STATE" });
    expect(await T.app.escrow.decide({ tradeId: "t_nope", winner: "user", arbiter: "op1", note: "" })).toMatchObject({ ok: false, err: "NOT_FOUND" });
    expect(await T.app.escrow.decide({ tradeId: held, winner: "nobody" as "user", arbiter: "op1", note: "" })).toMatchObject({ ok: false, err: "BAD_INPUT" });
    expect(await T.app.escrow.decide({ tradeId: held, winner: "user", arbiter: "", note: "" })).toMatchObject({ ok: false, err: "BAD_INPUT" });
    expect(await T.db.query("SELECT 1 FROM audit_log")).toHaveLength(0);
  });
});

describe("a move is applied only to the state it was read in", () => {
  it("a move made from a stale read of a trade changes nothing", async () => {
    const { T, awa, ndeye } = await setup();
    const id = await tradeRow(T, { kind: "cashout", state: "sent", userId: awa.id, agentId: ndeye.id });
    const stale = (await T.db.query("SELECT * FROM trades WHERE id = $1", [id]))[0];
    // Someone else moves the trade first: the user disputes it.
    expect(await T.app.escrow.dispute({ user: awa, tradeId: id })).toMatchObject({ ok: true });
    // A move computed from the old read ("sent", so a time-out would make it "disputed" again) loses.
    const move = (T.app.escrow as unknown as { move: (db: unknown, r: unknown, e: string, p?: unknown) => Promise<unknown> }).move.bind(T.app.escrow);
    expect(await move(T.db, stale, "userConfirm")).toBeNull();
    expect(await move(T.db, stale, "timeout")).toBeNull();
    expect((await T.db.query<{ state: string }>("SELECT state FROM trades WHERE id = $1", [id]))[0]!.state).toBe("disputed");
  });
});

describe("bonds", () => {
  it("a bond cannot be withdrawn while a trade or a dispute of the agent is open", async () => {
    const { T, awa, ndeye } = await setup();
    await credit(T, `bond:${ndeye.id}:spendable`, 10_000);
    for (const [kind, state] of [["cashin", "held"], ["cashin", "released"], ["cashout", "disputed"], ["cashout", "paying"]] as const) {
      await T.db.query("DELETE FROM trades");
      await tradeRow(T, { kind, state, userId: awa.id, agentId: ndeye.id });
      expect(await T.app.escrow.bondOut({ agent: ndeye, pin: AGENT_PIN, idemKey: `out:${kind}:${state}` }), `${kind} ${state}`).toMatchObject({ ok: false, err: "OPEN_TRADE" });
    }
    expect(await T.app.escrow.bondOut({ agent: awa, pin: PIN, idemKey: "out:x" })).toMatchObject({ ok: false, err: "NOT_FOUND" });
    await T.db.query("DELETE FROM trades");
    expect(await T.app.escrow.bondOut({ agent: ndeye, pin: "11111", idemKey: "out:y" })).toMatchObject({ ok: false, err: "PIN_WRONG" });
  });
});

describe("privacy", () => {
  it("the agent's mobile-money number and the user's number are sealed in the database and in no log", async () => {
    const { T, awa, ndeye } = await setup();
    await credit(T, `bond:${ndeye.id}:spendable`, 1_000_000);
    await credit(T, `user:${awa.id}:spendable`, 30_000);
    await T.app.escrow.offers("cashin", awa, 1000);
    await T.app.escrow.startCashout({ user: awa, agentId: ndeye.id, fcfa: 30_000, sats: 75_750, pin: PIN, idemKey: "k11" });
    const cout = await tradeRow(T, { kind: "cashout", state: "locked", userId: awa.id, agentId: ndeye.id });
    await T.app.escrow.agentSent({ agent: ndeye, tradeId: cout, pin: AGENT_PIN });
    expect(await T.app.agents.momoOf(ndeye.id)).toBe(NDEYE_MOMO);

    const dump = JSON.stringify([await T.db.query("SELECT * FROM agents"), await T.db.query("SELECT * FROM trades"), await T.db.query("SELECT * FROM users")]);
    for (const number of [NDEYE_MOMO, AWA, NDEYE]) {
      for (const form of [number, number.slice(4), Buffer.from(number).toString("hex")]) expect(dump, form).not.toContain(form);
    }
    const { text } = logWords(T.logs);
    for (const secret of [NDEYE_MOMO, NDEYE_MOMO.slice(4), AWA.slice(4), NDEYE.slice(4), PIN, AGENT_PIN]) expect(text).not.toContain(secret);
  });
});

describe("the arbiter's route", () => {
  it("/ops/escrow/decide does not exist without OPERATOR_SECRET", async () => {
    const { T } = await setup();
    const http = buildHttp(T.app);
    const r = await http.inject({ method: "POST", url: "/ops/escrow/decide", headers: { authorization: `Bearer ${OPERATOR_SECRET}` }, payload: "{}" });
    expect(r.statusCode).toBe(404);
    await http.close();
  });

  it("a wrong or missing secret looks like a missing path; the right one reaches the engine", async () => {
    const { T, awa, ndeye } = await setup({ OPERATOR_SECRET });
    const http = buildHttp(T.app);
    const id = await tradeRow(T, { kind: "cashout", state: "disputed", userId: awa.id, agentId: ndeye.id });
    const body = JSON.stringify({ tradeId: id, winner: "agent", arbiter: "op1", note: "transfer reference seen" });
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: `Bearer ${OPERATOR_SECRET}x` }, { authorization: OPERATOR_SECRET }]) {
      const r = await http.inject({ method: "POST", url: "/ops/escrow/decide", headers, payload: body });
      expect(r.statusCode, JSON.stringify(headers)).toBe(404);
      expect(r.json()).toEqual({ error: "not_found" });
    }
    expect((await T.db.query<{ state: string }>("SELECT state FROM trades WHERE id = $1", [id]))[0]!.state).toBe("disputed");
    const bad = await http.inject({ method: "POST", url: "/ops/escrow/decide", headers: { authorization: `Bearer ${OPERATOR_SECRET}` }, payload: JSON.stringify({ tradeId: id, winner: "both", arbiter: "op1" }) });
    expect(bad.statusCode).toBe(400);
    expect(await T.db.query("SELECT 1 FROM audit_log")).toHaveLength(0);
    await http.close();
  });

  it("/sim/decide exists in demo mode only", async () => {
    const { T } = await setup();
    const http = buildHttp(T.app);
    expect((await http.inject({ method: "POST", url: "/sim/decide", payload: JSON.stringify({ ref: "DXXXX", winner: "user" }) })).statusCode).toBe(404);
    await http.close();
    const off = await setup({ MELAX_DEMO: "0", SMS_ADAPTER: "asg", ASG_URL: "http://sms.invalid", ASG_USER: "u", ASG_PASSWORD: "p" });
    const http2 = buildHttp(off.T.app);
    const r = await http2.inject({ method: "POST", url: "/sim/decide", payload: JSON.stringify({ ref: "DXXXX", winner: "user" }) });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: "not_found" });
    await http2.close();
  });
});

async function db_count(T: { db: { query: (s: string) => Promise<unknown[]> } }, table: string): Promise<number> {
  return (await T.db.query(`SELECT 1 FROM ${table}`)).length;
}
