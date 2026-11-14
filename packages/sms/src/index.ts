// @melax/sms: text messages in and out.
// Contract:
//   - everything we send is GSM-7. Text that would silently switch the message to UCS-2 (70 characters
//     per part instead of 160, three times the cost) is refused before it leaves, naming the characters;
//   - inbound commands can check, redeem, report and cancel. None of them can move money out;
//   - a webhook is believed only after its signature and freshness are checked.
// Adapters: android-sms-gateway (an Android phone with a local SIM), httpSMS, and an in-memory one.
// Callers: apps/gateway (notifications, receipts, vouchers, inbound webhook routes).
import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@melax/core";

// ---------- GSM 03.38 ----------

const BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const EXTENDED = "^{}\\[~]|€\f";
const basicSet = new Set([...BASIC]);
const extSet = new Set([...EXTENDED]);

export function isGsm7(text: string): boolean {
  for (const ch of text) if (!basicSet.has(ch) && !extSet.has(ch)) return false;
  return true;
}

export function gsm7Septets(text: string): number {
  let n = 0;
  for (const ch of text) n += extSet.has(ch) ? 2 : 1;
  return n;
}

/** Number of SMS parts for GSM-7 text: one part up to 160 septets, then 153 per part. */
export function smsSegments(text: string): number {
  const n = gsm7Septets(text);
  return n <= 160 ? 1 : Math.ceil(n / 153);
}

/** Returns the text unchanged, or throws BAD_INPUT listing each character that is not GSM-7. */
export function assertGsm7(text: string): string {
  const bad = [...new Set([...text].filter((ch) => !basicSet.has(ch) && !extSet.has(ch)))];
  if (bad.length > 0) throw new AppError("BAD_INPUT", "text is not GSM-7", { bad });
  return text;
}

const FOLD: Record<string, string> = {
  ç: "c", ê: "e", ë: "e", ô: "o", ó: "o", õ: "o", â: "a", á: "a", ã: "a", î: "i", ï: "i", í: "i", û: "u", ú: "u", ÿ: "y",
  Ê: "E", Ë: "E", È: "E", Ô: "O", Ó: "O", Â: "A", À: "A", Á: "A", Î: "I", Ï: "I", Û: "U", Ù: "U", Ú: "U",
  œ: "oe", Œ: "OE", ŋ: "ng", Ŋ: "Ng", "’": "'", "‘": "'", "“": '"', "”": '"', "«": '"', "»": '"', "—": "-", "–": "-", "…": "...", " ": " ", " ": " ", "\t": " ", "≈": "~",
};

/** For text we did not write (names, payer comments): fold what can be folded, replace the rest with "?". */
export function toGsm7(text: string): string {
  let out = "";
  for (const ch of text) {
    if (basicSet.has(ch) || extSet.has(ch)) out += ch;
    else if (FOLD[ch] !== undefined) out += FOLD[ch];
    else out += "?";
  }
  return out;
}

// ---------- inbound commands ----------

export type Command =
  | { cmd: "balance" }
  | { cmd: "help" }
  | { cmd: "voucher"; code: string }
  | { cmd: "scam"; text: string }
  | { cmd: "cancel"; ref: string }
  | { cmd: "approve"; ref: string }
  | { cmd: "unknown" };

const WORDS: Record<string, "balance" | "help" | "voucher" | "scam" | "cancel" | "approve"> = {
  SOLDE: "balance", BALANCE: "balance", SOLD: "balance",
  AIDE: "help", HELP: "help", NDIMBAL: "help",
  BON: "voucher", VOUCHER: "voucher",
  ARNAQUE: "scam", SCAM: "scam", NAX: "scam",
  ANNULER: "cancel", CANCEL: "cancel", BAYYI: "cancel",
  OUI: "approve", YES: "approve", WAAW: "approve",
};

/** The whole inbound vocabulary. Spending by SMS does not exist: a spoofed sender must not be able to move money. */
export function parseCommand(text: string): Command {
  const t = String(text ?? "").trim();
  const m = /^(\S+)(?:\s+([\s\S]+))?$/.exec(t);
  if (!m) return { cmd: "unknown" };
  const cmd = WORDS[m[1]!.toUpperCase()];
  const rest = (m[2] ?? "").trim();
  if (cmd === "balance" || cmd === "help") return rest ? { cmd: "unknown" } : { cmd };
  if (!cmd || !rest) return { cmd: "unknown" };
  if (cmd === "voucher") return { cmd, code: rest };
  if (cmd === "scam") return { cmd, text: rest.slice(0, 480) };
  return { cmd, ref: rest.split(/\s+/)[0]!.toUpperCase() };
}

// ---------- adapters ----------

export interface SmsAdapter {
  readonly name: string;
  /** `to` is E.164. Resolves once the gateway has accepted the message, not when it is delivered. */
  send(to: string, body: string): Promise<{ id: string }>;
}

