// The wallet: balance, who a number is, what an amount costs, sending, history, limits.
// Contract:
//   - amounts typed by users are whole FCFA; what moves is whole sats, through Vault.transfer only;
//   - a send checks the code, then the limits, then moves the ecash. The sats are the ones the confirm
//     screen showed: the rate is fixed from that screen to the end of the session;
//   - one send at a time per user in this process, so two sessions cannot both pass the same limit check;
//   - the history rows, the receipt number and both SMS are written by the settle handler, inside the
//     transaction that settles the ecash. A send that is still unknown returns PENDING and its receipt
//     follows by SMS when Vault.recover() resolves it;
//   - an idempotency key moves money once. Asking again with the same key reports the first outcome;
//   - a deposit is credited only for an invoice the gateway's own node reports as settled, for the
//     amount that node reports, once per payment hash and to one user.
// Callers: perform.ts (USSD effects), smsin.ts (balance by SMS), demo.ts (the top-up button). Phase 8
// calls deposit() from the invoice listener.
import { AppError, type Clock, DAY, type Logger, fcfaToSats, isAppError, normalizePhone, satsToFcfa, silentLogger, toSafeInt } from "@melax/core";
import { type MessageKey, fcfa as showFcfa, t } from "@melax/i18n";
import { type Db, balance, post } from "@melax/ledger";
import type { LightningBackend } from "@melax/lightning";
import { TIERS, type TierLevel, checkSpend, tierFor } from "@melax/limits";
import { assertGsm7 } from "@melax/sms";
import { FLOAT_NODE, type OpView, type Vault } from "@melax/vault";
import type { Rates } from "./rates.ts";
import type { SettleRouter } from "./settle.ts";
import type { SmsOutbox } from "./smsout.ts";
import type { HistItem, LimitReason } from "./ussd/machine.ts";
import type { PinFailure, User, Users } from "./users.ts";

export const HISTORY_PAGE = 4;
const owner = (userId: string): string => `user:${userId}`;
const spendable = (userId: string): string => `${owner(userId)}:spendable`;

/** What a send stores with its vault operation: everything the receipt needs, and nothing secret. */
interface SendMeta {
  t: "send";
  sender: string;
  recipient: string;
  fcfa: number;
  /** FCFA per BTC when the send started. Balances on the receipts are converted with it. */
  rate: number;
}

/** What a deposit stores with its vault operation. */
interface DepositMeta {
  t: "deposit";
  user: string;
  /** FCFA per BTC when the sats arrived. The francs in the history and in the SMS come from it. */
  rate: number;
}

export type DepositResult = { ok: true; sats: number; fcfa: number } | { ok: false; err: "NOT_FOUND" | "NOT_PAID" | "PENDING" | "GENERIC" };

export type Refusal =
  | PinFailure
  | { ok: false; err: "INSUFFICIENT_FUNDS"; balanceFcfa: number }
  | { ok: false; err: "LIMIT"; reason: LimitReason; allowedFcfa: number }
  | { ok: false; err: "BUSY" | "PENDING" | "NOT_FOUND" | "GENERIC" }
  | { ok: false; err: "BAD_INPUT"; why?: "self" };

export interface WalletDeps {
  db: Db;
  clock: Clock;
  log?: Logger;
  vault: Vault;
  /** The gateway's own Lightning node. Asked whether an invoice was really paid before a deposit is credited. */
  ln: LightningBackend;
  users: Users;
  rates: Rates;
  outbox: SmsOutbox;
  settle: SettleRouter;
}

export class Wallet {
  private readonly d: WalletDeps;
  private readonly log: Logger;
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(deps: WalletDeps) {
    this.d = deps;
    this.log = deps.log ?? silentLogger;
    deps.settle.on("send", (tx, op) => this.onSendSettled(tx, op));
    deps.settle.on("deposit", (tx, op) => this.onDepositSettled(tx, op));
  }

