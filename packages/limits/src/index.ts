// @melax/limits: the rules that slow a thief down. Pure functions, no I/O.
// Contract: callers pass in what the database knows (age, guardians, sums already spent, fail counts)
// and get a decision back. Amounts are whole FCFA because that is how people and regulators count here.
// Callers: apps/gateway services (every spend, every PIN check, every withdrawal).
import { DAY, HOUR, MINUTE } from "@melax/core";

export interface Tier {
  perTxFcfa: number;
  perDayFcfa: number;
  perMonthFcfa: number;
  /** Cap on the first payment to someone this user has never paid. */
  newRecipientFcfa: number;
}

/** Tier 0 is every new number. Limits rise with account age and with guardians, never with a form to fill in. */
export const TIERS: readonly [Tier, Tier, Tier] = [
  { perTxFcfa: 25_000, perDayFcfa: 50_000, perMonthFcfa: 200_000, newRecipientFcfa: 10_000 },
  { perTxFcfa: 100_000, perDayFcfa: 200_000, perMonthFcfa: 1_000_000, newRecipientFcfa: 25_000 },
  { perTxFcfa: 250_000, perDayFcfa: 500_000, perMonthFcfa: 2_000_000, newRecipientFcfa: 50_000 },
];
export type TierLevel = 0 | 1 | 2;

export function tierFor(a: { accountAgeMs: number; guardians: number }): TierLevel {
  if (a.accountAgeMs >= 30 * DAY && a.guardians >= 2) return 2;
  if (a.accountAgeMs >= 7 * DAY || a.guardians >= 2) return 1;
  return 0;
}

export type SpendDecision = { ok: true } | { ok: false; reason: "PER_TX" | "PER_DAY" | "PER_MONTH" | "NEW_RECIPIENT" | "BAD_AMOUNT"; allowedFcfa: number };

export function checkSpend(a: { tier: TierLevel; amountFcfa: number; spentTodayFcfa: number; spentMonthFcfa: number; newRecipient: boolean }): SpendDecision {
  const t = TIERS[a.tier];
  if (!Number.isSafeInteger(a.amountFcfa) || a.amountFcfa <= 0) return { ok: false, reason: "BAD_AMOUNT", allowedFcfa: 0 };
  if (a.amountFcfa > t.perTxFcfa) return { ok: false, reason: "PER_TX", allowedFcfa: t.perTxFcfa };
  if (a.newRecipient && a.amountFcfa > t.newRecipientFcfa) return { ok: false, reason: "NEW_RECIPIENT", allowedFcfa: t.newRecipientFcfa };
  const dayLeft = Math.max(0, t.perDayFcfa - a.spentTodayFcfa);
  if (a.amountFcfa > dayLeft) return { ok: false, reason: "PER_DAY", allowedFcfa: dayLeft };
  const monthLeft = Math.max(0, t.perMonthFcfa - a.spentMonthFcfa);
  if (a.amountFcfa > monthLeft) return { ok: false, reason: "PER_MONTH", allowedFcfa: monthLeft };
  return { ok: true };
}

// ---------- PIN lockout ----------

export interface PinState {
  /** Wrong tries since the last right one. */
  failCount: number;
  /** Epoch ms. 0 when not locked. */
  lockedUntil: number;
}

export const PIN_TRIES = 5;
export const FIRST_LOCK_MS = 15 * MINUTE;
export const LONG_LOCK_MS = 24 * HOUR;

/** Every fifth wrong try locks the PIN: 15 minutes the first time, 24 hours from then on. */
export function onPinFailure(s: PinState, now: number): PinState {
  const failCount = s.failCount + 1;
  if (failCount % PIN_TRIES !== 0) return { failCount, lockedUntil: s.lockedUntil };
  return { failCount, lockedUntil: now + (failCount === PIN_TRIES ? FIRST_LOCK_MS : LONG_LOCK_MS) };
}

export function onPinSuccess(): PinState {
  return { failCount: 0, lockedUntil: 0 };
}

export function isPinLocked(s: PinState, now: number): boolean {
  return s.lockedUntil > now;
}

// ---------- withdrawals and resets ----------

export const LARGE_WITHDRAWAL_FCFA = 50_000;
export const WITHDRAWAL_DELAY_MS = 30 * MINUTE;
/** After a PIN reset nothing can be spent for a day: the real owner gets time to notice. */
export const RESET_FREEZE_MS = 24 * HOUR;
/** How many of a user's guardians must approve a PIN reset. */
export const GUARDIANS_NEEDED = 2;
export const GUARDIANS_MAX = 3;

/** Money leaving Melax (to an agent, a Lightning invoice, a token) waits when it is large, and the owner gets an SMS that can cancel it. */
export function withdrawalDelayMs(amountFcfa: number): number {
  return amountFcfa >= LARGE_WITHDRAWAL_FCFA ? WITHDRAWAL_DELAY_MS : 0;
}
