import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppError } from "@melax/core";
import {
  VOUCHER_ALPHABET,
  _q30,
  deriveKey,
  deriveUserKey,
  formatVoucherCode,
  hashPin,
  isWeakPin,
  newPayCode,
  newVoucherCode,
  normalizeVoucherCode,
  open,
  phoneLookupKey,
  randomAlias,
  seal,
  verifyPin,
  voucherCodeHash,
  voucherKey,
} from "../src/index.ts";

const pepper = randomBytes(32);

describe("PIN", () => {
  it("verifies the right PIN and nothing else", async () => {
    const h = await hashPin("48213", pepper);
    expect(await verifyPin("48213", h, pepper)).toBe(true);
    expect(await verifyPin("48214", h, pepper)).toBe(false);
    expect(await verifyPin("", h, pepper)).toBe(false);
  });
  it("a stolen database is not enough: the same PIN fails without the pepper", async () => {
    const h = await hashPin("48213", pepper);
    expect(await verifyPin("48213", h, randomBytes(32))).toBe(false);
  });
  it("two users with the same PIN get different hashes", async () => {
    expect(await hashPin("48213", pepper)).not.toBe(await hashPin("48213", pepper));
  });
  it("a corrupted or foreign hash is a plain 'no', never a crash", async () => {
    for (const bad of ["", "argon2id$1$2", "bcrypt$abc", "argon2id$19456$2$1$zz$zz"]) {
      expect(await verifyPin("48213", bad, pepper)).toBe(false);
    }
  });
  it("refuses PINs a thief would try first", () => {
    for (const weak of ["00000", "11111", "12345", "54321", "01234", "98765", "12121", "24680", "13579", "1234", "123456", "abcde", "77123"]) {
      expect(isWeakPin(weak, "+221771234567"), weak).toBe(true);
    }
    for (const ok of ["48213", "90417", "30682"]) expect(isWeakPin(ok, "+221771234567"), ok).toBe(false);
  });
  it("refuses a PIN that is just part of the owner's phone number", () => {
    expect(isWeakPin("34567", "+221771234567")).toBe(true);
    expect(isWeakPin("71234", "+221771234567")).toBe(true);
  });
});

describe("keys and sealing", () => {
  it("phone lookup keys are stable per number and useless without the key", () => {
    const k = randomBytes(32);
    expect(phoneLookupKey("+221771234567", k).equals(phoneLookupKey("+221771234567", k))).toBe(true);
    expect(phoneLookupKey("+221771234567", k).equals(phoneLookupKey("+221771234568", k))).toBe(false);
    expect(phoneLookupKey("+221771234567", k).equals(phoneLookupKey("+221771234567", randomBytes(32)))).toBe(false);
  });
  it("seals and opens, and each seal of the same text differs", () => {
    const key = deriveUserKey(pepper, randomBytes(16));
    const a = seal(key, Buffer.from("proof-secret"));
    const b = seal(key, Buffer.from("proof-secret"));
    expect(a.equals(b)).toBe(false);
    expect(open(key, a).toString()).toBe("proof-secret");
  });
  it("opening fails loudly on a wrong key, a flipped bit, a truncation or the wrong owner tag", () => {
    const salt = randomBytes(16);
    const key = deriveUserKey(pepper, salt);
    const sealed = seal(key, Buffer.from("proof-secret"), "user:usr_1");
    expect(() => open(deriveUserKey(pepper, randomBytes(16)), sealed, "user:usr_1")).toThrow(AppError);
    expect(() => open(deriveUserKey(randomBytes(32), salt), sealed, "user:usr_1")).toThrow(AppError);
    const flipped = Buffer.from(sealed);
    flipped[flipped.length - 1]! ^= 1;
    expect(() => open(key, flipped, "user:usr_1")).toThrow(AppError);
    expect(() => open(key, sealed.subarray(0, 10), "user:usr_1")).toThrow(AppError);
    expect(() => open(key, sealed, "user:usr_2")).toThrow(AppError);
  });
  it("derives a different key for each purpose from one pepper, the same one every time", () => {
    const a = deriveKey(pepper, "pin");
    expect(a).toHaveLength(32);
    expect(a.equals(deriveKey(pepper, "pin"))).toBe(true);
    expect(a.equals(deriveKey(pepper, "phone"))).toBe(false);
    expect(a.equals(deriveKey(randomBytes(32), "pin"))).toBe(false);
    expect(a.equals(pepper)).toBe(false);
    expect(() => deriveKey(randomBytes(16), "pin")).toThrow(AppError);
    expect(() => deriveKey(pepper, "")).toThrow(AppError);
  });
});