export interface InboundSms {
  id: string;
  from: string;
  text: string;
}

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** capcom6/android-sms-gateway: an Android phone with a local SIM becomes the gateway (local, cloud or private server mode). */
export class AndroidSmsGateway implements SmsAdapter {
  readonly name = "android-sms-gateway";
  private readonly cfg: { baseUrl: string; username: string; password: string; fetch?: FetchLike };
  constructor(cfg: { baseUrl: string; username: string; password: string; fetch?: FetchLike }) {
    this.cfg = cfg;
  }
  async send(to: string, body: string): Promise<{ id: string }> {
    assertGsm7(body);
    const f = this.cfg.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(this.cfg.baseUrl.replace(/\/+$/, "") + "/message", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString("base64") },
        body: JSON.stringify({ textMessage: { text: body }, phoneNumbers: [to] }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new AppError("UPSTREAM", "sms gateway unreachable: " + (e instanceof Error ? e.message : ""));
    }
    if (!res.ok) throw new AppError("UPSTREAM", `sms gateway answered ${res.status}`);
    const j = (await res.json().catch(() => ({}))) as { id?: string };
    return { id: String(j.id ?? "") };
  }
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

/**
 * android-sms-gateway webhook. Signature: X-Signature = hex HMAC-SHA256(signing key, raw body + X-Timestamp).
 * Returns the message for `sms:received`, null for any other event, and throws FORBIDDEN when the
 * signature is wrong or the timestamp is more than five minutes away.
 * The sender field is `phoneNumber` in the project README and `sender` in its docs site; both are read.
 */
export function parseAsgWebhook(a: { rawBody: string; signature: string | undefined; timestamp: string | undefined; signingKey: string; nowMs: number }): InboundSms | null {
  const ts = Number(a.timestamp);
  if (!a.signature || !a.timestamp || !Number.isFinite(ts)) throw new AppError("FORBIDDEN", "unsigned webhook");
  if (Math.abs(a.nowMs / 1000 - ts) > 300) throw new AppError("FORBIDDEN", "stale webhook");
  const want = createHmac("sha256", a.signingKey).update(a.rawBody + a.timestamp).digest("hex");
  if (!safeEqualHex(a.signature, want)) throw new AppError("FORBIDDEN", "bad webhook signature");
  const j = JSON.parse(a.rawBody) as { event?: string; payload?: { messageId?: string; message?: string; phoneNumber?: string; sender?: string } };
  if (j.event !== "sms:received" || !j.payload) return null;
  const from = j.payload.sender ?? j.payload.phoneNumber;
  if (!from || typeof j.payload.message !== "string") return null;
  return { id: String(j.payload.messageId ?? ""), from, text: j.payload.message };
}

/** httpSMS (api.httpsms.com or self-hosted): the second adapter. */
export class HttpSms implements SmsAdapter {
  readonly name = "httpsms";
  private readonly cfg: { apiKey: string; from: string; baseUrl?: string; fetch?: FetchLike };
  constructor(cfg: { apiKey: string; from: string; baseUrl?: string; fetch?: FetchLike }) {
    this.cfg = cfg;
  }
  async send(to: string, body: string): Promise<{ id: string }> {
    assertGsm7(body);
    const f = this.cfg.fetch ?? fetch;
    let res: Response;
    try {
      res = await f((this.cfg.baseUrl ?? "https://api.httpsms.com").replace(/\/+$/, "") + "/v1/messages/send", {
        method: "POST",
        headers: { "x-api-key": this.cfg.apiKey, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ content: body, from: this.cfg.from, to }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new AppError("UPSTREAM", "httpsms unreachable: " + (e instanceof Error ? e.message : ""));
    }
    if (!res.ok) throw new AppError("UPSTREAM", `httpsms answered ${res.status}`);
    const j = (await res.json().catch(() => ({}))) as { data?: { id?: string } };
    return { id: String(j.data?.id ?? "") };
  }
}

/** httpSMS webhook: a CloudEvent, authenticated by an HS256 JWT in the Authorization header signed with our webhook key. */
export function parseHttpSmsWebhook(a: { rawBody: string; authorization: string | undefined; signingKey: string; nowMs: number }): InboundSms | null {
  const token = /^Bearer\s+(.+)$/i.exec(a.authorization ?? "")?.[1];
  const parts = token?.split(".") ?? [];
  if (parts.length !== 3) throw new AppError("FORBIDDEN", "unsigned webhook");
  let header: { alg?: string };
  let claims: { exp?: number };
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as { alg?: string };
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { exp?: number };
  } catch {
    throw new AppError("FORBIDDEN", "malformed webhook token");
  }
  if (header.alg !== "HS256") throw new AppError("FORBIDDEN", "webhook token is not HS256");
  const want = createHmac("sha256", a.signingKey).update(`${parts[0]}.${parts[1]}`).digest();
  const got = Buffer.from(parts[2]!, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new AppError("FORBIDDEN", "bad webhook signature");
  if (typeof claims.exp === "number" && claims.exp * 1000 < a.nowMs) throw new AppError("FORBIDDEN", "webhook token expired");
  const j = JSON.parse(a.rawBody) as { type?: string; data?: { message_id?: string; contact?: string; content?: string } };
  if (j.type !== "message.phone.received" || !j.data?.contact || typeof j.data.content !== "string") return null;
  return { id: String(j.data.message_id ?? ""), from: j.data.contact, text: j.data.content };
}

/** Keeps messages in memory. Used by tests; the gateway has a database-backed twin for the web simulator. */
export class MemorySms implements SmsAdapter {
  readonly name = "memory";
  readonly sent: Array<{ to: string; body: string }> = [];
  async send(to: string, body: string): Promise<{ id: string }> {
    assertGsm7(body);
    this.sent.push({ to, body });
    return { id: `mem-${this.sent.length}` };
  }
}
