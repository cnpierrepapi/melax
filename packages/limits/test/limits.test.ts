import { describe, expect, it } from "vitest";
import { DAY, HOUR, MINUTE } from "@melax/core";
import { LARGE_WITHDRAWAL_FCFA, TIERS, WITHDRAWAL_DELAY_MS, checkSpend, isPinLocked, onPinFailure, onPinSuccess, tierFor, withdrawalDelayMs } from "../src/index.ts";

describe("tiers", () => {
  it("a new account starts small and grows with age and guardians", () => {
    expect(tierFor({ accountAgeMs: 0, guardians: 0 })).toBe(0);
    expect(tierFor({ accountAgeMs: 6 * DAY, guardians: 0 })).toBe(0);
    expect(tierFor({ accountAgeMs: 7 * DAY, guardians: 0 })).toBe(1);
    expect(tierFor({ accountAgeMs: 1 * DAY, guardians: 2 })).toBe(1);
    expect(tierFor({ accountAgeMs: 30 * DAY, guardians: 1 })).toBe(1);
    expect(tierFor({ accountAgeMs: 30 * DAY, guardians: 2 })).toBe(2);
    expect(TIERS[0].perTxFcfa).toBeLessThan(TIERS[1].perTxFcfa);
    expect(TIERS[1].perMonthFcfa).toBeLessThan(TIERS[2].perMonthFcfa);
  });
});

describe("spend limits", () => {
  const base = { tier: 0 as const, spentTodayFcfa: 0, spentMonthFcfa: 0, newRecipient: false };
  it("allows a payment inside every limit, exactly at the limit too", () => {
    expect(checkSpend({ ...base, amountFcfa: 500 })).toEqual({ ok: true });
    expect(checkSpend({ ...base, amountFcfa: TIERS[0].perTxFcfa })).toEqual({ ok: true });
    expect(checkSpend({ ...base, amountFcfa: 1000, spentTodayFcfa: TIERS[0].perDayFcfa - 1000 })).toEqual({ ok: true });
  });
  it("refuses one franc over the per-payment limit and says how much is allowed", () => {
    expect(checkSpend({ ...base, amountFcfa: TIERS[0].perTxFcfa + 1 })).toEqual({ ok: false, reason: "PER_TX", allowedFcfa: TIERS[0].perTxFcfa });
  });
  it("refuses when the day or the month would overflow, with what is left", () => {
    expect(checkSpend({ ...base, amountFcfa: 5000, spentTodayFcfa: TIERS[0].perDayFcfa - 4999 })).toEqual({ ok: false, reason: "PER_DAY", allowedFcfa: 4999 });
    expect(checkSpend({ ...base, amountFcfa: 5000, spentMonthFcfa: TIERS[0].perMonthFcfa - 100 })).toEqual({ ok: false, reason: "PER_MONTH", allowedFcfa: 100 });
    expect(checkSpend({ ...base, amountFcfa: 1, spentTodayFcfa: TIERS[0].perDayFcfa })).toEqual({ ok: false, reason: "PER_DAY", allowedFcfa: 0 });
  });
  it("caps the first payment to someone new", () => {
    expect(checkSpend({ ...base, amountFcfa: TIERS[0].newRecipientFcfa, newRecipient: true })).toEqual({ ok: true });
    expect(checkSpend({ ...base, amountFcfa: TIERS[0].newRecipientFcfa + 1, newRecipient: true })).toEqual({ ok: false, reason: "NEW_RECIPIENT", allowedFcfa: TIERS[0].newRecipientFcfa });
  });
  it("refuses nonsense amounts", () => {
    for (const bad of [0, -5, 1.5, Number.NaN]) expect(checkSpend({ ...base, amountFcfa: bad }).ok).toBe(false);
  });
});

describe("PIN lockout", () => {
  const t0 = 1_000_000;
  it("four wrong tries lock nothing, the fifth locks for 15 minutes", () => {
    let s = { failCount: 0, lockedUntil: 0 };
    for (let i = 0; i < 4; i++) s = onPinFailure(s, t0);
    expect(isPinLocked(s, t0)).toBe(false);
    s = onPinFailure(s, t0);
    expect(isPinLocked(s, t0)).toBe(true);
    expect(s.lockedUntil).toBe(t0 + 15 * MINUTE);
    expect(isPinLocked(s, t0 + 15 * MINUTE - 1)).toBe(true);
    expect(isPinLocked(s, t0 + 15 * MINUTE)).toBe(false);
  });
  it("five more wrong tries after the first lock mean 24 hours", () => {
    let s = { failCount: 0, lockedUntil: 0 };
    for (let i = 0; i < 5; i++) s = onPinFailure(s, t0);
    const t1 = s.lockedUntil + 1;
    for (let i = 0; i < 4; i++) s = onPinFailure(s, t1);
    expect(isPinLocked(s, t1)).toBe(false);
    s = onPinFailure(s, t1);
    expect(s.lockedUntil).toBe(t1 + 24 * HOUR);
    // and it stays at 24 hours for every further batch of five
    const t2 = s.lockedUntil + 1;
    for (let i = 0; i < 5; i++) s = onPinFailure(s, t2);
    expect(s.lockedUntil).toBe(t2 + 24 * HOUR);
  });
  it("the right PIN clears the count", () => {
    let s = { failCount: 0, lockedUntil: 0 };
    for (let i = 0; i < 4; i++) s = onPinFailure(s, t0);
    s = onPinSuccess();
    for (let i = 0; i < 4; i++) s = onPinFailure(s, t0);
    expect(isPinLocked(s, t0)).toBe(false);
  });
});

describe("withdrawal delay", () => {
  it("small withdrawals go at once, large ones wait 30 minutes", () => {
    expect(withdrawalDelayMs(LARGE_WITHDRAWAL_FCFA - 1)).toBe(0);
    expect(withdrawalDelayMs(LARGE_WITHDRAWAL_FCFA)).toBe(WITHDRAWAL_DELAY_MS);
    expect(WITHDRAWAL_DELAY_MS).toBe(30 * MINUTE);
  });
});
