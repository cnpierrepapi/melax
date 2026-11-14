// BOLT 11 decoding and the checks that run before any invoice is trusted or paid.
// Contract: decodeInvoice throws BAD_INPUT on anything malformed (bad checksum included);
// checkInvoice adds the business rules (network, expiry, amount). Neither does I/O.
// Callers: LND/NWC adapters, the pay-invoice service, LNURL resolver, escrow engine.
import { createHash } from "node:crypto";
import { bech32 } from "@scure/base";
import { decode as lightDecode } from "light-bolt11-decoder";
import { AppError } from "@melax/core";

export type Network = "bitcoin" | "testnet" | "signet" | "regtest";

export interface DecodedInvoice {
  bolt11: string;
  network: Network;
  /** Null when the invoice leaves the amount to the payer. */
  amountSat: number | null;
  amountMsat: number | null;
  paymentHash: string;
  description: string | null;
  descriptionHash: string | null;
  createdAt: number;
  expiresAt: number;
}

const PREFIX_NETWORK: Array<[string, Network]> = [
  ["lnbcrt", "regtest"],
  ["lntbs", "signet"],
  ["lntb", "testnet"],
  ["lnbc", "bitcoin"],
];

export function decodeInvoice(raw: string): DecodedInvoice {
  if (typeof raw !== "string") throw new AppError("BAD_INPUT", "invoice is not text");
  let s = raw.trim().toLowerCase();
  if (s.startsWith("lightning:")) s = s.slice(10);
  const hit = PREFIX_NETWORK.find(([p]) => s.startsWith(p));
  if (!hit || s.length < 100 || s.length > 4000) throw new AppError("BAD_INPUT", "not a Lightning invoice");
  try {
    // Checksum first: the section decoder below does not verify it.
    bech32.decode(s as `${string}1${string}`, 4000);
    const d = lightDecode(s);
    const get = (name: string): unknown => (d.sections as Array<{ name: string; value?: unknown }>).find((x) => x.name === name)?.value;
    const paymentHash = get("payment_hash");
    const timestamp = get("timestamp");
    if (typeof paymentHash !== "string" || !/^[0-9a-f]{64}$/.test(paymentHash)) throw new Error("no payment hash");
    if (typeof timestamp !== "number") throw new Error("no timestamp");
    const amountRaw = get("amount");
    let amountMsat: number | null = null;
    if (amountRaw !== undefined) {
      const big = BigInt(amountRaw as string);
      if (big <= 0n || big > 2_100_000_000_000_000_000n) throw new Error("amount out of range");
      amountMsat = Number(big);
      if (amountMsat % 1000 !== 0) throw new Error("sub-satoshi amounts are not supported");
    }
    const expiry = typeof get("expiry") === "number" ? (get("expiry") as number) : 3600;
    const description = get("description");
    const descriptionHash = get("description_hash");
    return {
      bolt11: s,
      network: hit[1],
      amountMsat,
      amountSat: amountMsat === null ? null : amountMsat / 1000,
      paymentHash,
      description: typeof description === "string" ? description : null,
      descriptionHash: typeof descriptionHash === "string" ? descriptionHash : null,
      createdAt: timestamp * 1000,
      expiresAt: (timestamp + expiry) * 1000,
    };
  } catch (e) {
    throw new AppError("BAD_INPUT", "invoice could not be decoded: " + (e instanceof Error ? e.message : "unknown"));
  }
}

export interface InvoiceRules {
  network: string;
  now: number;
  expectAmountSat?: number;
  maxAmountSat?: number;
  allowAmountless?: boolean;
  /** Refuse invoices with less than this long to live. Default 30 s. */
  minRemainingMs?: number;
  expectPaymentHash?: string;
}

/** Decode and enforce the pre-payment rules. Returns the decoded invoice or throws an AppError. */
export function checkInvoice(bolt11: string, rules: InvoiceRules): DecodedInvoice {
  const d = decodeInvoice(bolt11);
  if (d.network !== rules.network) throw new AppError("BAD_INPUT", `invoice is for ${d.network}, this gateway runs on ${rules.network}`);
  if (d.expiresAt - rules.now < (rules.minRemainingMs ?? 30_000)) throw new AppError("EXPIRED", "invoice has expired or is about to");
  if (d.amountSat === null) {
    if (!rules.allowAmountless) throw new AppError("BAD_AMOUNT", "invoice has no amount");
  } else {
    if (rules.expectAmountSat !== undefined && d.amountSat !== rules.expectAmountSat) throw new AppError("BAD_AMOUNT", "invoice amount differs from the agreed amount");
    if (rules.maxAmountSat !== undefined && d.amountSat > rules.maxAmountSat) throw new AppError("LIMIT_EXCEEDED", "invoice amount is above the allowed maximum");
  }
  if (rules.expectPaymentHash !== undefined && d.paymentHash !== rules.expectPaymentHash) throw new AppError("BAD_INPUT", "invoice payment hash differs");
  return d;
}

/** The most we let any payment cost in routing fees: 5 sats or 0.5 %, whichever is larger. */
export function feeCapSat(amountSat: number): number {
  return Math.max(5, Math.ceil(amountSat * 0.005));
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** True when `preimageHex` is the 32-byte preimage of `paymentHash`. */
export function preimageMatches(preimageHex: string, paymentHash: string): boolean {
  return /^[0-9a-f]{64}$/i.test(preimageHex) && sha256Hex(Buffer.from(preimageHex, "hex")) === paymentHash.toLowerCase();
}
