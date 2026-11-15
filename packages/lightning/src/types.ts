// The one Lightning interface the gateway codes against. Two implementations: LND over REST (local
// stack, native hold invoices) and NWC (Alby Hub; hold invoices are an Alby extension to NIP-47).
// Contract notes:
//   - amounts are whole sats; millisats exist only inside the adapters;
//   - `pay` never throws for a payment that may have left: it returns "pending" and the caller
//     resolves it later with `lookupPayment(hash)`. Retrying a pending payment is forbidden;
//   - `settle` releases held sats to us, `cancel` returns them to the payer.
// Callers: apps/escrow (hold invoices), apps/lnurl (description-hash invoices), apps/gateway (mint funding).

export type InvoiceState = "open" | "accepted" | "settled" | "cancelled";

export interface Invoice {
  paymentHash: string;
  bolt11: string;
  amountSat: number;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface InvoiceStatus {
  paymentHash: string;
  state: InvoiceState;
  amountSat: number;
  /** Epoch milliseconds, when settled. */
  settledAt?: number;
}

export type PayOutcome =
  | { status: "succeeded"; preimage: string; feeSat: number }
  | { status: "failed"; reason: string }
  /** In flight or unknown. Funds stay reserved until `lookupPayment` gives a final answer. */
  | { status: "pending" };

export interface Capabilities {
  backend: "lnd" | "nwc";
  holdInvoices: boolean;
  network: string;
  pubkey: string;
  alias: string;
}

export interface Balance {
  /** Sats we can send right now. */
  spendableSat: number;
  /** Sats we can receive right now, when the backend can tell. */
  receivableSat: number | null;
  /** Sats in HTLCs that are neither ours nor the counterparty's yet. */
  pendingSat: number;
}

export interface LightningBackend {
  capabilities(): Promise<Capabilities>;
  makeInvoice(req: { amountSat: number; memo?: string; descriptionHash?: string; expirySec?: number }): Promise<Invoice>;
  /**
   * `cltvExpiry` is the block delta of the final hop: it bounds how long a payment can stay held. LND
   * cancels a held payment on its own about 18 to 21 blocks before that delta runs out (measured with
   * scripts/probe/hold-cltv-probe.ts: LND's default of 80 kept a payment held 65 blocks). NWC has no
   * such field; the connected wallet's own policy applies.
   */
  makeHoldInvoice(req: { amountSat: number; paymentHash: string; memo?: string; expirySec?: number; cltvExpiry?: number }): Promise<Invoice>;
  settle(preimageHex: string): Promise<void>;
  /**
   * Returns held sats to the payer. Resolves true when the invoice is now cancelled.
   * Resolves false when the backend had nothing to cancel: on NWC (measured on faucet.nwc.dev) an
   * invoice nobody has paid yet cannot be cancelled and stays payable until it expires. Callers must
   * therefore keep watching a cancelled trade's invoice until expiry and cancel again if it gets paid late.
   */
  cancel(paymentHash: string): Promise<boolean>;
  pay(req: { bolt11: string; maxFeeSat: number; timeoutSec?: number }): Promise<PayOutcome>;
  lookupInvoice(paymentHash: string): Promise<InvoiceStatus | null>;
  lookupPayment(paymentHash: string): Promise<PayOutcome | null>;
  /** Push updates (settled, and accepted for hold invoices). Returns an unsubscribe function. Best effort: callers also poll. */
  subscribeInvoices(onUpdate: (s: InvoiceStatus) => void): () => void;
  balance(): Promise<Balance>;
  close(): Promise<void>;
}