  // ---------- reads ----------

  async balance(user: User): Promise<{ sats: number; fcfa: number; rate: number }> {
    const rate = await this.d.rates.get();
    const sats = await balance(this.d.db, spendable(user.id));
    return { sats, fcfa: satsToFcfa(sats, rate.xofPerBtc), rate: rate.xofPerBtc };
  }

  /** Who a typed number is. The name and the masked number go on the confirm screen before any money moves. */
  async resolve(user: User, raw: string): Promise<{ ok: true; toRef: string; name: string; masked: string } | Refusal> {
    let phone: string;
    try {
      phone = normalizePhone(raw);
    } catch {
      return { ok: false, err: "BAD_INPUT" };
    }
    const to = await this.d.users.findByPhone(phone);
    if (!to) return { ok: false, err: "NOT_FOUND" };
    if (to.id === user.id) return { ok: false, err: "BAD_INPUT", why: "self" };
    return { ok: true, toRef: to.id, name: to.name, masked: to.phoneMasked };
  }

  private async spent(userId: string, db: Db = this.d.db): Promise<{ today: number; month: number }> {
    const now = this.d.clock.now();
    // Senegal keeps UTC all year, so a UTC day is a local day.
    const dayStart = Math.floor(now / DAY) * DAY;
    const d = new Date(now);
    const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const r = (
      await db.query<{ today: number; month: number }>(
        `SELECT COALESCE(SUM(CASE WHEN ts >= $2 THEN -amount_fcfa ELSE 0 END), 0)::bigint AS today,
                COALESCE(SUM(-amount_fcfa), 0)::bigint AS month
           FROM txlog WHERE user_id = $1 AND spend AND ts >= $3`,
        [userId, dayStart, monthStart],
      )
    )[0]!;
    return { today: toSafeInt(r.today), month: toSafeInt(r.month) };
  }

  private tier(user: User): TierLevel {
    // Guardians arrive in phase 9; until then the level rises with the age of the account only.
    return tierFor({ accountAgeMs: this.d.clock.now() - user.createdAt, guardians: 0 });
  }

  private async limitCheck(user: User, toRef: string, amountFcfa: number) {
    const spent = await this.spent(user.id);
    const paidBefore = await this.d.db.query("SELECT 1 FROM txlog WHERE user_id = $1 AND counterparty_id = $2 AND spend LIMIT 1", [user.id, toRef]);
    return checkSpend({ tier: this.tier(user), amountFcfa, spentTodayFcfa: spent.today, spentMonthFcfa: spent.month, newRecipient: paidBefore.length === 0 });
  }

  /** What an amount is in sats right now, and whether the limits and the balance allow it. Moves nothing. */
  async quote(user: User, toRef: string, amountFcfa: number): Promise<{ ok: true; sats: number } | Refusal> {
    const to = await this.d.users.byId(toRef);
    if (!to || to.id === user.id) return { ok: false, err: "NOT_FOUND" };
    const limit = await this.limitCheck(user, toRef, amountFcfa);
    if (!limit.ok) return { ok: false, err: "LIMIT", reason: limit.reason, allowedFcfa: limit.allowedFcfa };
    const rate = await this.d.rates.get();
    const sats = fcfaToSats(amountFcfa, rate.xofPerBtc);
    if (sats <= 0) return { ok: false, err: "LIMIT", reason: "BAD_AMOUNT", allowedFcfa: 0 };
    const have = await balance(this.d.db, spendable(user.id));
    if (have < sats) return { ok: false, err: "INSUFFICIENT_FUNDS", balanceFcfa: satsToFcfa(have, rate.xofPerBtc) };
    return { ok: true, sats };
  }