describe("voucher codes", () => {
  it("are 16 characters from a 30-symbol alphabet with no lookalikes", () => {
    expect(VOUCHER_ALPHABET).toHaveLength(30);
    for (const c of "01ILOU") expect(VOUCHER_ALPHABET).not.toContain(c);
    for (let i = 0; i < 200; i++) {
      const code = newVoucherCode();
      expect(code).toMatch(/^[A-HJKMNP-TV-Z2-9]{16}$/);
      expect(normalizeVoucherCode(code)).toBe(code);
    }
  });
  it("accepts the code the way people type it: lower case, hyphens, spaces", () => {
    const code = newVoucherCode();
    const shown = formatVoucherCode(code);
    expect(shown).toMatch(/^.{4}-.{4}-.{4}-.{4}$/);
    expect(normalizeVoucherCode(shown.toLowerCase())).toBe(code);
    expect(normalizeVoucherCode(" " + shown.replace(/-/g, " ") + " ")).toBe(code);
  });
  it("catches every single mistyped character and every swap of two neighbours", () => {
    for (let round = 0; round < 20; round++) {
      const code = newVoucherCode();
      for (let i = 0; i < 16; i++) {
        for (const c of VOUCHER_ALPHABET) {
          if (c === code[i]) continue;
          const typo = code.slice(0, i) + c + code.slice(i + 1);
          expect(() => normalizeVoucherCode(typo)).toThrow(AppError);
        }
        if (i < 15 && code[i] !== code[i + 1]) {
          const swapped = code.slice(0, i) + code[i + 1] + code[i] + code.slice(i + 2);
          expect(() => normalizeVoucherCode(swapped)).toThrow(AppError);
        }
      }
    }
  });
  it("proof by enumeration: the check symbol's quasigroup is a Latin square and anti-symmetric", () => {
    // Latin square => any single wrong character changes the result.
    // (c*x)*y = (c*y)*x only when x = y => any swap of two neighbours changes the result.
    for (let x = 0; x < 30; x++) {
      expect(new Set(Array.from({ length: 30 }, (_, y) => _q30(x, y))).size).toBe(30);
      expect(new Set(Array.from({ length: 30 }, (_, y) => _q30(y, x))).size).toBe(30);
    }
    let misses = 0;
    for (let c = 0; c < 30; c++) for (let x = 0; x < 30; x++) for (let y = 0; y < 30; y++) if (x !== y && _q30(_q30(c, x), y) === _q30(_q30(c, y), x)) misses++;
    expect(misses).toBe(0);
  });
  it("refuses wrong lengths and characters outside the alphabet", () => {
    for (const bad of ["", "ABCD", "K7MP-2XQR-9TWB-4HN", "K7MP-2XQR-9TWB-4HNCC", "K7MP-2XQR-9TWB-4HN0", "K7MP-2XQR-9TWB-4HN!"]) {
      expect(() => normalizeVoucherCode(bad)).toThrow(AppError);
    }
  });
  it("derives the same key from the same code, a different key from a different code", () => {
    const a = newVoucherCode();
    const b = newVoucherCode();
    const ka = voucherKey(a);
    expect(voucherKey(a).pubHex).toBe(ka.pubHex);
    expect(voucherKey(b).pubHex).not.toBe(ka.pubHex);
    expect(ka.pubHex).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(ka.privHex).toMatch(/^[0-9a-f]{64}$/);
    expect(voucherCodeHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(voucherCodeHash(a)).not.toContain(ka.privHex.slice(0, 16));
  });
});

describe("aliases and pay codes", () => {
  it("aliases are valid Lightning address local parts", () => {
    for (let i = 0; i < 300; i++) expect(randomAlias()).toMatch(/^[a-z]+-[a-z]+[0-9]{2}$/);
  });
  it("pay codes are 6 digits and well spread", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const c = newPayCode();
      expect(c).toMatch(/^[0-9]{6}$/);
      seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(480);
  });
});
