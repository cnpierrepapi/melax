import { describe, expect, it } from "vitest";
import { AppError } from "@melax/core";
import { checkInvoice, decodeInvoice, feeCapSat } from "../src/index.ts";
import vectors from "./fixtures/bolt11-vectors.json" with { type: "json" };

// The invoices below are the worked examples from the BOLT 11 specification, not ones we generated.
const HASH = "0001020304050607080900010203040506070809000102030405060708090102";
const ISSUED_AT = 1_496_314_658_000;

describe("decodeInvoice against the BOLT 11 specification examples", () => {
  it("reads amount, hash, expiry, description and network", () => {
    const d = decodeInvoice(vectors.coffee250kSat60s);
    expect(d).toMatchObject({ amountSat: 250_000, amountMsat: 250_000_000, paymentHash: HASH, network: "bitcoin", description: "1 cup coffee" });
    expect(d.createdAt).toBe(ISSUED_AT);
    expect(d.expiresAt).toBe(ISSUED_AT + 60_000);
  });
  it("reports an invoice with no amount as amountless, never as zero", () => {
    const d = decodeInvoice(vectors.donationAnyAmount);
    expect(d.amountSat).toBeNull();
    expect(d.expiresAt).toBe(ISSUED_AT + 3_600_000); // default expiry is one hour
  });
  it("reads a description hash", () => {
    const d = decodeInvoice(vectors.hashed2000kSat);
    expect(d.amountSat).toBe(2_000_000);
    expect(d.descriptionHash).toBe("3925b6f67e2c340036ed12093dd44e0368df1b6ea26c53dbe4811f58fd5db8c1");
  });
  it("tells testnet from mainnet", () => {
    expect(decodeInvoice(vectors.testnet2000kSat).network).toBe("testnet");
  });
  it("accepts upper case and a lightning: prefix, as QR codes carry them", () => {
    expect(decodeInvoice("LIGHTNING:" + vectors.coffee250kSat60s.toUpperCase()).paymentHash).toBe(HASH);
  });
  it("refuses the specification's invalid examples and plain junk", () => {
    for (const bad of [vectors.invalidTooShort, vectors.invalidMultiplier, "", "hello", "lnbc1", vectors.coffee250kSat60s.slice(0, -3) + "qqq"]) {
      expect(() => decodeInvoice(bad), bad.slice(0, 20)).toThrow(AppError);
    }
  });
});

describe("checkInvoice: what must hold before we pay", () => {
  const now = ISSUED_AT + 10_000;
  it("passes a fresh invoice on the right network for the expected amount", () => {
    expect(checkInvoice(vectors.coffee250kSat60s, { network: "bitcoin", now, expectAmountSat: 250_000 }).amountSat).toBe(250_000);
  });
  it("refuses an expired invoice, and one about to expire", () => {
    expect(() => checkInvoice(vectors.coffee250kSat60s, { network: "bitcoin", now: ISSUED_AT + 61_000 })).toThrow(expect.objectContaining({ code: "EXPIRED" }));
    expect(() => checkInvoice(vectors.coffee250kSat60s, { network: "bitcoin", now: ISSUED_AT + 55_000, minRemainingMs: 10_000 })).toThrow(expect.objectContaining({ code: "EXPIRED" }));
  });
  it("refuses the wrong network", () => {
    expect(() => checkInvoice(vectors.coffee250kSat60s, { network: "regtest", now })).toThrow(expect.objectContaining({ code: "BAD_INPUT" }));
    expect(() => checkInvoice(vectors.testnet2000kSat, { network: "bitcoin", now })).toThrow(expect.objectContaining({ code: "BAD_INPUT" }));
  });
  it("refuses an amount that is not the one agreed", () => {
    expect(() => checkInvoice(vectors.coffee250kSat60s, { network: "bitcoin", now, expectAmountSat: 250_001 })).toThrow(expect.objectContaining({ code: "BAD_AMOUNT" }));
  });
  it("refuses an invoice without an amount unless the caller opted in", () => {
    expect(() => checkInvoice(vectors.donationAnyAmount, { network: "bitcoin", now })).toThrow(expect.objectContaining({ code: "BAD_AMOUNT" }));
    expect(checkInvoice(vectors.donationAnyAmount, { network: "bitcoin", now, allowAmountless: true }).amountSat).toBeNull();
  });
  it("refuses an amount above the caller's ceiling", () => {
    expect(() => checkInvoice(vectors.coffee250kSat60s, { network: "bitcoin", now, maxAmountSat: 100_000 })).toThrow(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
  });
});

describe("fee cap", () => {
  it("is 5 sats or half a percent, whichever is larger", () => {
    expect(feeCapSat(1)).toBe(5);
    expect(feeCapSat(1_000)).toBe(5);
    expect(feeCapSat(1_001)).toBe(6);
    expect(feeCapSat(10_000)).toBe(50);
    expect(feeCapSat(123_456)).toBe(618);
  });
});
