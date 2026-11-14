// The contract every LightningBackend must honour. The same suite runs against LND on regtest and
// against the public NWC sandbox, so the escrow engine can rely on one behaviour.
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type InvoiceStatus, type LightningBackend, decodeInvoice, preimageMatches } from "../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newSecret = () => {
  const preimage = randomBytes(32).toString("hex");
  return { preimage, hash: createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex") };
};

async function waitState(b: LightningBackend, hash: string, want: string, ms = 30_000): Promise<InvoiceStatus> {
  const end = Date.now() + ms;
  let last: InvoiceStatus | null = null;
  while (Date.now() < end) {
    last = await b.lookupInvoice(hash);
    if (last?.state === want) return last;
    await sleep(400);
  }
  throw new Error(`invoice never reached ${want}; last state ${last?.state}`);
}

/**
 * Channel balances move while an HTLC is added or removed (the commitment fee changes with it), so a
 * single read can be mid-update. Measured with scripts/probe/lnd-cancel-probe.ts: the payer's local
 * balance drops by amount + fee delta while held and returns to the exact starting value after a cancel.
 * This reads until two consecutive reads agree.
 */
async function quietBalance(b: LightningBackend): Promise<number> {
  let prev = -1;
  for (let i = 0; i < 40; i++) {
    const now = (await b.balance()).spendableSat;
    if (now === prev) return now;
    prev = now;
    await sleep(600);
  }
  throw new Error("balance never settled");
}

