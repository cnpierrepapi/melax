import { describe, expect, it } from "vitest";
import {
  AppError,
  FakeClock,
  createLogger,
  fcfaToSats,
  formatFcfa,
  formatSats,
  maskPhone,
  newId,
  normalizePhone,
  redact,
  satsToFcfa,
  toSafeInt,
} from "../src/index.ts";

describe("phone numbers", () => {
  it("normalises the ways a Senegalese number is typed", () => {
    for (const raw of ["771234567", "77 123 45 67", "+221771234567", "00221771234567", "221771234567", "77-123-45-67"]) {
      expect(normalizePhone(raw)).toBe("+221771234567");
    }
  });
  it("accepts every mobile prefix in use and refuses landlines and junk", () => {
    for (const p of ["70", "75", "76", "77", "78"]) expect(normalizePhone(p + "1234567")).toBe("+221" + p + "1234567");
    for (const bad of ["331234567", "7712345", "77123456789", "abc", "", "+22177123456", "79123456a"]) {
      expect(() => normalizePhone(bad)).toThrow(AppError);
    }
  });
  it("keeps foreign numbers in E.164 so the diaspora can be a guardian or payer", () => {
    expect(normalizePhone("+33612345678")).toBe("+33612345678");
    expect(() => normalizePhone("+1")).toThrow(AppError);
  });
  it("masks all but the first two and last two local digits", () => {
    expect(maskPhone("+221771234567")).toBe("77*****67");
    expect(maskPhone("+33612345678")).toBe("+33*******78");
  });
});

describe("money", () => {
  const rate = 61_850_000; // FCFA per BTC
  it("converts FCFA to whole sats and back without drifting more than one franc", () => {
    for (const fcfa of [1, 25, 100, 500, 1_000, 5_000, 250_000]) {
      const sats = fcfaToSats(fcfa, rate);
      expect(Number.isInteger(sats)).toBe(true);
      expect(Math.abs(satsToFcfa(sats, rate) - fcfa)).toBeLessThanOrEqual(1);
    }
  });
  it("refuses fractions, negatives, NaN and a missing rate", () => {
    for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => fcfaToSats(bad, rate)).toThrow(AppError);
      expect(() => satsToFcfa(bad, rate)).toThrow(AppError);
    }
    expect(() => fcfaToSats(100, 0)).toThrow(AppError);
  });
  it("formats with plain spaces only, because GSM-7 has no thin space", () => {
    expect(formatFcfa(1250000)).toBe("1 250 000 F");
    expect(formatFcfa(500)).toBe("500 F");
    expect(formatSats(20210)).toBe("20 210 sats");
    expect(formatSats(1)).toBe("1 sat");
  });
  it("toSafeInt refuses anything a JS number cannot hold exactly", () => {
    expect(toSafeInt("42")).toBe(42);
    expect(toSafeInt(42n)).toBe(42);
    expect(() => toSafeInt("9007199254740993")).toThrow(AppError);
    expect(() => toSafeInt("1.5")).toThrow(AppError);
    expect(() => toSafeInt("abc")).toThrow(AppError);
  });
});

describe("ids and clock", () => {
  it("ids are unique, prefixed and sort by creation time", () => {
    const clock = new FakeClock(1_700_000_000_000);
    const a = newId("trd", clock);
    clock.advance(5);
    const b = newId("trd", clock);
    expect(a.startsWith("trd_")).toBe(true);
    expect(a < b).toBe(true);
    const many = new Set(Array.from({ length: 2000 }, () => newId("x", clock)));
    expect(many.size).toBe(2000);
  });
});

describe("log redaction", () => {
  const secrets = {
    phone: "+221771234567",
    local: "771234567",
    pin: "48213",
    code: "K7MP-2XQR-9TWB-4HNC",
    invoice: "lnbcrt500u1p5qqqqqpp5w3ksl9mz0k6c0c7xk6u4a0xhc6l0ky0kqk8u3t6k5r7z4m6s8sdqqcqzzsxqyz5vqsp5",
    token: "cashuBo2FteCJodHRwOi8vbG9jYWxob3N0OjMzMzhhdWNzYXRhdIGiYWlIAJofKTJT5B5hcIGkYWEYQGFzeEA",
    nsec: "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5",
    nwc: "nostr+walletconnect://abc?relay=wss://r&secret=deadbeef",
  };
  it("never lets a sensitive value through, whether it sits under a known key or inside free text", () => {
    const out = JSON.stringify(
      redact({
        phone: secrets.phone,
        pin: secrets.pin,
        note: `user ${secrets.phone} (${secrets.local}) redeemed ${secrets.code} and paid ${secrets.invoice}`,
        nested: { voucherCode: secrets.code, bolt11: secrets.invoice, deep: [secrets.token, { k: secrets.nsec }, secrets.nwc] },
        body: "Votre code: " + secrets.code,
      }),
    );
    for (const [name, value] of Object.entries(secrets)) {
      if (name === "pin") continue; // a bare 5-digit number is only recognisable by its key
      expect(out, name).not.toContain(value);
    }
    expect(out).not.toContain('"48213"');
  });
  it("keeps what an operator needs to debug: ids, amounts, states", () => {
    const out = redact({ userId: "usr_01", amountSat: 2500, state: "settled", paymentHash: "ab".repeat(32) });
    expect(out).toEqual({ userId: "usr_01", amountSat: 2500, state: "settled", paymentHash: "ab".repeat(32) });
  });
  it("the logger writes one JSON line per event through the redactor", () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l), clock: new FakeClock(1000) });
    log.info("sms.sent", { to: secrets.phone, body: "PIN " + secrets.pin });
    log.error("pay.failed", { err: new Error("route to " + secrets.invoice + " failed") });
    expect(lines).toHaveLength(2);
    const joined = lines.join("\n");
    expect(joined).not.toContain(secrets.phone);
    expect(joined).not.toContain(secrets.pin);
    expect(joined).not.toContain(secrets.invoice);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "info", event: "sms.sent", ts: 1000 });
  });
});
