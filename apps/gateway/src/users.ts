// Accounts: who a phone number is, and whether the secret code typed is theirs.
// Contract:
//   - a number is stored as an HMAC (to find the account) and as a sealed copy (to text its owner). The
//     clear number is in no column. The code is an Argon2id hash peppered from the environment;
//   - checkPin is the only place a code is compared. It counts wrong tries under a row lock, locks after
//     five (15 minutes, then 24 hours), texts the owner on a lock, and says FROZEN only to someone who
//     typed the right code;
//   - a first name is 2 to 16 letters and is folded to GSM-7 before it is stored, so it is safe on any screen.
// Callers: perform.ts (USSD effects), wallet.ts (names, numbers and languages for receipts), smsin.ts.
import { AppError, type Clock, HOUR, type Logger, MINUTE, maskPhone, newId, normalizePhone, silentLogger, toSafeInt } from "@melax/core";
import { hashPin, isWeakPin, open, phoneLookupKey, randomAlias, seal, verifyPin } from "@melax/crypto";
import { type Lang, clip, isLang, t } from "@melax/i18n";
import type { Db } from "@melax/ledger";
import { PIN_TRIES, isPinLocked, onPinFailure, onPinSuccess } from "@melax/limits";
import { ALIAS_RE, NAME_RE, isReservedAlias } from "./rules.ts";
import type { SmsOutbox } from "./smsout.ts";

export interface User {
  id: string;
  phoneMasked: string;
  name: string;
  alias: string;
  lang: Lang;
  role: "user" | "merchant" | "agent";
  createdAt: number;
  frozenUntil: number;
}

export type PinFailure = { ok: false; err: "PIN_WRONG"; left: number } | { ok: false; err: "PIN_LOCKED"; minutes: number } | { ok: false; err: "FROZEN"; hours: number };
export type PinCheck = { ok: true } | PinFailure;
export type BadInput = { ok: false; err: "BAD_INPUT"; why: "weak" | "taken" | "bad" };

interface UserRow {
  id: string;
  phone_sealed: Buffer;
  phone_masked: string;
  name: string;
  alias: string;
  lang: Lang;
  role: User["role"];
  pin_hash: string;
  pin_fail_count: number;
  pin_locked_until: number;
  frozen_until: number;
  created_at: number;
}

const toUser = (r: UserRow): User => ({ id: r.id, phoneMasked: r.phone_masked, name: r.name, alias: r.alias, lang: r.lang, role: r.role, createdAt: toSafeInt(r.created_at), frozenUntil: toSafeInt(r.frozen_until) });

export interface UsersDeps {
  db: Db;
  clock: Clock;
  log?: Logger;
  /** Three different keys derived from the server pepper (see app.ts). */
  pinPepper: Buffer;
  phoneKey: Buffer;
  dataKey: Buffer;
  outbox: SmsOutbox;
  /** Domain of the Lightning addresses, and the short code as dialled. Both appear in the welcome SMS. */
  domain: string;
  code: string;
}

export class Users {
  private readonly d: UsersDeps;
  private readonly log: Logger;

  constructor(deps: UsersDeps) {
    this.d = deps;
    this.log = deps.log ?? silentLogger;
  }

  addressOf(u: { alias: string }): string {
    return `${u.alias}@${this.d.domain}`;
  }

