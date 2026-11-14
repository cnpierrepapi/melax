// Runs against the real Nutshell mint on regtest (docker compose up, then bash scripts/dev-creds.sh).
// Faults are injected at the network edge of the test process: the mint itself is never mocked.
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pubkeyFromPriv, randomPrivKey } from "@melax/crypto";
import { LndBackend, feeCapSat } from "@melax/lightning";
import { MintClient, type PlainProof, sumPlain } from "../src/index.ts";

const keys = resolve(import.meta.dirname, "../../../.keys");
const lnd = (name: string, port: number) =>
  LndBackend.fromFiles({ baseUrl: `https://localhost:${port}`, macaroonPath: `${keys}/lnd-${name}/admin.macaroon`, tlsCertPath: `${keys}/lnd-${name}/tls.cert` });
const MINT = process.env.MINT_URL ?? "http://localhost:3338";

let mint: MintClient;
let gw: LndBackend;
let world: LndBackend;
const realFetch = globalThis.fetch;

/**
 * Network faults for requests whose URL contains `match`, until heal() is called.
 * "lost-reply": the mint processes the request, we never hear back. "down": the request never leaves.
 * The client library retries such failures by itself (NUT-19), so the fault has to outlast the retries
 * to look like what a crashed process sees: a request that went out and no answer on record.
 */
function fault(match: string, mode: "lost-reply" | "down", times = Number.POSITIVE_INFINITY): void {
  let left = times;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (left > 0 && url.includes(match)) {
      left--;
      if (mode === "lost-reply") await realFetch(input, init);
      throw new TypeError("fetch failed (injected " + mode + ")");
    }
    return realFetch(input, init);
  }) as typeof fetch;
}
const heal = () => {
  globalThis.fetch = realFetch;
};

async function fund(amountSat: number): Promise<PlainProof[]> {
  const q = await mint.mintQuote(amountSat);
  const paid = await gw.pay({ bolt11: q.bolt11, maxFeeSat: feeCapSat(amountSat) });
  expect(paid.status).toBe("succeeded");
  for (let i = 0; i < 40 && (await mint.mintQuoteState(q.quote)) !== "PAID"; i++) await new Promise((r) => setTimeout(r, 200));
  return mint.runMint(mint.planMint(q.quote, amountSat));
}

beforeAll(async () => {
  mint = await MintClient.connect(MINT);
  gw = lnd("gw", 18081);
  world = lnd("world", 18082);
});
afterAll(async () => {
  heal();
  await gw?.close();
  await world?.close();
});

describe("mint: Lightning in, ecash out", () => {
  it("issues exactly the amount paid, once", async () => {
    const q = await mint.mintQuote(512);
    expect(await mint.mintQuoteState(q.quote)).toBe("UNPAID");
    const plan = mint.planMint(q.quote, 512);
    await expect(mint.runMint(plan)).rejects.toMatchObject({ code: "UPSTREAM" }); // not paid yet
    expect((await gw.pay({ bolt11: q.bolt11, maxFeeSat: 5 })).status).toBe("succeeded");
    for (let i = 0; i < 40 && (await mint.mintQuoteState(q.quote)) !== "PAID"; i++) await new Promise((r) => setTimeout(r, 200));
    const proofs = await mint.runMint(plan);
    expect(sumPlain(proofs)).toBe(512);
    expect(await mint.mintQuoteState(q.quote)).toBe("ISSUED");
    // The very same request again is answered from the mint's response cache (NUT-19): same proofs, nothing new.
    expect(await mint.runMint(plan)).toEqual(proofs);
    await expect(mint.runMint(mint.planMint(q.quote, 512))).rejects.toMatchObject({ code: "UPSTREAM" }); // fresh outputs, same quote
    expect((await mint.states(proofs)).every((s) => s === "UNSPENT")).toBe(true);
  });

  it("lost reply: the proofs are rebuilt from the stored plan, not minted twice", async () => {
    const q = await mint.mintQuote(300);
    expect((await gw.pay({ bolt11: q.bolt11, maxFeeSat: 5 })).status).toBe("succeeded");
    for (let i = 0; i < 40 && (await mint.mintQuoteState(q.quote)) !== "PAID"; i++) await new Promise((r) => setTimeout(r, 200));
    const plan = JSON.parse(JSON.stringify(mint.planMint(q.quote, 300))); // as it comes back from storage
    expect(await mint.recoverMint(plan)).toEqual({ status: "not_run" });
    fault("/v1/mint/bolt11", "lost-reply");
    await expect(mint.runMint(plan)).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    heal();
    const rec = await mint.recoverMint(plan);
    expect(rec.status).toBe("done");
    if (rec.status === "done") {
      expect(sumPlain(rec.proofs)).toBe(300);
      expect((await mint.states(rec.proofs)).every((s) => s === "UNSPENT")).toBe(true);
    }
  });
});