export function runContract(name: string, make: () => Promise<{ payee: LightningBackend; payer: LightningBackend; network: string; exactRefund: boolean }>): void {
  describe(`LightningBackend contract: ${name}`, () => {
    let payee: LightningBackend;
    let payer: LightningBackend;
    let network: string;
    let exactRefund: boolean;
    const updates: InvoiceStatus[] = [];
    let unsub: () => void;

    beforeAll(async () => {
      ({ payee, payer, network, exactRefund } = await make());
      unsub = payee.subscribeInvoices((s) => updates.push(s));
      await sleep(1500);
    });
    afterAll(async () => {
      unsub?.();
      await payee?.close();
      await payer?.close();
    });

    it("reports hold-invoice support and its network", async () => {
      const c = await payee.capabilities();
      expect(c.holdInvoices).toBe(true);
      expect(c.network).toBe(network);
      expect(c.pubkey).toMatch(/^[0-9a-f]{64,66}$/);
    });

    it("plain invoice: pay, get a preimage that matches, see it settled", async () => {
      const inv = await payee.makeInvoice({ amountSat: 1000, memo: "contract plain" });
      expect(decodeInvoice(inv.bolt11)).toMatchObject({ amountSat: 1000, paymentHash: inv.paymentHash, network });
      expect((await payee.lookupInvoice(inv.paymentHash))?.state).toBe("open");
      const out = await payer.pay({ bolt11: inv.bolt11, maxFeeSat: 20 });
      expect(out.status).toBe("succeeded");
      if (out.status !== "succeeded") return;
      expect(preimageMatches(out.preimage, inv.paymentHash)).toBe(true);
      expect(out.feeSat).toBeLessThanOrEqual(20);
      const settled = await waitState(payee, inv.paymentHash, "settled");
      expect(settled.amountSat).toBe(1000);
      // the push notification arrives too
      const end = Date.now() + 15_000;
      while (Date.now() < end && !updates.some((u) => u.paymentHash === inv.paymentHash && u.state === "settled")) await sleep(300);
      expect(updates.some((u) => u.paymentHash === inv.paymentHash && u.state === "settled")).toBe(true);
    });

    it("an invoice can commit to a description hash (needed for LNURL-pay)", async () => {
      const h = createHash("sha256").update('[["text/plain","Melax"]]').digest("hex");
      const inv = await payee.makeInvoice({ amountSat: 210, descriptionHash: h });
      expect(decodeInvoice(inv.bolt11).descriptionHash).toBe(h);
    });

    it("paying the same invoice twice never pays twice", async () => {
      const inv = await payee.makeInvoice({ amountSat: 500 });
      const before = (await payer.balance()).spendableSat;
      const first = await payer.pay({ bolt11: inv.bolt11, maxFeeSat: 20 });
      const second = await payer.pay({ bolt11: inv.bolt11, maxFeeSat: 20 });
      expect(first.status).toBe("succeeded");
      expect(second.status).not.toBe("succeeded");
      const looked = await payer.lookupPayment(inv.paymentHash);
      expect(looked?.status).toBe("succeeded");
      const spent = before - (await payer.balance()).spendableSat;
      expect(spent).toBeGreaterThanOrEqual(500);
      expect(spent).toBeLessThan(1000);
    });

    it("hold invoice: sats lock on payment, reach us only on settle", async () => {
      const { preimage, hash } = newSecret();
      const inv = await payee.makeHoldInvoice({ amountSat: 2000, paymentHash: hash, memo: "contract hold", expirySec: 600 });
      expect(inv.paymentHash).toBe(hash);
      const paying = payer.pay({ bolt11: inv.bolt11, maxFeeSat: 20, timeoutSec: 60 });
      const held = await waitState(payee, hash, "accepted");
      expect(held.amountSat).toBe(2000);
      // while held, the payer has not been told it succeeded
      const race = await Promise.race([paying.then(() => "resolved"), sleep(1500).then(() => "still waiting")]);
      expect(race).toBe("still waiting");
      expect((await payer.lookupPayment(hash))?.status).toBe("pending");
      await payee.settle(preimage);
      const out = await paying;
      expect(out.status).toBe("succeeded");
      if (out.status === "succeeded") expect(out.preimage).toBe(preimage);
      await waitState(payee, hash, "settled");
    });

    it("hold invoice: cancel sends every sat back to the payer", async () => {
      const { hash } = newSecret();
      const before = await quietBalance(payer);
      const inv = await payee.makeHoldInvoice({ amountSat: 3000, paymentHash: hash, expirySec: 600 });
      const paying = payer.pay({ bolt11: inv.bolt11, maxFeeSat: 20, timeoutSec: 60 });
      await waitState(payee, hash, "accepted");
      expect((await payer.balance()).spendableSat).toBeLessThanOrEqual(before - 3000);
      await payee.cancel(hash);
      const out = await paying;
      expect(out.status).toBe("failed");
      await waitState(payee, hash, "cancelled");
      const after = await quietBalance(payer);
      if (exactRefund) expect(after).toBe(before);
      else expect(before - after).toBeLessThan(50);
      expect((await payer.lookupPayment(hash))?.status).toBe("failed");
    });

    it("a wrong preimage does not settle a held invoice", async () => {
      const { preimage, hash } = newSecret();
      const inv = await payee.makeHoldInvoice({ amountSat: 700, paymentHash: hash, expirySec: 600 });
      const paying = payer.pay({ bolt11: inv.bolt11, maxFeeSat: 20, timeoutSec: 60 });
      await waitState(payee, hash, "accepted");
      await expect(payee.settle(randomBytes(32).toString("hex"))).rejects.toThrow();
      expect((await payee.lookupInvoice(hash))?.state).toBe("accepted");
      await payee.settle(preimage);
      expect((await paying).status).toBe("succeeded");
    });

    it("once settled, a cancel changes nothing", async () => {
      const { preimage, hash } = newSecret();
      const inv = await payee.makeHoldInvoice({ amountSat: 600, paymentHash: hash, expirySec: 600 });
      const paying = payer.pay({ bolt11: inv.bolt11, maxFeeSat: 20, timeoutSec: 60 });
      await waitState(payee, hash, "accepted");
      await payee.settle(preimage);
      expect((await paying).status).toBe("succeeded");
      await payee.cancel(hash).catch(() => undefined);
      expect((await payee.lookupInvoice(hash))?.state).toBe("settled");
    });

    it("an invoice cancelled before anyone paid never ends up settled", async () => {
      const { hash } = newSecret();
      const inv = await payee.makeHoldInvoice({ amountSat: 900, paymentHash: hash, expirySec: 600 });
      const cancelledNow = await payee.cancel(hash);
      const paying = payer.pay({ bolt11: inv.bolt11, maxFeeSat: 20, timeoutSec: 20 });
      if (!cancelledNow) {
        // This backend cannot cancel an unpaid invoice: the late payment gets held, and we refund it then.
        await waitState(payee, hash, "accepted");
        expect(await payee.cancel(hash)).toBe(true);
      }
      expect((await paying).status).toBe("failed");
      expect((await payee.lookupInvoice(hash))?.state).not.toBe("settled");
    });

    it("unknown hashes are 'not found', not errors", async () => {
      const { hash } = newSecret();
      expect(await payee.lookupInvoice(hash)).toBeNull();
      expect(await payer.lookupPayment(hash)).toBeNull();
    });
  });
}
