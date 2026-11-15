// The escrow's Lightning leg on the public NWC sandbox (faucet.nwc.dev, fake sats, needs internet):
// the gateway's side and the agent's wallet are two throwaway sandbox wallets.
// What this file shows: a cash-in's payment is held, settled on the agent's confirmation, given back
// on a time-out, and (rule 15) a payment that arrives after the trade closed is given back too. On
// this wallet an unpaid hold invoice cannot be cancelled, so that last case really happens here.
// What it does not show: the credit. The sandbox and our regtest mint are on different networks, so
// the sats cannot become ecash here; the whole flow runs on regtest in escrow.itest.ts. The mint is a
// stand-in that fails the test if anything but the credit step reaches for it.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MINUTE } from "@melax/core";
import type { MintClient } from "@melax/cashu";
import { post } from "@melax/ledger";
import { NwcBackend } from "@melax/lightning";
import type { User } from "../src/users.ts";
import { type TestApp, newDb, testApp, untouchable } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let gateway: NwcBackend;
let agentWallet: NwcBackend;
let T: TestApp;
let awa: User;
let ndeye: User;

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(1000);
  }
  throw new Error("timed out waiting for " + what);
}
const stateOf = async (id: string) => (await T.db.query<{ state: string }>("SELECT state FROM trades WHERE id = $1", [id]))[0]!.state;
const hashOf = async (id: string) => (await T.db.query<{ payment_hash: string; bolt11: string }>("SELECT payment_hash, bolt11 FROM trades WHERE id = $1", [id]))[0]!;

beforeAll(async () => {
  gateway = await NwcBackend.fromFaucet(0);
  agentWallet = await NwcBackend.fromFaucet(50_000);
  expect((await gateway.capabilities()).holdInvoices).toBe(true);
  const db = await newDb();
  T = testApp(db, { mint: untouchable<MintClient>("the mint"), ln: gateway, world: agentWallet, env: { MELAX_PEPPER: randomBytes(32).toString("hex") } });
  awa = await T.app.users.register({ phone: "+221771234567", pin: "48291", name: "Awa", lang: "fr" });
  ndeye = await T.app.users.register({ phone: "+221770000107", pin: "61937", name: "Ndeye", lang: "fr" });
  await T.app.agents.enroll({ userId: ndeye.id, momo: "+221776665544", method: "wave", premiumBp: 100, minFcfa: 500, maxFcfa: 50_000, wallet: { kind: "world" } });
  ndeye = (await T.app.users.byId(ndeye.id))!;
  // The bond is booked straight into the ledger: there is no mint on this network to make it real ecash.
  await post(db, T.clock, { kind: "test.bond", idemKey: "test:bond", postings: [{ account: "ext:ecash", delta: -100_000 }, { account: `bond:${ndeye.id}:spendable`, delta: 100_000 }] });
}, 120_000);
afterAll(async () => {
  await gateway?.close();
  await agentWallet?.close();
});

describe("the escrow's Lightning leg on the NWC sandbox", () => {
  it("held, then settled on the agent's confirmation: the agent's payment succeeds", async () => {
    const r = await T.app.escrow.startCashin({ user: awa, agentId: ndeye.id, fcfa: 1000, sats: 2475, idemKey: "nwc:1", waitMs: 30_000 });
    expect(r).toMatchObject({ ok: true, trade: { state: "held" } });
    const id = r.ok ? r.trade.id : "";
    const { payment_hash: hash } = await hashOf(id);
    expect((await gateway.lookupInvoice(hash))?.state).toBe("accepted");
    expect((await agentWallet.lookupPayment(hash))?.status).toBe("pending");

    const c = await T.app.escrow.agentConfirm({ agent: ndeye, tradeId: id, pin: "61937" });
    expect(c.ok).toBe(true);
    expect((await gateway.lookupInvoice(hash))?.state).toBe("settled");
    expect(await waitFor("the agent's payment to succeed", async () => (await agentWallet.lookupPayment(hash))?.status === "succeeded")).toBe(true);
    // The credit needs the mint, which is on another network: the trade waits in "settling".
    expect(await stateOf(id)).toBe("settling");
  }, 120_000);

  it("held, then nobody confirms: on time-out the agent's payment is given back", async () => {
    const fatou = await T.app.users.register({ phone: "+221761239876", pin: "26804", name: "Fatou", lang: "fr" });
    const r = await T.app.escrow.startCashin({ user: fatou, agentId: ndeye.id, fcfa: 1000, sats: 2475, idemKey: "nwc:2", waitMs: 30_000 });
    expect(r).toMatchObject({ ok: true, trade: { state: "held" } });
    const id = r.ok ? r.trade.id : "";
    const { payment_hash: hash } = await hashOf(id);
    T.clock.advance(46 * MINUTE);
    await T.app.escrow.sweep();
    expect(await stateOf(id)).toBe("expired");
    expect(await waitFor("the invoice to be cancelled", async () => (await gateway.lookupInvoice(hash))?.state === "cancelled")).toBe(true);
    expect(await waitFor("the agent's payment to fail", async () => (await agentWallet.lookupPayment(hash))?.status === "failed")).toBe(true);
  }, 120_000);

  it("rule 15: an invoice that could not be cancelled is paid after its trade closed, and the payment is given back on sight", async () => {
    const before = (await agentWallet.balance()).spendableSat;
    const ibra = await T.app.users.register({ phone: "+221700000105", pin: "53182", name: "Ibra", lang: "fr" });
    // A second process whose agent wallet takes the request and does not pay yet.
    const silent = new Proxy(agentWallet, { get: (t, p, rcv) => (p === "pay" ? async () => ({ status: "pending" as const }) : Reflect.get(t, p, rcv)) });
    const app2 = testApp(T.db, { mint: untouchable<MintClient>("the mint"), ln: gateway, world: silent, clock: T.clock, env: { MELAX_PEPPER: T.app.config.pepper.toString("hex") } });
    const r = await app2.app.escrow.startCashin({ user: ibra, agentId: ndeye.id, fcfa: 1000, sats: 2475, idemKey: "nwc:3", waitMs: 1000 });
    expect(r).toMatchObject({ ok: true, trade: { state: "open" } });
    const id = r.ok ? r.trade.id : "";
    const { payment_hash: hash, bolt11 } = await hashOf(id);

    T.clock.advance(11 * MINUTE);
    await app2.app.escrow.sweep();
    expect(await stateOf(id)).toBe("expired");
    // This wallet cannot cancel an invoice nobody paid: it is still payable.
    expect((await gateway.lookupInvoice(hash))?.state).toBe("open");

    // The agent pays now, too late.
    const paying = agentWallet.pay({ bolt11, maxFeeSat: 20, timeoutSec: 60 });
    await waitFor("the late payment to be held", async () => (await gateway.lookupInvoice(hash))?.state === "accepted");
    await app2.app.escrow.sweep();
    expect(await waitFor("the late payment to be given back", async () => (await gateway.lookupInvoice(hash))?.state === "cancelled")).toBe(true);
    expect((await paying).status).toBe("failed");
    expect(await stateOf(id)).toBe("expired");
    expect(before - (await agentWallet.balance()).spendableSat).toBeLessThan(50);
  }, 180_000);
});
