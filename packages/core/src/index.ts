// @melax/core: the small shared vocabulary every other package speaks.
// Contract: no I/O, no dependencies. Errors, ids, clock, phone numbers, money maths, log redaction.
// Callers: every package and app in this repo.
import { randomBytes } from "node:crypto";

// ---------- errors ----------

export type ErrorCode =
  | "BAD_INPUT"
  | "BAD_PHONE"
  | "BAD_AMOUNT"
  | "NOT_FOUND"
  | "INSUFFICIENT_FUNDS"
  | "LIMIT_EXCEEDED"
  | "PIN_WRONG"
  | "PIN_LOCKED"
  | "PIN_WEAK"
  | "FROZEN"
  | "BUSY"
  | "DUPLICATE"
  | "EXPIRED"
  | "FORBIDDEN"
  | "CONFLICT"
  | "UPSTREAM"
  | "UNKNOWN_OUTCOME"
  | "PAUSED"
  | "INTERNAL";

/** An error the caller is expected to handle. `code` is stable; `message` is for operators, never for users. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly data: Record<string, unknown>;
  constructor(code: ErrorCode, message?: string, data: Record<string, unknown> = {}) {
    super(message ?? code);
    this.name = "AppError";
    this.code = code;
    this.data = data;
  }
}

export function isAppError(e: unknown, code?: ErrorCode): e is AppError {
  return e instanceof AppError && (code === undefined || e.code === code);
}

// ---------- clock ----------

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Test clock. Time only moves when the test says so. */
export class FakeClock implements Clock {
  private t: number;
  constructor(start = 1_760_000_000_000) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(ms: number): void {
    this.t = ms;
  }
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// ---------- ids ----------

const B32 = "0123456789abcdefghjkmnpqrstvwxyz";
let lastMs = 0;
let seq = 0;

/** Sortable unique id: prefix, 9 chars of time, 3 of in-process sequence, 10 of randomness. */
export function newId(prefix: string, clock: Clock = systemClock): string {
  const ms = clock.now();
  if (ms === lastMs) seq = (seq + 1) % 32768;
  else {
    lastMs = ms;
    seq = 0;
  }
  let t = "";
  let n = ms;
  for (let i = 0; i < 9; i++) {
    t = B32[n % 32]! + t;
    n = Math.floor(n / 32);
  }
  const s = B32[(seq >> 10) & 31]! + B32[(seq >> 5) & 31]! + B32[seq & 31]!;
  const r = Array.from(randomBytes(10), (b) => B32[b % 32]).join("");
  return `${prefix}_${t}${s}${r}`;
}

// ---------- integers ----------

/** Parse a database or wire integer into a JS number, refusing anything that would lose precision. */
export function toSafeInt(v: unknown): number {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "bigint") n = Number(v);
  else if (typeof v === "string" && /^-?\d+$/.test(v)) n = Number(v);
  else throw new AppError("BAD_AMOUNT", "not an integer");
  if (!Number.isSafeInteger(n)) throw new AppError("BAD_AMOUNT", "integer out of safe range");
  if (typeof v !== "number" && String(BigInt(n)) !== String(v)) throw new AppError("BAD_AMOUNT", "integer out of safe range");
  return n;
}

export function assertSats(n: unknown, opts: { allowZero?: boolean } = {}): number {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || (n === 0 && !opts.allowZero)) {
    throw new AppError("BAD_AMOUNT", "amount must be a positive whole number of sats");
  }
  return n;
}

// ---------- money ----------

export const SATS_PER_BTC = 100_000_000;
/** The CFA franc is pegged to the euro at this fixed rate. */
export const XOF_PER_EUR = 655.957;

function assertWhole(n: number, what: string): void {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new AppError("BAD_AMOUNT", `${what} must be a whole number >= 0`);
}
function assertRate(xofPerBtc: number): void {
  if (typeof xofPerBtc !== "number" || !Number.isFinite(xofPerBtc) || xofPerBtc <= 0) throw new AppError("BAD_AMOUNT", "missing exchange rate");
}

export function fcfaToSats(fcfa: number, xofPerBtc: number): number {
  assertWhole(fcfa, "fcfa");
  assertRate(xofPerBtc);
  return Math.round((fcfa * SATS_PER_BTC) / xofPerBtc);
}

export function satsToFcfa(sats: number, xofPerBtc: number): number {
  assertWhole(sats, "sats");
  assertRate(xofPerBtc);
  return Math.round((sats * xofPerBtc) / SATS_PER_BTC);
}

function group(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}
export function formatFcfa(fcfa: number): string {
  return `${group(fcfa)} F`;
}
export function formatSats(sats: number): string {
  return `${group(sats)} ${sats === 1 ? "sat" : "sats"}`;
}