describe("swap", () => {
  it("splits into the amount and the change, and spends the inputs", async () => {
    const proofs = await fund(1000);
    const plan = mint.planSwap(proofs, 300);
    const { send, keep } = await mint.runSwap(plan);
    expect(sumPlain(send)).toBe(300);
    expect(sumPlain(keep)).toBe(700 - plan.feeSat);
    expect((await mint.states(proofs)).every((s) => s === "SPENT")).toBe(true);
    const secrets = new Set([...send, ...keep].map((p) => p.secret));
    for (const p of proofs) expect(secrets.has(p.secret)).toBe(false);
  });

  it("swaps even when the inputs already add up exactly, so no secret is shared", async () => {
    const proofs = await fund(64);
    const { send, keep } = await mint.runSwap(mint.planSwap(proofs, 64));
    expect(sumPlain(send)).toBe(64);
    expect(keep).toHaveLength(0);
    expect(send.some((p) => proofs.some((q) => q.secret === p.secret))).toBe(false);
    expect((await mint.states(proofs)).every((s) => s === "SPENT")).toBe(true);
  });

  it("refuses to plan more than the inputs hold", async () => {
    const proofs = await fund(10);
    expect(() => mint.planSwap(proofs, 11)).toThrow(expect.objectContaining({ code: "INSUFFICIENT_FUNDS" }));
  });

  it("spent inputs are refused with a definite error, and the plan reports unknown rather than done", async () => {
    const proofs = await fund(100);
    await mint.runSwap(mint.planSwap(proofs, 40));
    const second = mint.planSwap(proofs, 40);
    await expect(mint.runSwap(second)).rejects.toMatchObject({ code: "UPSTREAM" });
    expect((await mint.recoverSwap(second)).status).toBe("unknown"); // inputs spent, but not by this plan
  });

  it("lost reply: the swap happened, recovery returns the very proofs that were planned", async () => {
    const proofs = await fund(500);
    const plan = JSON.parse(JSON.stringify(mint.planSwap(proofs, 123)));
    fault("/v1/swap", "lost-reply");
    await expect(mint.runSwap(plan)).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    heal();
    const rec = await mint.recoverSwap(plan);
    expect(rec.status).toBe("done");
    if (rec.status !== "done") return;
    expect(sumPlain(rec.send)).toBe(123);
    expect(sumPlain(rec.keep)).toBe(377);
    expect((await mint.states([...rec.send, ...rec.keep])).every((s) => s === "UNSPENT")).toBe(true);
    // and they are spendable
    await mint.runSwap(mint.planSwap(rec.send, 123));
  });

  it("mint down: nothing happened, recovery says so and the inputs are still good", async () => {
    const proofs = await fund(200);
    const plan = mint.planSwap(proofs, 50);
    fault("/v1/swap", "down");
    await expect(mint.runSwap(plan)).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    heal();
    expect(await mint.recoverSwap(plan)).toEqual({ status: "not_run" });
    await mint.runSwap(plan); // the same plan can then be run
  });
});

describe("locked ecash (the voucher mechanism)", () => {
  it("only the key holder can spend, and only once", async () => {
    const proofs = await fund(256);
    const sk = randomPrivKey();
    const refundSk = randomPrivKey();
    const lock = { pubkey: pubkeyFromPriv(sk), locktime: Math.floor(Date.now() / 1000) + 3600, refundKeys: [pubkeyFromPriv(refundSk)] };
    const { send: locked } = await mint.runSwap(mint.planSwap(proofs, 256, lock));
    expect(mint.verifyOffline(locked, lock.pubkey)).toBe(true);
    expect(mint.verifyOffline(locked, pubkeyFromPriv(randomPrivKey()))).toBe(false);

    await expect(mint.runSwap(mint.planSwap(locked, 256))).rejects.toMatchObject({ code: "UPSTREAM" }); // no key
    await expect(mint.runSwap(mint.planSwap(locked, 256), randomPrivKey())).rejects.toMatchObject({ code: "UPSTREAM" }); // wrong key
    await expect(mint.runSwap(mint.planSwap(locked, 256), refundSk)).rejects.toMatchObject({ code: "UPSTREAM" }); // refund key before the locktime
    expect((await mint.states(locked)).every((s) => s === "UNSPENT")).toBe(true);

    const { send: free } = await mint.runSwap(mint.planSwap(locked, 256), sk);
    expect(sumPlain(free)).toBe(256);
    await expect(mint.runSwap(mint.planSwap(locked, 256), sk)).rejects.toMatchObject({ code: "UPSTREAM" }); // second time
  });

  it("after the locktime the refund key can take it back", async () => {
    const proofs = await fund(32);
    const refundSk = randomPrivKey();
    const lock = { pubkey: pubkeyFromPriv(randomPrivKey()), locktime: Math.floor(Date.now() / 1000) - 5, refundKeys: [pubkeyFromPriv(refundSk)] };
    const { send: locked } = await mint.runSwap(mint.planSwap(proofs, 32, lock));
    await expect(mint.runSwap(mint.planSwap(locked, 32), randomPrivKey())).rejects.toMatchObject({ code: "UPSTREAM" });
    const { send } = await mint.runSwap(mint.planSwap(locked, 32), refundSk);
    expect(sumPlain(send)).toBe(32);
  });
});

