// Nostr Wallet Connect (NIP-47) backend, for gateways that run on Alby Hub instead of their own LND,
// and for the public faucet.nwc.dev sandbox used in CI and hosted demos.
// Contract: implements LightningBackend. Hold invoices are an Alby extension to NIP-47, so
// `capabilities().holdInvoices` reports what the connected wallet actually advertises and the escrow
// engine refuses to start without it.
// Limit to know about: NIP-47 pay_invoice carries no fee limit, so `maxFeeSat` cannot be enforced
// up front here; the wallet's own policy applies and the fee paid is reported back.
// Callers: apps/gateway composition root (LIGHTNING_BACKEND=nwc), agent wallet links, the contract test suite.
import { NWCClient, type Nip47Transaction } from "@getalby/sdk";
import { AppError } from "@melax/core";
import { preimageMatches } from "./invoice.ts";
import type { Balance, Capabilities, Invoice, InvoiceState, InvoiceStatus, LightningBackend, PayOutcome } from "./types.ts";

function mapState(tx: Nip47Transaction): InvoiceState {
  if (tx.state === "settled") return "settled";
  if (tx.state === "accepted") return "accepted";
  if (tx.state === "failed") return "cancelled";
  return "open";
}

function codeOf(e: unknown): string {
  return String((e as { code?: unknown })?.code ?? "");
}

function isTimeout(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? "";
  const msg = e instanceof Error ? e.message : "";
  return /timeout/i.test(name) || /timeout|timed out|relay|publish|network|connect/i.test(msg);
}

export class NwcBackend implements LightningBackend {
  readonly client: NWCClient;
  private readonly unsubs: Array<() => void> = [];

  constructor(nostrWalletConnectUrl: string) {
    if (!nostrWalletConnectUrl.startsWith("nostr+walletconnect://")) throw new AppError("BAD_INPUT", "not a wallet connect string");
    this.client = new NWCClient({ nostrWalletConnectUrl });
  }