  async history(user: User, page: number): Promise<{ items: HistItem[]; more: boolean }> {
    const p = Number.isSafeInteger(page) && page > 0 ? Math.min(page, 250) : 0;
    const rows = await this.d.db.query<{ ts: number; amount_fcfa: number; counterparty: string }>("SELECT ts, amount_fcfa, counterparty FROM txlog WHERE user_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3", [
      user.id,
      HISTORY_PAGE + 1,
      p * HISTORY_PAGE,
    ]);
    return { items: rows.slice(0, HISTORY_PAGE).map((r) => ({ ts: toSafeInt(r.ts), fcfa: toSafeInt(r.amount_fcfa), who: r.counterparty })), more: rows.length > HISTORY_PAGE };
  }

  async limitsView(user: User): Promise<{ tier: number; perTxFcfa: number; dayLeftFcfa: number; monthLeftFcfa: number }> {
    const level = this.tier(user);
    const tier = TIERS[level];
    const spent = await this.spent(user.id);
    return { tier: level, perTxFcfa: tier.perTxFcfa, dayLeftFcfa: Math.max(0, tier.perDayFcfa - spent.today), monthLeftFcfa: Math.max(0, tier.perMonthFcfa - spent.month) };
  }

  // ---------- send ----------

  /** Runs `fn` after every earlier call for the same key has finished, whatever its outcome. */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(key, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    return next;
  }

  async send(a: { user: User; toRef: string; fcfa: number; sats: number; pin: string; idemKey: string }): Promise<{ ok: true; receipt: number; balanceFcfa: number } | Refusal> {
    const pin = await this.d.users.checkPin(a.user.id, a.pin, "spend");
    if (!pin.ok) return pin;

    return this.serial(a.user.id, async () => {
      const rate = await this.d.rates.get();
      const prior = await this.d.vault.findOp(a.idemKey);
      if (prior) return this.outcome(a.user, prior.status === "pending" ? await this.d.vault.resume(prior.id) : prior, rate.xofPerBtc);

      const to = await this.d.users.byId(a.toRef);
      if (!to || to.id === a.user.id) return { ok: false, err: "NOT_FOUND" } as Refusal;
      // The sats come from the confirm screen of this session. They must still be about what the francs
      // are worth; a wide gap means a bug upstream, not a price move, and nothing is sent.
      const expected = fcfaToSats(a.fcfa, rate.xofPerBtc);
      if (!Number.isSafeInteger(a.sats) || a.sats <= 0 || Math.abs(a.sats - expected) > Math.max(2, expected * 0.05)) {
        this.log.warn("wallet.send.quote_mismatch", { user: a.user.id, quotedSat: a.sats, expectedSat: expected });
        return { ok: false, err: "GENERIC" } as Refusal;
      }
      const limit = await this.limitCheck(a.user, to.id, a.fcfa);
      if (!limit.ok) return { ok: false, err: "LIMIT", reason: limit.reason, allowedFcfa: limit.allowedFcfa } as Refusal;

      const meta: SendMeta = { t: "send", sender: a.user.id, recipient: to.id, fcfa: a.fcfa, rate: rate.xofPerBtc };
      let op: OpView;
      try {
        op = await this.d.vault.transfer({ idemKey: a.idemKey, from: owner(a.user.id), to: owner(to.id), amountSat: a.sats, meta: { ...meta } });
      } catch (e) {
        if (isAppError(e, "INSUFFICIENT_FUNDS")) {
          const have = await balance(this.d.db, spendable(a.user.id));
          return { ok: false, err: "INSUFFICIENT_FUNDS", balanceFcfa: satsToFcfa(have, rate.xofPerBtc) } as Refusal;
        }
        if (isAppError(e, "BUSY")) return { ok: false, err: "BUSY" } as Refusal;
        this.log.error("wallet.send.failed", { user: a.user.id, err: e });
        return { ok: false, err: "GENERIC" } as Refusal;
      }
      return this.outcome(a.user, op, rate.xofPerBtc);
    });
  }