// ---------- phone numbers ----------

const SN_MOBILE = /^7[05678]\d{7}$/;

/** Normalise to E.164. Bare 9-digit numbers are read as Senegalese mobiles (+221). */
export function normalizePhone(raw: string): string {
  if (typeof raw !== "string") throw new AppError("BAD_PHONE");
  let s = raw.replace(/[\s.\-()]/g, "");
  if (!/^\+?\d+$/.test(s)) throw new AppError("BAD_PHONE");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (!s.startsWith("+") && s.startsWith("221") && s.length === 12) s = "+" + s;
  if (s.startsWith("+221")) {
    const local = s.slice(4);
    if (!SN_MOBILE.test(local)) throw new AppError("BAD_PHONE");
    return "+221" + local;
  }
  if (s.startsWith("+")) {
    if (s.length < 9 || s.length > 16) throw new AppError("BAD_PHONE");
    return s;
  }
  if (!SN_MOBILE.test(s)) throw new AppError("BAD_PHONE");
  return "+221" + s;
}

/** What we show on a screen or receipt: enough to recognise a number, not enough to reuse it. */
export function maskPhone(e164: string): string {
  if (e164.startsWith("+221") && e164.length === 13) {
    const l = e164.slice(4);
    return `${l.slice(0, 2)}*****${l.slice(-2)}`;
  }
  return `${e164.slice(0, 3)}${"*".repeat(Math.max(0, e164.length - 5))}${e164.slice(-2)}`;
}

/** Local display form for an SMS to the owner of the number: 77 123 45 67. */
export function localPhone(e164: string): string {
  if (e164.startsWith("+221") && e164.length === 13) {
    const l = e164.slice(4);
    return `${l.slice(0, 2)} ${l.slice(2, 5)} ${l.slice(5, 7)} ${l.slice(7)}`;
  }
  return e164;
}

// ---------- log redaction ----------

const REDACTED = "[redacted]";
const SENSITIVE_KEY =
  /^(phone|phones|msisdn|phoneNumber|to|from|pin|newPin|oldPin|code|voucherCode|payCode|invoice|bolt11|pr|request|token|secret|secrets|preimage|macaroon|body|text|comment|nsec|nwc|nwcUrl|password|authorization|cookie|name|displayName|proofs|witness|privkey|seed|pepper)$/i;

const VOUCHER_CHARS = "A-HJKMNP-TV-Z2-9";
const PATTERNS: RegExp[] = [
  /nostr\+walletconnect:\/\/\S+/gi,
  /ln(?:bcrt|bc|tbs|tb)[0-9a-z]{20,}/gi,
  /lnurl1[0-9a-z]{10,}/gi,
  /cashu[AB][A-Za-z0-9_\-=+/]{10,}/g,
  /nsec1[0-9a-z]{20,}/gi,
  new RegExp(`(?<![0-9A-Za-z])[${VOUCHER_CHARS}]{4}(?:-[${VOUCHER_CHARS}]{4}){3}(?![0-9A-Za-z])`, "g"),
  /(?<![0-9A-Za-z])(?:\+|00)?(?:221[\s.-]?)?7[05678][\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}(?![0-9A-Za-z])/g,
  /(?<![0-9A-Za-z])\+?\d{9,15}(?![0-9A-Za-z])/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
];

function scrub(s: string): string {
  let out = s;
  for (const p of PATTERNS) out = out.replace(p, REDACTED);
  return out;
}

/** Deep copy with every sensitive key blanked and every string scanned for numbers, invoices, tokens and codes. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrub(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    const code = value instanceof AppError ? { errCode: value.code } : {};
    return { errName: value.name, errMessage: scrub(value.message), ...code };
  }
  if (value instanceof Uint8Array) return `[${value.length} bytes]`;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return REDACTED;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** The only way this codebase writes logs. Every field passes through `redact` before it reaches the sink. */
export function createLogger(opts: { sink?: (line: string) => void; clock?: Clock; level?: LogLevel } = {}): Logger {
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + "\n"));
  const clock = opts.clock ?? systemClock;
  const min = LEVELS[opts.level ?? "info"];
  const write = (level: LogLevel, event: string, fields?: Record<string, unknown>): void => {
    if (LEVELS[level] < min) return;
    const safe = redact(fields ?? {}) as Record<string, unknown>;
    sink(JSON.stringify({ ts: clock.now(), level, event, ...safe }));
  };
  return {
    debug: (e, f) => write("debug", e, f),
    info: (e, f) => write("info", e, f),
    warn: (e, f) => write("warn", e, f),
    error: (e, f) => write("error", e, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