  /** A throwaway wallet with fake sats on the public NWC sandbox. For tests and demos only. */
  static async fromFaucet(balanceSat: number): Promise<NwcBackend> {
    const r = await fetch(`https://faucet.nwc.dev?balance=${balanceSat}`, { method: "POST", signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new AppError("UPSTREAM", `NWC faucet answered ${r.status}`);
    return new NwcBackend((await r.text()).trim());
  }

  get lightningAddress(): string | undefined {
    return this.client.lud16;
  }

  async capabilities(): Promise<Capabilities> {
    const info = await this.client.getInfo();
    const methods = new Set<string>(info.methods as string[]);
    return {
      backend: "nwc",
      holdInvoices: methods.has("make_hold_invoice") && methods.has("settle_hold_invoice") && methods.has("cancel_hold_invoice"),
      network: info.network === "mainnet" ? "bitcoin" : info.network,
      pubkey: info.pubkey,
      alias: info.alias,
    };
  }

  async makeInvoice(req: { amountSat: number; memo?: string; descriptionHash?: string; expirySec?: number }): Promise<Invoice> {
    const tx = await this.client.makeInvoice({
      amount: req.amountSat * 1000,
      description: req.descriptionHash ? undefined : req.memo,
      description_hash: req.descriptionHash,
      expiry: req.expirySec ?? 3600,
    });
    return { paymentHash: tx.payment_hash, bolt11: tx.invoice, amountSat: req.amountSat, expiresAt: (tx.expires_at || Math.floor(Date.now() / 1000) + (req.expirySec ?? 3600)) * 1000 };
  }

  async makeHoldInvoice(req: { amountSat: number; paymentHash: string; memo?: string; expirySec?: number }): Promise<Invoice> {
    const tx = await this.client.makeHoldInvoice({ amount: req.amountSat * 1000, payment_hash: req.paymentHash, description: req.memo, expiry: req.expirySec ?? 3600 });
    return { paymentHash: req.paymentHash, bolt11: tx.invoice, amountSat: req.amountSat, expiresAt: (tx.expires_at || Math.floor(Date.now() / 1000) + (req.expirySec ?? 3600)) * 1000 };
  }

  async settle(preimageHex: string): Promise<void> {
    await this.client.settleHoldInvoice({ preimage: preimageHex });
  }

  async cancel(paymentHash: string): Promise<boolean> {
    try {
      await this.client.cancelHoldInvoice({ payment_hash: paymentHash });
      return true;
    } catch (e) {
      if (codeOf(e) === "NOT_FOUND") return false; // nobody has paid it yet; see types.ts
      throw new AppError("UPSTREAM", "wallet cancel failed: " + (e instanceof Error ? e.message : ""));
    }
  }

  async pay(req: { bolt11: string; maxFeeSat: number; timeoutSec?: number }): Promise<PayOutcome> {
    try {
      const r = await this.client.payInvoice({ invoice: req.bolt11 });
      return { status: "succeeded", preimage: r.preimage, feeSat: Math.ceil((r.fees_paid ?? 0) / 1000) };
    } catch (e) {
      // A wallet error with a code is a definite answer. Silence or a relay problem is not.
      if (codeOf(e) && !isTimeout(e)) return { status: "failed", reason: codeOf(e) + ": " + (e instanceof Error ? e.message : "") };
      return { status: "pending" };
    }
  }

  async lookupInvoice(paymentHash: string): Promise<InvoiceStatus | null> {
    try {
      const tx = await this.client.lookupInvoice({ payment_hash: paymentHash });
      return { paymentHash: tx.payment_hash, state: mapState(tx), amountSat: Math.floor(tx.amount / 1000), settledAt: tx.settled_at ? tx.settled_at * 1000 : undefined };
    } catch (e) {
      if (codeOf(e) === "NOT_FOUND") return null;
      throw new AppError("UPSTREAM", "wallet lookup failed: " + (e instanceof Error ? e.message : ""));
    }
  }

  async lookupPayment(paymentHash: string): Promise<PayOutcome | null> {
    let tx: Nip47Transaction;
    try {
      tx = await this.client.lookupInvoice({ payment_hash: paymentHash });
    } catch (e) {
      if (codeOf(e) === "NOT_FOUND") return null;
      throw new AppError("UPSTREAM", "wallet lookup failed: " + (e instanceof Error ? e.message : ""));
    }
    if (tx.type !== "outgoing") return null;
    if (tx.state === "settled" && preimageMatches(tx.preimage, paymentHash)) return { status: "succeeded", preimage: tx.preimage, feeSat: Math.ceil((tx.fees_paid ?? 0) / 1000) };
    if (tx.state === "failed") return { status: "failed", reason: "failed" };
    return { status: "pending" };
  }

  subscribeInvoices(onUpdate: (s: InvoiceStatus) => void): () => void {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void this.client
      .subscribeNotifications(
        (n) => {
          if (n.notification_type === "payment_sent") return;
          const tx = n.notification;
          onUpdate({ paymentHash: tx.payment_hash, state: mapState(tx), amountSat: Math.floor(tx.amount / 1000), settledAt: tx.settled_at ? tx.settled_at * 1000 : undefined });
        },
        ["payment_received", "hold_invoice_accepted"],
      )
      .then((unsub) => {
        if (cancelled) unsub();
        else stop = unsub;
      })
      .catch(() => undefined);
    const off = () => {
      cancelled = true;
      stop?.();
    };
    this.unsubs.push(off);
    return off;
  }

  async balance(): Promise<Balance> {
    const b = await this.client.getBalance();
    return { spendableSat: Math.floor(b.balance / 1000), receivableSat: null, pendingSat: 0 };
  }

  async close(): Promise<void> {
    for (const u of this.unsubs) u();
    this.client.close();
  }
}