  private async outcome(user: User, op: OpView, xofPerBtc: number): Promise<{ ok: true; receipt: number; balanceFcfa: number } | Refusal> {
    if (op.status === "pending") {
      this.log.warn("wallet.send.pending", { user: user.id, op: op.id });
      return { ok: false, err: "PENDING" };
    }
    if (op.status === "failed") return { ok: false, err: "GENERIC" };
    const row = (await this.d.db.query<{ receipt_no: number }>("SELECT receipt_no FROM txlog WHERE ref = $1 AND user_id = $2 LIMIT 1", [op.id, user.id]))[0];
    if (!row) throw new AppError("INTERNAL", "a settled send has no history row", { op: op.id });
    const meta = op.data.meta as Partial<SendMeta> | undefined;
    const have = await balance(this.d.db, spendable(user.id));
    this.log.info("wallet.send.done", { user: user.id, op: op.id, amountSat: op.amountSat });
    return { ok: true, receipt: toSafeInt(row.receipt_no), balanceFcfa: satsToFcfa(have, meta?.rate ?? xofPerBtc) };
  }

  /**
   * Runs inside the transaction that settles or fails a send (see settle.ts). Writes both history rows
   * under one receipt number and queues both SMS. Only the `tx` handle, no network.
   */
  private async onSendSettled(tx: Db, op: OpView): Promise<void> {
    const m = op.data.meta as unknown as SendMeta;
    const from = await this.d.users.byId(m.sender, tx);
    const to = await this.d.users.byId(m.recipient, tx);
    if (!from || !to) {
      this.log.error("wallet.settle.unknown_user", { op: op.id });
      return;
    }
    if (op.status === "failed") {
      await this.text(tx, from, "pay_failed", "sms.pay_failed", { fcfa: showFcfa(m.fcfa) });
      return;
    }
    if (op.status !== "done") return;

    const receipt = toSafeInt((await tx.query<{ n: number }>("SELECT nextval('receipt_no') AS n"))[0]!.n);
    const now = this.d.clock.now();
    const row = "INSERT INTO txlog (user_id, ts, kind, amount_sat, amount_fcfa, counterparty, counterparty_id, receipt_no, ref, spend) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)";
    await tx.query(row, [from.id, now, "send", -op.amountSat, -m.fcfa, to.name, to.id, receipt, op.id, true]);
    await tx.query(row, [to.id, now, "receive", op.amountSat, m.fcfa, from.name, from.id, receipt, op.id, false]);

    const left = satsToFcfa(await balance(tx, spendable(from.id)), m.rate);
    const got = satsToFcfa(await balance(tx, spendable(to.id)), m.rate);
    await this.text(tx, from, "sent", "sms.sent", { fcfa: showFcfa(m.fcfa), name: to.name, balance: showFcfa(left), receipt });
    await this.text(tx, to, "received", "sms.received", { fcfa: showFcfa(m.fcfa), name: from.name, balance: showFcfa(got), receipt });
  }

  // ---------- deposit ----------