  async findByPhone(phone: string, db: Db = this.d.db): Promise<User | null> {
    const rows = await db.query<UserRow>("SELECT * FROM users WHERE phone_hmac = $1", [phoneLookupKey(normalizePhone(phone), this.d.phoneKey)]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async byId(id: string, db: Db = this.d.db): Promise<User | null> {
    const rows = await db.query<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  /** The user's number in the clear, for texting them. Never put the result in a log or on a screen. */
  async phoneOf(id: string, db: Db = this.d.db): Promise<string> {
    const rows = await db.query<{ phone_sealed: Buffer }>("SELECT phone_sealed FROM users WHERE id = $1", [id]);
    if (!rows[0]) throw new AppError("NOT_FOUND", "no such user");
    return open(this.d.dataKey, Buffer.from(rows[0].phone_sealed), `user:phone:${id}`).toString("utf8");
  }

  /** Throws PIN_WEAK, BAD_INPUT (name or language) or DUPLICATE (the number already has an account). */
  async register(a: { phone: string; pin: string; name: string; lang: Lang }): Promise<User> {
    const phone = normalizePhone(a.phone);
    if (!isLang(a.lang)) throw new AppError("BAD_INPUT", "unknown language");
    const typed = String(a.name ?? "").trim().replace(/[ \t]+/g, " ");
    if (!NAME_RE.test(typed)) throw new AppError("BAD_INPUT", "a first name is 2 to 16 letters");
    const name = clip(typed, 16);
    if (isWeakPin(a.pin, phone)) throw new AppError("PIN_WEAK", "the code is too easy to guess");
    const pinHash = await hashPin(a.pin, this.d.pinPepper);
    const hmac = phoneLookupKey(phone, this.d.phoneKey);
    const now = this.d.clock.now();

    return this.d.db.tx(async (tx) => {
      // ON CONFLICT DO NOTHING covers both the number and the address name without aborting the transaction.
      for (let attempt = 0; attempt < 6; attempt++) {
        const id = newId("u", this.d.clock);
        const alias = randomAlias();
        const rows = await tx.query<UserRow>(
          `INSERT INTO users (id, phone_hmac, phone_sealed, phone_masked, name, alias, lang, pin_hash, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING RETURNING *`,
          [id, hmac, seal(this.d.dataKey, Buffer.from(phone, "utf8"), `user:phone:${id}`), maskPhone(phone), name, alias, a.lang, pinHash, now],
        );
        if (rows[0]) {
          const user = toUser(rows[0]);
          await this.d.outbox.queue(tx, { to: phone, kind: "welcome", body: t(a.lang, "sms.welcome", { address: this.addressOf(user), code: this.d.code }) });
          this.log.info("user.registered", { user: user.id, lang: a.lang });
          return user;
        }
        if ((await tx.query("SELECT 1 FROM users WHERE phone_hmac = $1", [hmac])).length > 0) throw new AppError("DUPLICATE", "this number already has an account");
        // otherwise the random address name was taken: draw another
      }
      throw new AppError("INTERNAL", "could not find a free address name");
    });
  }

  /**
   * Compare a typed code. `spend` also refuses while the account is frozen after a code reset, and only
   * says so once the code was right: a thief with the phone learns nothing from a wrong guess.
   */
  async checkPin(userId: string, pin: string, purpose: "view" | "spend"): Promise<PinCheck> {
    return this.d.db.tx(async (tx) => {
      const row = (await tx.query<UserRow>("SELECT * FROM users WHERE id = $1 FOR UPDATE", [userId]))[0];
      if (!row) throw new AppError("NOT_FOUND", "no such user");
      const now = this.d.clock.now();
      const state = { failCount: toSafeInt(row.pin_fail_count), lockedUntil: toSafeInt(row.pin_locked_until) };
      const minutesLeft = (until: number): number => Math.max(1, Math.ceil((until - now) / MINUTE));
      if (isPinLocked(state, now)) return { ok: false, err: "PIN_LOCKED", minutes: minutesLeft(state.lockedUntil) };

      const right = typeof pin === "string" && /^\d{5}$/.test(pin) && (await verifyPin(pin, row.pin_hash, this.d.pinPepper));
      if (!right) {
        const next = onPinFailure(state, now);
        await tx.query("UPDATE users SET pin_fail_count = $2, pin_locked_until = $3 WHERE id = $1", [userId, next.failCount, next.lockedUntil]);
        if (!isPinLocked(next, now)) return { ok: false, err: "PIN_WRONG", left: PIN_TRIES - (next.failCount % PIN_TRIES) };
        const minutes = minutesLeft(next.lockedUntil);
        const phone = open(this.d.dataKey, Buffer.from(row.phone_sealed), `user:phone:${userId}`).toString("utf8");
        await this.d.outbox.queue(tx, { to: phone, kind: "pin_locked", body: t(row.lang, "sms.pin_locked", { minutes }) });
        this.log.warn("pin.locked", { user: userId, failCount: next.failCount });
        return { ok: false, err: "PIN_LOCKED", minutes };
      }

      if (state.failCount !== 0 || state.lockedUntil !== 0) {
        const clean = onPinSuccess();
        await tx.query("UPDATE users SET pin_fail_count = $2, pin_locked_until = $3 WHERE id = $1", [userId, clean.failCount, clean.lockedUntil]);
      }
      const frozenUntil = toSafeInt(row.frozen_until);
      if (purpose === "spend" && frozenUntil > now) return { ok: false, err: "FROZEN", hours: Math.max(1, Math.ceil((frozenUntil - now) / HOUR)) };
      return { ok: true };
    });
  }

  async changePin(userId: string, oldPin: string, newPin: string): Promise<{ ok: true } | PinFailure | BadInput> {
    const check = await this.checkPin(userId, oldPin, "view");
    if (!check.ok) return check;
    const phone = await this.phoneOf(userId);
    if (isWeakPin(newPin, phone)) return { ok: false, err: "BAD_INPUT", why: "weak" };
    const pinHash = await hashPin(newPin, this.d.pinPepper);
    await this.d.db.tx(async (tx) => {
      const row = (await tx.query<{ lang: Lang }>("UPDATE users SET pin_hash = $2, pin_fail_count = 0, pin_locked_until = 0 WHERE id = $1 RETURNING lang", [userId, pinHash]))[0];
      if (!row) throw new AppError("NOT_FOUND", "no such user");
      await this.d.outbox.queue(tx, { to: phone, kind: "pin_changed", body: t(row.lang, "sms.pin_changed") });
    });
    this.log.info("pin.changed", { user: userId });
    return { ok: true };
  }

  async setLang(userId: string, lang: Lang): Promise<void> {
    if (!isLang(lang)) throw new AppError("BAD_INPUT", "unknown language");
    const rows = await this.d.db.query("UPDATE users SET lang = $2 WHERE id = $1 RETURNING id", [userId, lang]);
    if (rows.length === 0) throw new AppError("NOT_FOUND", "no such user");
  }

  /** Rename the Lightning address. Needs the code: whoever holds the name receives what is sent to it. */
  async setAlias(userId: string, wanted: string, pin: string): Promise<{ ok: true; address: string } | PinFailure | BadInput> {
    const check = await this.checkPin(userId, pin, "view");
    if (!check.ok) return check;
    const alias = String(wanted ?? "").trim().toLowerCase();
    if (!ALIAS_RE.test(alias) || isReservedAlias(alias)) return { ok: false, err: "BAD_INPUT", why: "bad" };
    return this.d.db.tx(async (tx) => {
      const holder = (await tx.query<{ id: string }>("SELECT id FROM users WHERE alias = $1", [alias]))[0];
      if (holder && holder.id !== userId) return { ok: false, err: "BAD_INPUT", why: "taken" } as BadInput;
      if (!holder) {
        // Two people asking for the same free name at once: the unique index lets one through.
        const rows = await tx.query("UPDATE users SET alias = $2 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM users WHERE alias = $2) RETURNING id", [userId, alias]);
        if (rows.length === 0) return { ok: false, err: "BAD_INPUT", why: "taken" } as BadInput;
      }
      return { ok: true as const, address: this.addressOf({ alias }) };
    });
  }
}