describe("melt: ecash in, Lightning out", () => {
  async function exactFor(q: { amountSat: number; feeReserveSat: number }): Promise<PlainProof[]> {
    const need = q.amountSat + q.feeReserveSat;
    const proofs = await fund(need + 100);
    return (await mint.runSwap(mint.planSwap(proofs, need))).send;
  }

  it("pays the invoice and returns the unused fee reserve as change", async () => {
    const inv = await world.makeInvoice({ amountSat: 400, memo: "melt test" });
    const q = await mint.meltQuote(inv.bolt11);
    expect(q.amountSat).toBe(400);
    const inputs = await exactFor(q);
    const plan = await mint.planMelt(q, inputs);
    const res = await mint.runMelt(plan);
    expect(res.state).toBe("PAID");
    expect(res.preimage).toMatch(/^[0-9a-f]{64}$/);
    expect((await world.lookupInvoice(inv.paymentHash))?.state).toBe("settled");
    const feePaid = sumPlain(inputs) - 400 - sumPlain(res.change);
    expect(feePaid).toBeGreaterThanOrEqual(0);
    expect(feePaid).toBeLessThanOrEqual(q.feeReserveSat);
    expect((await mint.states(inputs)).every((s) => s === "SPENT")).toBe(true);
    if (res.change.length) expect((await mint.states(res.change)).every((s) => s === "UNSPENT")).toBe(true);
  });

  it("refuses inputs that are not the exact amount", async () => {
    const inv = await world.makeInvoice({ amountSat: 100 });
    const q = await mint.meltQuote(inv.bolt11);
    const proofs = await fund(q.amountSat + q.feeReserveSat + 50);
    await expect(mint.planMelt(q, proofs)).rejects.toMatchObject({ code: "BAD_AMOUNT" });
  });

  it("lost reply: the payment went out, checkMelt finds it and rebuilds the change", async () => {
    const inv = await world.makeInvoice({ amountSat: 350 });
    const q = await mint.meltQuote(inv.bolt11);
    const inputs = await exactFor(q);
    const plan = JSON.parse(JSON.stringify(await mint.planMelt(q, inputs)));
    fault("/v1/melt/bolt11", "lost-reply");
    await expect(mint.runMelt(plan)).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    heal();
    const res = await mint.checkMelt(plan);
    expect(res.state).toBe("PAID");
    expect((await world.lookupInvoice(inv.paymentHash))?.state).toBe("settled");
    expect(sumPlain(inputs) - 350 - sumPlain(res.change)).toBeLessThanOrEqual(q.feeReserveSat);
    if (res.change.length) expect((await mint.states(res.change)).every((s) => s === "UNSPENT")).toBe(true);
  });

  it("a payment that cannot succeed leaves the inputs unspent", async () => {
    const preimage = randomBytes(32);
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(preimage).digest("hex");
    const inv = await world.makeHoldInvoice({ amountSat: 120, paymentHash: hash, expirySec: 600 });
    await world.cancel(hash); // the payee will reject it
    const q = await mint.meltQuote(inv.bolt11);
    const inputs = await exactFor(q);
    const plan = await mint.planMelt(q, inputs);
    const res = await mint.runMelt(plan);
    expect(res.state).toBe("UNPAID");
    expect((await mint.states(inputs)).every((s) => s === "UNSPENT")).toBe(true);
  });
});

describe("tokens", () => {
  it("encode and decode round-trip, and a token from another mint is refused", async () => {
    const proofs = await fund(21);
    const token = mint.encodeToken(proofs, "merci");
    expect(token.startsWith("cashuB")).toBe(true);
    expect(mint.decodeToken(token).map((p) => p.secret).sort()).toEqual(proofs.map((p) => p.secret).sort());
    const other = await MintClient.connect(MINT);
    Object.defineProperty(other, "url", { value: "https://some-other-mint.example" });
    expect(() => mint.decodeToken(other.encodeToken(proofs))).toThrow(expect.objectContaining({ code: "BAD_INPUT" }));
    expect(() => mint.decodeToken("cashuBnotatoken")).toThrow(expect.objectContaining({ code: "BAD_INPUT" }));
  });
});