  /**
   * Credit a Lightning payment that arrived on the gateway's node to a user, as ecash.
   * The caller names the user and the payment hash, nothing else: the amount is the one the node
   * reports, and only a settled invoice counts. Safe to call again with the same hash: the ledger
   * entry and the vault operation both carry the hash as their key, so the credit happens once, and
   * a second call for another user is refused (CONFLICT in the ledger).
   * PENDING means the sats are in and the mint has not answered yet: Vault.recover() finishes it,
   * and the history row and the SMS are written then.
   */
  async deposit(a: { userId: string; paymentHash: string }): Promise<DepositResult> {
    const user = await this.d.users.byId(a.userId);
    if (!user) return { ok: false, err: "NOT_FOUND" };
    if (typeof a.paymentHash !== "string" || !/^[0-9a-f]{64}$/.test(a.paymentHash)) return { ok: false, err: "NOT_PAID" };
    const inv = await this.d.ln.lookupInvoice(a.paymentHash);
    if (!inv || inv.state !== "settled" || !Number.isSafeInteger(inv.amountSat) || inv.amountSat <= 0) return { ok: false, err: "NOT_PAID" };
    const amountSat = inv.amountSat;
    const rate = await this.d.rates.get();

    let op: OpView;
    try {
      await post(this.d.db, this.d.clock, { kind: "ln.received", idemKey: `recv:${a.paymentHash}`, meta: { user: user.id }, postings: [{ account: "ext:lightning", delta: -amountSat }, { account: FLOAT_NODE, delta: amountSat }] });
      const meta: DepositMeta = { t: "deposit", user: user.id, rate: rate.xofPerBtc };
      op = await this.d.vault.mintFor({ idemKey: `mint:${a.paymentHash}`, owner: owner(user.id), amountSat, meta: { ...meta } });
    } catch (e) {
      this.log.error("wallet.deposit.failed", { user: user.id, err: e });
      return { ok: false, err: "GENERIC" };
    }
    if (op.status === "pending") {
      this.log.warn("wallet.deposit.pending", { user: user.id, op: op.id });
      return { ok: false, err: "PENDING" };
    }
    // The payment hash belongs to whoever it was first credited to.
    if (op.status === "failed" || op.owner !== owner(user.id)) return { ok: false, err: "GENERIC" };
    const stored = op.data.meta as Partial<DepositMeta> | undefined;
    this.log.info("wallet.deposit.done", { user: user.id, op: op.id, amountSat });
    return { ok: true, sats: amountSat, fcfa: satsToFcfa(amountSat, stored?.rate ?? rate.xofPerBtc) };
  }

  /**
   * Runs inside the transaction that completes or fails a deposit's mint operation (see settle.ts).
   * Done: one history row and one SMS. Failed (our node could not pay the mint): the sats went back to
   * float:node and belong to nobody in the books yet, so this is logged loudly and nothing is promised.
   */
  private async onDepositSettled(tx: Db, op: OpView): Promise<void> {
    const m = op.data.meta as unknown as DepositMeta;
    if (op.status === "failed") {
      this.log.error("wallet.deposit.mint_failed", { user: m.user, op: op.id, amountSat: op.amountSat });
      return;
    }
    if (op.status !== "done") return;
    const user = await this.d.users.byId(m.user, tx);
    if (!user) {
      this.log.error("wallet.settle.unknown_user", { op: op.id });
      return;
    }
    const got = satsToFcfa(op.amountSat, m.rate);
    const receipt = toSafeInt((await tx.query<{ n: number }>("SELECT nextval('receipt_no') AS n"))[0]!.n);
    await tx.query("INSERT INTO txlog (user_id, ts, kind, amount_sat, amount_fcfa, counterparty, counterparty_id, receipt_no, ref, spend) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)", [
      user.id,
      this.d.clock.now(),
      "deposit",
      op.amountSat,
      got,
      "Lightning",
      null,
      receipt,
      op.id,
      false,
    ]);
    const have = satsToFcfa(await balance(tx, spendable(user.id)), m.rate);
    await this.text(tx, user, "deposit", "sms.ln_received", { fcfa: showFcfa(got), comment: "", balance: showFcfa(have) });
  }

  /**
   * Queue one SMS in the user's language. A text that cannot be built is logged and skipped: a broken
   * sentence must never be the reason a settlement rolls back and leaves money locked.
   */
  private async text(tx: Db, user: User, kind: string, key: MessageKey, vars: Record<string, string | number>): Promise<void> {
    let body: string;
    try {
      body = assertGsm7(t(user.lang, key, vars));
    } catch (e) {
      this.log.error("wallet.sms.unbuildable", { user: user.id, message: key, err: e });
      return;
    }
    await this.d.outbox.queue(tx, { to: await this.d.users.phoneOf(user.id, tx), body, kind });
  }
}
