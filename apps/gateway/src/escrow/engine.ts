// The escrow engine: cash-in and cash-out through an agent, with the money locked while the francs move
// outside Melax.
// Cash-in: a hold invoice on the gateway's node for a hash whose preimage only this engine knows. The
// agent's wallet pays it; the payment is held (the agent's sats are locked, not delivered) until the
// agent says the francs arrived. Then the engine settles it and credits the user through the mint.
// Cash-out: the user's ecash moves to the vault owner escrow:<tradeId> until the user says the francs
// arrived. Then the escrow pays an invoice of the agent's wallet through the mint.
// Contract:
//   - escrow/trade.ts says which move is allowed. A move is applied with UPDATE ... WHERE state = <current>;
//     a move that changed no row lost a race and does nothing more;
//   - the order is always: store the trade, then call the network, then let the settle handler (or the
//     next step) record the outcome. An unknown outcome is never retried: the node or the vault is asked;
//   - every money step has its own idempotency key built from the trade id: cashin:<id>:credit[:n],
//     cashout:<id>:lock, cashout:<id>:pay:<n>, cashout:<id>:change[:n], cashout:<id>:refund[:n], slash:<id>[:n];
//   - history rows and SMS are written by the settle handlers below, inside the transaction that moves
//     the ecash. They use only the `tx` they are given and make no network call;
//   - the preimage leaves the database in one place, settleHeld();
//   - an agent's open cash-ins never add up to more than the agent's bond (checked under a lock on the
//     agent's row); a cash-in dispute that outlives its payment is paid from the bond;
//   - a closed cash-in's invoice is watched until it expires, and a payment that arrives late is
//     cancelled on sight (rule 15);
//   - nothing here logs a phone number, a name, an invoice, a preimage or a code.
// Callers: app.ts (wiring), ussd/perform.ts (the menus), http.ts (/ops/escrow/decide), demo.ts
// (/sim/decide), main.ts (sweep on a timer, watchInvoices).
import { createHash } from "node:crypto";
import { AppError, type Clock, HOUR, type Logger, MINUTE, fcfaToSats, isAppError, localPhone, newId, satsToFcfa, silentLogger, toSafeInt } from "@melax/core";
import { open, randomBytes, seal } from "@melax/crypto";
import { type MessageKey, fcfa as showFcfa, methodName, sats as showSats } from "@melax/i18n";
import { type Db, balance, post } from "@melax/ledger";
import { type LightningBackend, decodeInvoice, feeCapSat } from "@melax/lightning";
import { FLOAT_NODE, type OpView, type Vault } from "@melax/vault";
import type { Rates } from "../rates.ts";
import type { SettleRouter } from "../settle.ts";
import type { User, Users } from "../users.ts";
import type { Refusal, Wallet } from "../wallet.ts";
import { type Agent, type Agents, bondOwner, cashinSats, cashoutSats } from "./agents.ts";
import { OPEN_STATES, type TradeEvent, type TradeKind, type TradeState, next } from "./trade.ts";

/** How long each side has to act: the agent to confirm a cash-in, to mark a cash-out sent, the user to confirm it. */
export const WINDOW_MS = 45 * MINUTE;
/** A held cash-in payment is released by then, dispute or not. config.ts checks the block delta covers it. */
export const HARD_CAP_MS = 3 * HOUR;
/** A cash-in whose payment never arrived is given up after this. */
export const OPEN_TTL_MS = 10 * MINUTE;
const INVOICE_EXPIRY_SEC = 600;
/** How long the start of a cash-in waits for the agent's payment before the screen says an SMS will follow. */
export const HELD_WAIT_MS = 6000;
/** The fee the agent's wallet may spend to pay a hold invoice. It is the agent's cost. */
const AGENT_PAY_FEE_SAT = 20;
const DUE_NOW = 0;

const user = (id: string) => `user:${id}`;
const escrowOwner = (tradeId: string) => `escrow:${tradeId}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait before trying a failed money step again: 30 s, 1 min, 2 min ... up to 10 min. */
const backoff = (attempt: number) => Math.min(30_000 * 2 ** Math.min(attempt, 10), 10 * MINUTE);
const withAttempt = (key: string, attempt: number) => (attempt === 0 ? key : `${key}:${attempt}`);

interface TradeRow {
  id: string;
  ref: string;
  idem_key: string;
  kind: TradeKind;
  state: TradeState;
  user_id: string;
  agent_id: string;
  fcfa: number;
  sats: number;
  lock_sats: number;
  rate: number;
  method: string;
  payment_hash: string | null;
  preimage_sealed: Buffer | null;
  bolt11: string | null;
  invoice_expires_at: number | null;
  held_at: number | null;
  deadline_at: number;
  hard_cap_at: number | null;
  attempt: number;
  watch: boolean;
  winner: "user" | "agent" | null;
  created_at: number;
}

/** What callers and screens see of a trade. Names and the agent's number are filled in by view(). */
export interface TradeView {
  id: string;
  ref: string;
  kind: TradeKind;
  state: TradeState;
  fcfa: number;
  sats: number;
  lockSats: number;
  method: string;
  agentId: string;
  agentName: string;
  userName: string;
  userMasked: string;
}

export interface Offer {
  agentId: string;
  name: string;
  method: string;
  sats: number;
}

export type TradeRefusal =
  | { ok: false; err: "RANGE" | "AGENT_OFF" | "SELF" | "OPEN_TRADE" | "BOND" | "STATE" | "UNAVAILABLE" }
  | Refusal;
export type TradeResult = { ok: true; trade: TradeView } | TradeRefusal;

export interface EscrowDeps {
  db: Db;
  clock: Clock;
  log?: Logger;
  vault: Vault;
  /** The gateway's own node: makes, settles and cancels the hold invoices. */
  ln: LightningBackend;
  users: Users;
  agents: Agents;
  wallet: Wallet;
  rates: Rates;
  settle: SettleRouter;
  dataKey: Buffer;
  /** The short code as dialled, for the SMS that tell people where to confirm. */
  code: string;
  cltvBlocks: number;
}

const COLS = new Set(["deadline_at", "held_at", "hard_cap_at", "watch", "winner", "attempt", "bolt11"]);

export class Escrow {
  private readonly d: EscrowDeps;
  private readonly log: Logger;
  private readonly chains = new Map<string, Promise<unknown>>();
  private sweeping = false;

  constructor(deps: EscrowDeps) {
    this.d = deps;
    this.log = deps.log ?? silentLogger;
    const s = deps.settle;
    s.on("cashin", (tx, op) => this.onCredited(tx, op));
    s.on("slash", (tx, op) => this.onSlashed(tx, op));
    s.on("cashout_lock", (tx, op) => this.onLocked(tx, op));
    s.on("cashout_pay", (tx, op) => this.onPaid(tx, op));
    s.on("cashout_change", (tx, op) => this.onChangeBack(tx, op));
    s.on("cashout_refund", (tx, op) => this.onRefunded(tx, op));
    s.on("bond_in", (tx, op) => this.onBond(tx, op, -1));
    s.on("bond_out", (tx, op) => this.onBond(tx, op, 1));
  }

  // ---------- reading ----------

  private async row(id: string, db: Db = this.d.db): Promise<TradeRow | null> {
    return (await db.query<TradeRow>("SELECT * FROM trades WHERE id = $1", [id]))[0] ?? null;
  }

  async view(r: TradeRow, db: Db = this.d.db): Promise<TradeView> {
    const u = await this.d.users.byId(r.user_id, db);
    const a = await this.d.users.byId(r.agent_id, db);
    return {
      id: r.id,
      ref: r.ref,
      kind: r.kind,
      state: r.state,
      fcfa: toSafeInt(r.fcfa),
      sats: toSafeInt(r.sats),
      lockSats: toSafeInt(r.lock_sats),
      method: r.method,
      agentId: r.agent_id,
      agentName: a?.name ?? "",
      userName: u?.name ?? "",
      userMasked: u?.phoneMasked ?? "",
    };
  }

  async get(id: string): Promise<TradeView | null> {
    const r = await this.row(id);
    return r ? this.view(r) : null;
  }

  async byRef(ref: string): Promise<TradeView | null> {
    const r = (await this.d.db.query<TradeRow>("SELECT * FROM trades WHERE ref = $1", [String(ref ?? "").toUpperCase()]))[0];
    return r ? this.view(r) : null;
  }

  /** The user's trade that is not closed yet, if any. There is at most one. */
  async openTradeOf(u: User): Promise<TradeView | null> {
    const r = (await this.d.db.query<TradeRow>("SELECT * FROM trades WHERE user_id = $1 AND state = ANY($2::text[]) ORDER BY created_at DESC LIMIT 1", [u.id, [...OPEN_STATES]]))[0];
    return r ? this.view(r) : null;
  }

  /** The agent's oldest trade waiting for them: a held cash-in to confirm, or a locked cash-out to pay. */
  async nextFor(agent: User, kind: TradeKind): Promise<TradeView | null> {
    const r = (await this.d.db.query<TradeRow>("SELECT * FROM trades WHERE agent_id = $1 AND kind = $2 AND state = $3 ORDER BY created_at LIMIT 1", [agent.id, kind, kind === "cashin" ? "held" : "locked"]))[0];
    return r ? this.view(r) : null;
  }

  async deskCounts(agent: User): Promise<{ cashin: number; cashout: number }> {
    const rows = await this.d.db.query<{ kind: TradeKind; n: number }>(
      "SELECT kind, COUNT(*)::int AS n FROM trades WHERE agent_id = $1 AND ((kind = 'cashin' AND state = 'held') OR (kind = 'cashout' AND state = 'locked')) GROUP BY kind",
      [agent.id],
    );
    const n = (k: TradeKind) => toSafeInt(rows.find((r) => r.kind === k)?.n ?? 0);
    return { cashin: n("cashin"), cashout: n("cashout") };
  }

  /** The agent's mobile-money number, for the user of one of the agent's trades. Never log it. */
  async agentNumberFor(u: User, tradeId: string): Promise<string | null> {
    const r = await this.row(tradeId);
    if (!r || r.user_id !== u.id) return null;
    return localPhone(await this.d.agents.momoOf(r.agent_id));
  }

  /** The user's number, for the agent of one of the user's cash-outs (the francs go there). Never log it. */
  async userNumberFor(agent: User, tradeId: string): Promise<string | null> {
    const r = await this.row(tradeId);
    if (!r || r.agent_id !== agent.id || r.kind !== "cashout") return null;
    return localPhone(await this.d.users.phoneOf(r.user_id));
  }

  /** Agents who can take this trade, best for the user first, at most three (one USSD screen). */
  async offers(kind: TradeKind, u: User, fcfa: number): Promise<Offer[]> {
    if (!Number.isSafeInteger(fcfa) || fcfa <= 0) return [];
    const rate = (await this.d.rates.get()).xofPerBtc;
    const out: Offer[] = [];
    for (const a of await this.d.agents.active()) {
      if (a.userId === u.id || fcfa < a.minFcfa || fcfa > a.maxFcfa) continue;
      const sats = kind === "cashin" ? cashinSats(fcfa, rate, a.premiumBp) : cashoutSats(fcfa, rate, a.premiumBp);
      if (sats <= 0) continue;
      if (kind === "cashin" && (await this.d.agents.bondedSats(a.userId)) + sats > (await this.d.agents.bondSats(a.userId))) continue;
      out.push({ agentId: a.userId, name: a.name, method: a.method, sats });
      if (out.length === 3) break;
    }
    return out;
  }

  // ---------- moving a trade ----------

  /**
   * Apply one event to one trade: the table in trade.ts gives the next state, and the UPDATE only
   * succeeds if the trade is still where it was read. Returns the new row, or null when the move is not
   * allowed or another caller moved the trade first.
   */
  private async move(db: Db, r: TradeRow, event: TradeEvent, patch: Record<string, unknown> = {}): Promise<TradeRow | null> {
    const to = next(r.kind, r.state, event);
    if (!to) return null;
    const keys = Object.keys(patch).filter((k) => COLS.has(k));
    const sets = keys.map((k, i) => `${k} = $${i + 5}`);
    const rows = await db.query<TradeRow>(`UPDATE trades SET state = $3, updated_at = $4${sets.length ? ", " + sets.join(", ") : ""} WHERE id = $1 AND state = $2 RETURNING *`, [
      r.id,
      r.state,
      to,
      this.d.clock.now(),
      ...keys.map((k) => patch[k]),
    ]);
    // Field names matter: the logger hides "from" and "to" (phone numbers live there), and "event" is its own.
    if (rows[0]) this.log.info("escrow.move", { trade: r.id, kind: r.kind, prev: r.state, on: event, next: to });
    return rows[0] ?? null;
  }

  private async patch(id: string, patch: Record<string, unknown>, db: Db = this.d.db): Promise<void> {
    const keys = Object.keys(patch).filter((k) => COLS.has(k));
    if (keys.length === 0) return;
    await db.query(`UPDATE trades SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [id, ...keys.map((k) => patch[k])]);
  }

  /** One step at a time per trade in this process. Races across processes are settled by the state check in move(). */
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.chains.set(id, run);
    void run
      .catch(() => undefined)
      .finally(() => {
        if (this.chains.get(id) === run) this.chains.delete(id);
      });
    return run;
  }

  // ---------- SMS ----------

  private async sms(tx: Db, userId: string, kind: string, key: MessageKey, vars: Record<string, string | number>): Promise<void> {
    const u = await this.d.users.byId(userId, tx);
    if (u) await this.d.wallet.text(tx, u, kind, key, vars);
  }

  private async balanceFcfa(tx: Db, userId: string, rate: number): Promise<string> {
    return showFcfa(satsToFcfa(await balance(tx, `${user(userId)}:spendable`), rate));
  }

  private async receiptNo(tx: Db): Promise<number> {
    return toSafeInt((await tx.query<{ n: number }>("SELECT nextval('receipt_no') AS n"))[0]!.n);
  }

  private async history(tx: Db, a: { userId: string; kind: string; sats: number; fcfa: number; who: string; whoId: string | null; receipt: number; ref: string; spend: boolean }): Promise<void> {
    await tx.query("INSERT INTO txlog (user_id, ts, kind, amount_sat, amount_fcfa, counterparty, counterparty_id, receipt_no, ref, spend) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)", [
      a.userId,
      this.d.clock.now(),
      a.kind,
      a.sats,
      a.fcfa,
      a.who,
      a.whoId,
      a.receipt,
      a.ref,
      a.spend,
    ]);
  }

  private async names(tx: Db, r: TradeRow): Promise<{ user: string; agent: string }> {
    return { user: (await this.d.users.byId(r.user_id, tx))?.name ?? "", agent: (await this.d.users.byId(r.agent_id, tx))?.name ?? "" };
  }

  // ---------- starting ----------

  private async byIdem(idemKey: string): Promise<TradeRow | null> {
    return (await this.d.db.query<TradeRow>("SELECT * FROM trades WHERE idem_key = $1", [idemKey]))[0] ?? null;
  }

  private async hasOpenTrade(db: Db, userId: string): Promise<boolean> {
    return (await db.query("SELECT 1 FROM trades WHERE user_id = $1 AND state = ANY($2::text[]) LIMIT 1", [userId, [...OPEN_STATES]])).length > 0;
  }

  /** The checks both starts share. Null when the agent may take the trade. */
  private agentRefusal(agent: Agent | null, u: User, fcfa: number): TradeRefusal | null {
    if (!agent) return { ok: false, err: "NOT_FOUND" };
    if (agent.userId === u.id) return { ok: false, err: "SELF" };
    if (!agent.active) return { ok: false, err: "AGENT_OFF" };
    if (fcfa < agent.minFcfa || fcfa > agent.maxFcfa) return { ok: false, err: "RANGE" };
    return null;
  }

  /** The sats on the confirm screen must still be about what the francs are worth now (rule 53). */
  private drifted(shown: number, expected: number): boolean {
    return !Number.isSafeInteger(shown) || shown <= 0 || expected <= 0 || Math.abs(shown - expected) > Math.max(2, expected * 0.05);
  }

  /** Insert a trade row. A clash on the reference is retried; a clash on the user's one open trade is a refusal. */
  private async insert(fill: (tx: Db, id: string, ref: string) => Promise<TradeRefusal | null>, kind: TradeKind, userId: string, idemKey: string): Promise<{ id: string } | TradeRefusal> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newId("t", this.d.clock);
      const ref = (kind === "cashin" ? "D" : "R") + randomBytes(3).toString("hex").toUpperCase().slice(0, 5);
      try {
        const refused = await this.d.db.tx((tx) => fill(tx, id, ref));
        return refused ?? { id };
      } catch (e) {
        if (await this.byIdem(idemKey)) return { id: (await this.byIdem(idemKey))!.id };
        if (await this.hasOpenTrade(this.d.db, userId)) return { ok: false, err: "OPEN_TRADE" };
        if (!/unique|duplicate/i.test(e instanceof Error ? e.message : "")) throw e;
      }
    }
    throw new AppError("INTERNAL", "could not draw a free trade reference");
  }

  /**
   * Cash-in: the user will pay francs to the agent; the agent's sats are held in a payment to the
   * gateway's node meanwhile. No code: nothing of the user's moves. `sats` are the ones the confirm
   * screen showed. Returns once the payment is held or after HELD_WAIT_MS, whichever comes first.
   */
  async startCashin(a: { user: User; agentId: string; fcfa: number; sats: number; idemKey: string; waitMs?: number }): Promise<TradeResult> {
    const prior = await this.byIdem(a.idemKey);
    if (prior) return { ok: true, trade: await this.view(prior) };
    if (!Number.isSafeInteger(a.fcfa) || a.fcfa <= 0) return { ok: false, err: "BAD_INPUT" };
    if (await this.hasOpenTrade(this.d.db, a.user.id)) return { ok: false, err: "OPEN_TRADE" };
    const agent = await this.d.agents.get(a.agentId);
    const refused = this.agentRefusal(agent, a.user, a.fcfa);
    if (refused) return refused;
    const rate = (await this.d.rates.get()).xofPerBtc;
    if (this.drifted(a.sats, cashinSats(a.fcfa, rate, agent!.premiumBp))) {
      this.log.warn("escrow.start.quote_mismatch", { user: a.user.id, kind: "cashin" });
      return { ok: false, err: "GENERIC" };
    }

    const preimage = randomBytes(32);
    const hash = createHash("sha256").update(preimage).digest("hex");
    const now = this.d.clock.now();
    const made = await this.insert(
      async (tx, id, ref) => {
        const locked = await this.d.agents.lock(tx, a.agentId);
        const again = this.agentRefusal(locked, a.user, a.fcfa);
        if (again) return again;
        if (await this.hasOpenTrade(tx, a.user.id)) return { ok: false, err: "OPEN_TRADE" };
        if ((await this.d.agents.bondedSats(a.agentId, tx)) + a.sats > (await this.d.agents.bondSats(a.agentId, tx))) return { ok: false, err: "BOND" };
        await tx.query(
          `INSERT INTO trades (id, ref, idem_key, kind, state, user_id, agent_id, fcfa, sats, lock_sats, rate, method, payment_hash, preimage_sealed, invoice_expires_at, deadline_at, created_at, updated_at)
           VALUES ($1, $2, $3, 'cashin', 'open', $4, $5, $6, $7, $7, $8, $9, $10, $11, $12, $13, $14, $14)`,
          [id, ref, a.idemKey, a.user.id, a.agentId, a.fcfa, a.sats, rate, locked!.method, hash, seal(this.d.dataKey, preimage, `trade:preimage:${id}`), now + INVOICE_EXPIRY_SEC * 1000, now + OPEN_TTL_MS, now],
        );
        return null;
      },
      "cashin",
      a.user.id,
      a.idemKey,
    );
    if ("ok" in made) return made;
    const id = made.id;
    this.log.info("escrow.cashin.started", { trade: id, agent: a.agentId, sats: a.sats });

    // The plan is stored. Now the network: the invoice on our node, then the agent's wallet pays it.
    let bolt11: string;
    try {
      bolt11 = (await this.d.ln.makeHoldInvoice({ amountSat: a.sats, paymentHash: hash, memo: "Melax", expirySec: INVOICE_EXPIRY_SEC, cltvExpiry: this.d.cltvBlocks })).bolt11;
      await this.patch(id, { bolt11 });
      const payer = await this.d.agents.wallet(a.agentId);
      // Not awaited: a held payment only returns when it is settled or cancelled. The node tells us when it is held.
      void payer.pay({ bolt11, maxFeeSat: AGENT_PAY_FEE_SAT, timeoutSec: 60 }).then(
        (out) => this.log.info("escrow.cashin.agent_payment", { trade: id, status: out.status }),
        (err) => this.log.warn("escrow.cashin.agent_payment_failed", { trade: id, err }),
      );
    } catch (err) {
      this.log.error("escrow.cashin.invoice_failed", { trade: id, err });
      await this.serial(id, async () => {
        const r = await this.row(id);
        if (r && r.state === "open") await this.move(this.d.db, r, "timeout", { watch: true });
      });
      return { ok: false, err: "UNAVAILABLE" };
    }

    const rounds = Math.ceil((a.waitMs ?? HELD_WAIT_MS) / 300);
    for (let i = 0; i < rounds; i++) {
      await this.step(id);
      if ((await this.row(id))?.state !== "open") break;
      await sleep(300);
    }
    return { ok: true, trade: await this.view((await this.row(id))!) };
  }

  /**
   * Cash-out: the user's sats move to escrow:<tradeId> now, with an allowance for the Lightning fee of
   * the pay-out on top (what is not spent comes back). It is a spend: the code, the limits and the
   * balance are checked, in that order, in the same queue as the user's sends.
   */
  async startCashout(a: { user: User; agentId: string; fcfa: number; sats: number; pin: string; idemKey: string }): Promise<TradeResult> {
    const pin = await this.d.users.checkPin(a.user.id, a.pin, "spend");
    if (!pin.ok) return pin;
    return this.d.wallet.serial(a.user.id, async (): Promise<TradeResult> => {
      const prior = await this.byIdem(a.idemKey);
      if (prior) {
        await this.step(prior.id);
        return { ok: true, trade: await this.view((await this.row(prior.id))!) };
      }
      if (!Number.isSafeInteger(a.fcfa) || a.fcfa <= 0) return { ok: false, err: "BAD_INPUT" };
      if (await this.hasOpenTrade(this.d.db, a.user.id)) return { ok: false, err: "OPEN_TRADE" };
      const agent = await this.d.agents.get(a.agentId);
      const refused = this.agentRefusal(agent, a.user, a.fcfa);
      if (refused) return refused;
      const rate = (await this.d.rates.get()).xofPerBtc;
      if (this.drifted(a.sats, cashoutSats(a.fcfa, rate, agent!.premiumBp))) {
        this.log.warn("escrow.start.quote_mismatch", { user: a.user.id, kind: "cashout" });
        return { ok: false, err: "GENERIC" };
      }
      const lockSats = a.sats + feeCapSat(a.sats);
      const limit = await this.d.wallet.limitCheck(a.user, a.agentId, a.fcfa);
      if (!limit.ok) return { ok: false, err: "LIMIT", reason: limit.reason, allowedFcfa: limit.allowedFcfa };
      const have = await balance(this.d.db, `${user(a.user.id)}:spendable`);
      if (have < lockSats) return { ok: false, err: "INSUFFICIENT_FUNDS", balanceFcfa: satsToFcfa(have, rate) };

      const now = this.d.clock.now();
      const made = await this.insert(
        async (tx, id, ref) => {
          const locked = await this.d.agents.lock(tx, a.agentId);
          const again = this.agentRefusal(locked, a.user, a.fcfa);
          if (again) return again;
          if (await this.hasOpenTrade(tx, a.user.id)) return { ok: false, err: "OPEN_TRADE" };
          await tx.query(
            `INSERT INTO trades (id, ref, idem_key, kind, state, user_id, agent_id, fcfa, sats, lock_sats, rate, method, deadline_at, created_at, updated_at)
             VALUES ($1, $2, $3, 'cashout', 'locking', $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
            [id, ref, a.idemKey, a.user.id, a.agentId, a.fcfa, a.sats, lockSats, rate, locked!.method, now + MINUTE, now],
          );
          return null;
        },
        "cashout",
        a.user.id,
        a.idemKey,
      );
      if ("ok" in made) return made;
      this.log.info("escrow.cashout.started", { trade: made.id, agent: a.agentId, sats: a.sats });
      const refusal = await this.serial(made.id, () => this.lockStep(made.id, true));
      if (refusal) return refusal;
      return { ok: true, trade: await this.view((await this.row(made.id))!) };
    });
  }

  // ---------- the people's moves ----------

  /** A trade of `who` in the given role, or null. Somebody else's trade looks like no trade at all. */
  private async mine(tradeId: string, who: User, role: "user" | "agent", kind?: TradeKind): Promise<TradeRow | null> {
    const r = await this.row(String(tradeId ?? ""));
    if (!r || (role === "user" ? r.user_id : r.agent_id) !== who.id || (kind && r.kind !== kind)) return null;
    return r;
  }

  /** The agent says the francs of a cash-in arrived: settle the held payment and credit the user. */
  async agentConfirm(a: { agent: User; tradeId: string; pin: string }): Promise<TradeResult> {
    const r = await this.mine(a.tradeId, a.agent, "agent", "cashin");
    if (!r) return { ok: false, err: "NOT_FOUND" };
    const pin = await this.d.users.checkPin(a.agent.id, a.pin, "spend");
    if (!pin.ok) return pin;
    return this.serial(r.id, async () => {
      const cur = await this.row(r.id);
      const moved = cur && (await this.move(this.d.db, cur, "agentConfirm", { deadline_at: DUE_NOW }));
      if (!moved) return { ok: false, err: "STATE" } as TradeRefusal;
      await this.drive(moved.id);
      return { ok: true, trade: await this.view((await this.row(r.id))!) };
    });
  }

  /** The agent will not take this cash-out: the sats go back to the user. */
  async agentDecline(a: { agent: User; tradeId: string; pin: string }): Promise<TradeResult> {
    const r = await this.mine(a.tradeId, a.agent, "agent", "cashout");
    if (!r) return { ok: false, err: "NOT_FOUND" };
    const pin = await this.d.users.checkPin(a.agent.id, a.pin, "spend");
    if (!pin.ok) return pin;
    return this.serial(r.id, async () => {
      const cur = await this.row(r.id);
      const moved = cur && (await this.move(this.d.db, cur, "agentDecline", { deadline_at: DUE_NOW }));
      if (!moved) return { ok: false, err: "STATE" } as TradeRefusal;
      await this.drive(moved.id);
      return { ok: true, trade: await this.view((await this.row(r.id))!) };
    });
  }

  /** The agent says the francs of a cash-out left. Moves no money: it starts the user's 45 minutes. */
  async agentSent(a: { agent: User; tradeId: string; pin: string }): Promise<TradeResult> {
    const r = await this.mine(a.tradeId, a.agent, "agent", "cashout");
    if (!r) return { ok: false, err: "NOT_FOUND" };
    const pin = await this.d.users.checkPin(a.agent.id, a.pin, "spend");
    if (!pin.ok) return pin;
    return this.serial(r.id, async () => {
      const out = await this.d.db.tx(async (tx) => {
        const cur = await this.row(r.id, tx);
        const moved = cur && (await this.move(tx, cur, "agentSent", { deadline_at: this.d.clock.now() + WINDOW_MS }));
        if (!moved) return null;
        const n = await this.names(tx, moved);
        await this.sms(tx, moved.user_id, "wd_user_sent", "sms.wd_user_sent", { ref: moved.ref, agent: n.agent, fcfa: showFcfa(toSafeInt(moved.fcfa)), method: methodName(moved.method), ussd: this.d.code });
        return moved;
      });
      if (!out) return { ok: false, err: "STATE" } as TradeRefusal;
      return { ok: true, trade: await this.view(out) };
    });
  }

  /** The user says the francs of a cash-out arrived: the escrow pays the agent. */
  async userConfirm(a: { user: User; tradeId: string; pin: string }): Promise<TradeResult> {
    const r = await this.mine(a.tradeId, a.user, "user", "cashout");
    if (!r) return { ok: false, err: "NOT_FOUND" };
    const pin = await this.d.users.checkPin(a.user.id, a.pin, "spend");
    if (!pin.ok) return pin;
    return this.serial(r.id, async () => {
      const cur = await this.row(r.id);
      const moved = cur && (await this.move(this.d.db, cur, "userConfirm", { deadline_at: DUE_NOW }));
      if (!moved) return { ok: false, err: "STATE" } as TradeRefusal;
      await this.drive(moved.id);
      return { ok: true, trade: await this.view((await this.row(r.id))!) };
    });
  }

  /** The user gives up a cash-in before it is confirmed. The agent's sats go back. Not offered for a cash-out. */
  async cancel(a: { user: User; tradeId: string }): Promise<TradeResult> {
    const r = await this.mine(a.tradeId, a.user, "user", "cashin");
    if (!r) return { ok: false, err: "NOT_FOUND" };
    return this.serial(r.id, async () => {
      const cur = await this.row(r.id);
      const moved = cur && (await this.expire(cur, "cancel"));
      if (!moved) return { ok: false, err: "STATE" } as TradeRefusal;
      return { ok: true, trade: await this.view(moved) };
    });
  }

  /** The user says something is wrong. An arbiter decides; until then nothing moves. */
  async dispute(a: { user: User; tradeId: string }): Promise<TradeResult> {
    const r = await this.mine(a.tradeId, a.user, "user");
    if (!r) return { ok: false, err: "NOT_FOUND" };
    return this.serial(r.id, async () => {
      const out = await this.d.db.tx(async (tx) => {
        const cur = await this.row(r.id, tx);
        // A disputed cash-in waits for its hard cap; a disputed cash-out waits for the arbiter.
        const deadline = cur?.kind === "cashin" ? toSafeInt(cur.hard_cap_at ?? this.d.clock.now() + HARD_CAP_MS) : this.d.clock.now() + 365 * 24 * HOUR;
        const moved = cur && (await this.move(tx, cur, "dispute", { deadline_at: deadline }));
        if (!moved) return null;
        await this.disputeSms(tx, moved);
        return moved;
      });
      if (!out) return { ok: false, err: "STATE" } as TradeRefusal;
      return { ok: true, trade: await this.view(out) };
    });
  }

  private async disputeSms(tx: Db, r: TradeRow): Promise<void> {
    const vars = { ref: r.ref, method: methodName(r.method) };
    await this.sms(tx, r.user_id, "dispute", "sms.dispute", vars);
    await this.sms(tx, r.agent_id, "dispute", "sms.dispute", vars);
  }

  /**
   * The arbiter's decision on a dispute. Does the money and writes one audit_log row. Recorded, not
   * signed: signing comes with the Nostr keys of phase 10.
   */
  async decide(a: { tradeId: string; winner: "user" | "agent"; arbiter: string; note?: string }): Promise<TradeResult> {
    if (a.winner !== "user" && a.winner !== "agent") return { ok: false, err: "BAD_INPUT" };
    if (typeof a.arbiter !== "string" || !/^[\w.@-]{1,64}$/.test(a.arbiter)) return { ok: false, err: "BAD_INPUT" };
    const note = typeof a.note === "string" ? a.note.slice(0, 500) : "";
    const r = await this.row(String(a.tradeId ?? ""));
    if (!r) return { ok: false, err: "NOT_FOUND" };
    return this.serial(r.id, async () => {
      const out = await this.d.db.tx(async (tx) => {
        const cur = await this.row(r.id, tx);
        if (!cur) return null;
        const event: TradeEvent = a.winner === "user" ? "decideUser" : "decideAgent";
        const moved = await this.move(tx, cur, event, { winner: a.winner, deadline_at: DUE_NOW, watch: cur.kind === "cashin" && a.winner === "agent" });
        if (!moved) return null;
        await tx.query("INSERT INTO audit_log (ts, actor, action, subject, data) VALUES ($1, $2, 'escrow.decide', $3, $4::jsonb)", [
          this.d.clock.now(),
          a.arbiter,
          r.id,
          JSON.stringify({ winner: a.winner, from: cur.state, to: moved.state, note }),
        ]);
        await this.sms(tx, moved.user_id, "dispute_result", a.winner === "user" ? "sms.dispute_won" : "sms.dispute_lost", { ref: moved.ref });
        await this.sms(tx, moved.agent_id, "dispute_result", a.winner === "agent" ? "sms.dispute_won" : "sms.dispute_lost", { ref: moved.ref });
        return moved;
      });
      if (!out) return { ok: false, err: "STATE" } as TradeRefusal;
      this.log.info("escrow.decided", { trade: r.id, winner: a.winner });
      await this.drive(r.id);
      return { ok: true, trade: await this.view((await this.row(r.id))!) };
    });
  }

  // ---------- bonds ----------

  /** Move sats from the agent's own balance into their bond. */
  async bondAdd(a: { agent: User; fcfa: number; pin: string; idemKey: string }): Promise<{ ok: true; sats: number } | TradeRefusal> {
    if (!(await this.d.agents.get(a.agent.id))) return { ok: false, err: "NOT_FOUND" };
    const pin = await this.d.users.checkPin(a.agent.id, a.pin, "spend");
    if (!pin.ok) return pin;
    if (!Number.isSafeInteger(a.fcfa) || a.fcfa <= 0) return { ok: false, err: "BAD_INPUT" };
    const rate = (await this.d.rates.get()).xofPerBtc;
    const sats = fcfaToSats(a.fcfa, rate);
    return this.d.wallet.serial(a.agent.id, async () => {
      try {
        const op = await this.d.vault.transfer({ idemKey: a.idemKey, from: user(a.agent.id), to: bondOwner(a.agent.id), amountSat: sats, meta: { t: "bond_in", agent: a.agent.id, rate } });
        if (op.status === "pending") return { ok: false, err: "PENDING" } as TradeRefusal;
        if (op.status === "failed") return { ok: false, err: "GENERIC" } as TradeRefusal;
        return { ok: true as const, sats: await this.d.agents.bondSats(a.agent.id) };
      } catch (e) {
        if (isAppError(e, "INSUFFICIENT_FUNDS")) return { ok: false, err: "INSUFFICIENT_FUNDS", balanceFcfa: satsToFcfa(await balance(this.d.db, `${user(a.agent.id)}:spendable`), rate) } as TradeRefusal;
        if (isAppError(e, "BUSY")) return { ok: false, err: "BUSY" } as TradeRefusal;
        this.log.error("escrow.bond.add_failed", { agent: a.agent.id, err: e });
        return { ok: false, err: "GENERIC" } as TradeRefusal;
      }
    });
  }

  /**
   * Take the whole bond back. Refused while any trade of the agent is open, disputes included. The
   * offer is paused in the same transaction, so no cash-in can start against a bond on its way out.
   */
  async bondOut(a: { agent: User; pin: string; idemKey: string }): Promise<{ ok: true; sats: number } | TradeRefusal> {
    if (!(await this.d.agents.get(a.agent.id))) return { ok: false, err: "NOT_FOUND" };
    const pin = await this.d.users.checkPin(a.agent.id, a.pin, "spend");
    if (!pin.ok) return pin;
    const refused = await this.d.db.tx(async (tx) => {
      await this.d.agents.lock(tx, a.agent.id);
      const open = await tx.query("SELECT 1 FROM trades WHERE agent_id = $1 AND state = ANY($2::text[]) LIMIT 1", [a.agent.id, [...OPEN_STATES]]);
      if (open.length > 0) return true;
      await tx.query("UPDATE agents SET active = FALSE WHERE user_id = $1", [a.agent.id]);
      return false;
    });
    if (refused) return { ok: false, err: "OPEN_TRADE" };
    try {
      const rate = (await this.d.rates.get()).xofPerBtc;
      const op = await this.d.vault.transfer({ idemKey: a.idemKey, from: bondOwner(a.agent.id), to: user(a.agent.id), amountSat: "all", meta: { t: "bond_out", agent: a.agent.id, rate } });
      if (op.status === "pending") return { ok: false, err: "PENDING" };
      if (op.status === "failed") return { ok: false, err: "GENERIC" };
      return { ok: true, sats: op.amountSat };
    } catch (e) {
      if (isAppError(e, "INSUFFICIENT_FUNDS")) return { ok: true, sats: 0 };
      if (isAppError(e, "BUSY")) return { ok: false, err: "BUSY" };
      this.log.error("escrow.bond.out_failed", { agent: a.agent.id, err: e });
      return { ok: false, err: "GENERIC" };
    }
  }

  // ---------- driving trades forward ----------

  /** Take one trade as far as it can go right now. Safe to call at any time, any number of times, from anywhere. */
  async step(id: string): Promise<void> {
    await this.serial(id, () => this.stepNow(id));
  }

  /** Step until the trade stops moving (a pay-out, then its change), at most a few rounds. For callers inside serial(id). */
  private async drive(id: string): Promise<void> {
    for (let i = 0; i < 5; i++) {
      const before = (await this.row(id))?.state;
      await this.stepNow(id);
      if ((await this.row(id))?.state === before) return;
    }
  }

  /** step() without the queue: for callers already inside serial(id). */
  private async stepNow(id: string): Promise<void> {
    const r = await this.row(id);
    if (!r) return;
    const now = this.d.clock.now();
    if (r.kind === "cashin") {
      switch (r.state) {
        case "open":
          return this.openStep(r, now);
        case "held":
          return this.heldStep(r, now);
        case "settling":
          return this.creditStep(r, now);
        case "disputed":
          return this.disputedStep(r, now);
        case "bonding":
          return this.slashStep(r, now);
        default:
          if (r.watch) return this.watchStep(r, now);
          return;
      }
    }
    switch (r.state) {
      case "locking":
        await this.lockStep(r.id, false);
        return;
      case "locked":
        if (now >= toSafeInt(r.deadline_at)) {
          const moved = await this.move(this.d.db, r, "timeout", { deadline_at: DUE_NOW });
          if (moved) await this.refundStep(moved, now);
        }
        return;
      case "sent":
        if (now >= toSafeInt(r.deadline_at)) {
          // The agent says the francs left and the user says nothing: nobody can be believed without a look.
          await this.d.db.tx(async (tx) => {
            const moved = await this.move(tx, r, "timeout", { deadline_at: now + 365 * 24 * HOUR });
            if (moved) await this.disputeSms(tx, moved);
          });
        }
        return;
      case "paying":
        return this.payStep(r, now);
      case "returning":
        return this.changeStep(r, now);
      case "refunding":
        return this.refundStep(r, now);
      default:
        return;
    }
  }

  /** Every trade that is not closed, and every closed cash-in still being watched. Run on boot and on a timer. */
  async sweep(): Promise<{ checked: number }> {
    if (this.sweeping) return { checked: 0 };
    this.sweeping = true;
    try {
      const rows = await this.d.db.query<{ id: string }>("SELECT id FROM trades WHERE state = ANY($1::text[]) OR watch ORDER BY created_at LIMIT 500", [[...OPEN_STATES]]);
      for (const { id } of rows) {
        await this.step(id).catch((err) => this.log.error("escrow.step_failed", { trade: id, err }));
      }
      return { checked: rows.length };
    } finally {
      this.sweeping = false;
    }
  }

  /** Push from the gateway's node: a held or settled invoice of a trade gets its step at once instead of at the next sweep. */
  watchInvoices(): () => void {
    return this.d.ln.subscribeInvoices((s) => {
      void (async () => {
        const r = (await this.d.db.query<{ id: string }>("SELECT id FROM trades WHERE payment_hash = $1", [s.paymentHash]))[0];
        if (r) await this.step(r.id);
      })().catch((err) => this.log.warn("escrow.watch_failed", { err }));
    });
  }

  // ---------- cash-in steps ----------

  private async openStep(r: TradeRow, now: number): Promise<void> {
    const inv = r.payment_hash ? await this.d.ln.lookupInvoice(r.payment_hash) : null;
    if (inv?.state === "accepted") {
      if (inv.amountSat !== toSafeInt(r.sats)) {
        this.log.error("escrow.cashin.wrong_amount_held", { trade: r.id });
        await this.expire(r, "timeout");
        return;
      }
      await this.d.db.tx(async (tx) => {
        const moved = await this.move(tx, r, "held", { held_at: now, deadline_at: now + WINDOW_MS, hard_cap_at: now + HARD_CAP_MS });
        if (!moved) return;
        const n = await this.names(tx, moved);
        const fcfa = showFcfa(toSafeInt(moved.fcfa));
        const method = methodName(moved.method);
        const number = localPhone(await this.d.agents.momoOf(moved.agent_id, tx));
        await this.sms(tx, moved.user_id, "dep_user", "sms.dep_user", { ref: moved.ref, fcfa, method, number, agent: n.agent, sats: showSats(toSafeInt(moved.sats)) });
        const masked = (await this.d.users.byId(moved.user_id, tx))?.phoneMasked ?? "";
        await this.sms(tx, moved.agent_id, "dep_agent", "sms.dep_agent", { ref: moved.ref, masked, fcfa, method, ussd: this.d.code });
      });
      return;
    }
    if (now >= toSafeInt(r.deadline_at) || inv?.state === "cancelled") await this.expire(r, "timeout");
  }

  private async heldStep(r: TradeRow, now: number): Promise<void> {
    if (now >= toSafeInt(r.deadline_at)) {
      await this.expire(r, "timeout");
      return;
    }
    // The node let go of the payment on its own (it outlived its block limit): nothing is held any more.
    const inv = await this.d.ln.lookupInvoice(r.payment_hash!);
    if (inv?.state === "cancelled") await this.expire(r, "timeout");
  }

  /** Close a cash-in with nothing moved, tell both sides, then give the agent's payment back. */
  private async expire(r: TradeRow, event: "timeout" | "cancel"): Promise<TradeRow | null> {
    const wasHeld = r.state === "held";
    const moved = await this.d.db.tx(async (tx) => {
      const m = await this.move(tx, r, event, { watch: true });
      if (!m) return null;
      await this.sms(tx, m.user_id, "dep_cancel", "sms.dep_cancel", { ref: m.ref });
      if (wasHeld) await this.sms(tx, m.agent_id, "dep_cancel", "sms.dep_agent_cancel", { ref: m.ref, sats: showSats(toSafeInt(m.sats)) });
      return m;
    });
    if (moved) await this.watchStep(moved, this.d.clock.now());
    return moved;
  }

  private async disputedStep(r: TradeRow, now: number): Promise<void> {
    const inv = await this.d.ln.lookupInvoice(r.payment_hash!);
    if (now >= toSafeInt(r.hard_cap_at ?? r.deadline_at) || inv?.state === "cancelled") {
      // The payment cannot stay held any longer. The agent gets the sats back; a decision for the user
      // will be paid from the bond, which is why open cash-ins are capped by it.
      const moved = await this.move(this.d.db, r, "hardCap", { watch: true });
      if (moved) await this.watchStep(moved, now);
    }
  }

  /** The one place a preimage is read: settle the held payment with it. */
  private async settleHeld(r: TradeRow): Promise<void> {
    if (!r.preimage_sealed) throw new AppError("INTERNAL", "a cash-in has no preimage");
    const preimage = open(this.d.dataKey, Buffer.from(r.preimage_sealed), `trade:preimage:${r.id}`).toString("hex");
    await this.d.ln.settle(preimage);
  }

  private async creditStep(r: TradeRow, now: number): Promise<void> {
    if (r.attempt > 0 && now < toSafeInt(r.deadline_at)) return;
    let inv = await this.d.ln.lookupInvoice(r.payment_hash!);
    if (inv?.state === "accepted") {
      try {
        await this.settleHeld(r);
      } catch (err) {
        // No answer from our node: whether it settled is unknown. The next step asks it again.
        this.log.warn("escrow.cashin.settle_unknown", { trade: r.id, err });
        await this.patch(r.id, { deadline_at: now + backoff(0) });
        return;
      }
      inv = await this.d.ln.lookupInvoice(r.payment_hash!);
    }
    if (inv?.state === "cancelled") {
      // Confirmed, but the payment was gone before it could be settled: the bond pays the user.
      const moved = await this.move(this.d.db, r, "lost", { deadline_at: DUE_NOW });
      if (moved) await this.slashStep(moved, now);
      return;
    }
    if (inv?.state !== "settled") return;
    if (inv.amountSat !== toSafeInt(r.sats)) {
      this.log.error("escrow.cashin.wrong_amount_settled", { trade: r.id });
      return;
    }
    // From here it is a deposit (rule 55): the node says settled, for this amount, once per payment hash.
    await post(this.d.db, this.d.clock, { kind: "ln.received", idemKey: `recv:${r.payment_hash}`, meta: { user: r.user_id }, postings: [{ account: "ext:lightning", delta: -inv.amountSat }, { account: FLOAT_NODE, delta: inv.amountSat }] });
    let op: OpView;
    try {
      op = await this.d.vault.mintFor({ idemKey: withAttempt(`cashin:${r.id}:credit`, r.attempt), owner: user(r.user_id), amountSat: inv.amountSat, meta: { t: "cashin", trade: r.id } });
    } catch (err) {
      this.log.warn("escrow.cashin.credit_error", { trade: r.id, err });
      await this.patch(r.id, { deadline_at: now + backoff(r.attempt) });
      return;
    }
    // A mint payment that failed for good left the sats in float:node: ask again later under a new key.
    if (op.status === "failed") await this.patch(r.id, { attempt: r.attempt + 1, deadline_at: now + backoff(r.attempt) });
  }

  private async slashStep(r: TradeRow, now: number): Promise<void> {
    if (r.attempt > 0 && now < toSafeInt(r.deadline_at)) return;
    const key = withAttempt(`slash:${r.id}`, r.attempt);
    try {
      const op = await this.d.vault.transfer({ idemKey: key, from: bondOwner(r.agent_id), to: user(r.user_id), amountSat: toSafeInt(r.sats), meta: { t: "slash", trade: r.id } });
      if (op.status === "failed") await this.patch(r.id, { attempt: r.attempt + 1, deadline_at: now + backoff(r.attempt) });
    } catch (err) {
      this.log.error("escrow.slash_failed", { trade: r.id, err });
      await this.patch(r.id, { deadline_at: now + backoff(r.attempt) });
    }
  }

  /** Rule 15: a closed cash-in's invoice is watched until it expires, and a payment held on it is given back. */
  private async watchStep(r: TradeRow, now: number): Promise<void> {
    if (!r.payment_hash) {
      await this.patch(r.id, { watch: false });
      return;
    }
    const inv = await this.d.ln.lookupInvoice(r.payment_hash).catch(() => undefined);
    if (inv === undefined) return; // the node did not answer: next round
    if (inv === null) {
      if (now > toSafeInt(r.invoice_expires_at ?? 0)) await this.patch(r.id, { watch: false });
      return;
    }
    if (inv.state === "accepted" || inv.state === "open") {
      const done = await this.d.ln.cancel(r.payment_hash).catch((err) => {
        this.log.warn("escrow.cancel_failed", { trade: r.id, err });
        return false;
      });
      if (inv.state === "accepted") this.log.info("escrow.cashin.payment_returned", { trade: r.id, cancelled: done });
      return;
    }
    if (inv.state === "settled") {
      this.log.error("escrow.cashin.closed_but_settled", { trade: r.id });
      await this.patch(r.id, { watch: false });
      return;
    }
    // Cancelled. Some wallets cannot cancel an unpaid invoice and it stays payable until it expires, so
    // keep looking until then.
    if (now > toSafeInt(r.invoice_expires_at ?? 0)) await this.patch(r.id, { watch: false });
  }

  // ---------- cash-out steps ----------

  /** Move the user's sats into escrow:<tradeId>. Returns a refusal only for the start() that called it. */
  private async lockStep(id: string, fromStart: boolean): Promise<TradeRefusal | null> {
    const r = await this.row(id);
    if (!r || r.state !== "locking") return null;
    const key = `cashout:${r.id}:lock`;
    const prior = await this.d.vault.findOp(key);
    if (prior) {
      if (prior.status === "pending") await this.d.vault.resume(prior.id);
      return null;
    }
    if (!fromStart) {
      // No operation was ever stored: the process stopped between the trade row and the vault. Nothing moved.
      if (this.d.clock.now() >= toSafeInt(r.deadline_at)) await this.move(this.d.db, r, "lockFailed");
      return null;
    }
    try {
      const op = await this.d.vault.transfer({ idemKey: key, from: user(r.user_id), to: escrowOwner(r.id), amountSat: toSafeInt(r.lock_sats), meta: { t: "cashout_lock", trade: r.id } });
      if (op.status === "failed") return { ok: false, err: "GENERIC" };
      return null;
    } catch (e) {
      const cur = await this.row(id);
      if (cur?.state === "locking" && !(await this.d.vault.findOp(key))) await this.move(this.d.db, cur, "lockFailed");
      if (isAppError(e, "INSUFFICIENT_FUNDS")) return { ok: false, err: "INSUFFICIENT_FUNDS", balanceFcfa: satsToFcfa(await balance(this.d.db, `${user(r.user_id)}:spendable`), toSafeInt(r.rate)) };
      if (isAppError(e, "BUSY")) return { ok: false, err: "BUSY" };
      this.log.error("escrow.cashout.lock_failed", { trade: r.id, err: e });
      return { ok: false, err: "GENERIC" };
    }
  }

  private async payStep(r: TradeRow, now: number): Promise<void> {
    if (now < toSafeInt(r.deadline_at)) return;
    const key = `cashout:${r.id}:pay:${r.attempt}`;
    const prior = await this.d.vault.findOp(key);
    if (prior?.status === "pending") {
      await this.d.vault.resume(prior.id);
      return;
    }
    if (prior?.status === "failed") {
      // That invoice could not be paid. Nothing left the escrow: try again later with a fresh invoice.
      await this.patch(r.id, { attempt: r.attempt + 1, deadline_at: now + backoff(r.attempt) });
      return;
    }
    if (prior) return; // done: the settle handler has moved the trade on
    try {
      const payee = await this.d.agents.wallet(r.agent_id);
      const inv = await payee.makeInvoice({ amountSat: toSafeInt(r.sats), memo: "Melax", expirySec: 600 });
      if (decodeInvoice(inv.bolt11).amountSat !== toSafeInt(r.sats)) throw new AppError("UPSTREAM", "the agent's wallet made an invoice for another amount");
      const op = await this.d.vault.melt({ idemKey: key, owner: escrowOwner(r.id), bolt11: inv.bolt11, maxFeeSat: toSafeInt(r.lock_sats) - toSafeInt(r.sats), meta: { t: "cashout_pay", trade: r.id } });
      if (op.status === "failed") await this.patch(r.id, { attempt: r.attempt + 1, deadline_at: now + backoff(r.attempt) });
    } catch (err) {
      this.log.warn("escrow.cashout.pay_error", { trade: r.id, err });
      const stored = await this.d.vault.findOp(key);
      await this.patch(r.id, stored?.status === "failed" ? { attempt: r.attempt + 1, deadline_at: now + backoff(r.attempt) } : { deadline_at: now + backoff(r.attempt) });
    }
  }

  /** Give back to `user:<id>` everything left in escrow:<tradeId>, under `key` (with the attempt number after a failure). */
  private async emptyEscrow(r: TradeRow, now: number, key: string, t: "cashout_change" | "cashout_refund"): Promise<"empty" | "moved" | "later"> {
    if (r.attempt > 0 && now < toSafeInt(r.deadline_at)) return "later";
    const k = withAttempt(key, r.attempt);
    const prior = await this.d.vault.findOp(k);
    if (prior?.status === "pending") {
      await this.d.vault.resume(prior.id);
      return "later";
    }
    if (prior?.status === "failed") {
      await this.patch(r.id, { attempt: r.attempt + 1, deadline_at: now + backoff(r.attempt) });
      return "later";
    }
    if (prior) return "moved";
    const owner = escrowOwner(r.id);
    if ((await balance(this.d.db, `${owner}:spendable`)) + (await balance(this.d.db, `${owner}:locked`)) === 0) return "empty";
    try {
      const op = await this.d.vault.transfer({ idemKey: k, from: owner, to: user(r.user_id), amountSat: "all", meta: { t, trade: r.id } });
      if (op.status === "failed") await this.patch(r.id, { attempt: r.attempt + 1, deadline_at: now + backoff(r.attempt) });
      return "moved";
    } catch (err) {
      this.log.warn("escrow.cashout.return_error", { trade: r.id, err });
      await this.patch(r.id, { deadline_at: now + backoff(r.attempt) });
      return "later";
    }
  }

  private async changeStep(r: TradeRow, now: number): Promise<void> {
    if ((await this.emptyEscrow(r, now, `cashout:${r.id}:change`, "cashout_change")) === "empty") {
      await this.d.db.tx(async (tx) => {
        const moved = await this.move(tx, r, "changeBack");
        if (moved) await this.doneSms(tx, moved);
      });
    }
  }

  private async refundStep(r: TradeRow, now: number): Promise<void> {
    if ((await this.emptyEscrow(r, now, `cashout:${r.id}:refund`, "cashout_refund")) === "empty") {
      this.log.error("escrow.cashout.refund_with_empty_escrow", { trade: r.id });
    }
  }

  private async doneSms(tx: Db, r: TradeRow): Promise<void> {
    await this.sms(tx, r.user_id, "cashout", "sms.wd_done_user", { ref: r.ref, fcfa: showFcfa(toSafeInt(r.fcfa)), balance: await this.balanceFcfa(tx, r.user_id, toSafeInt(r.rate)) });
  }

  // ---------- settle handlers: inside the transaction that moves the ecash, no network ----------

  private async tradeOf(tx: Db, op: OpView): Promise<TradeRow | null> {
    const id = (op.data.meta as { trade?: unknown } | undefined)?.trade;
    if (typeof id !== "string") return null;
    const r = await this.row(id, tx);
    if (!r) this.log.error("escrow.settle.unknown_trade", { op: op.id });
    return r;
  }

  /** The user's ecash for a cash-in exists: the trade is done. History for both sides, SMS for both. */
  private async onCredited(tx: Db, op: OpView): Promise<void> {
    const r = await this.tradeOf(tx, op);
    if (!r) return;
    if (op.status === "failed") {
      this.log.error("escrow.cashin.mint_failed", { trade: r.id, op: op.id });
      return;
    }
    if (op.status !== "done") return;
    const moved = await this.move(tx, r, "credited");
    if (!moved) return;
    await this.deliveredHistory(tx, moved, op.id, "cashin");
    await this.sms(tx, moved.agent_id, "dep_agent_done", "sms.dep_agent_done", { ref: moved.ref, sats: showSats(toSafeInt(moved.sats)), name: (await this.names(tx, moved)).user });
  }

  /** The bond paid a user whose cash-in was lost or released. */
  private async onSlashed(tx: Db, op: OpView): Promise<void> {
    const r = await this.tradeOf(tx, op);
    if (!r || op.status !== "done") return;
    const moved = await this.move(tx, r, "slashed");
    if (moved) await this.deliveredHistory(tx, moved, op.id, "slash");
  }

  private async deliveredHistory(tx: Db, r: TradeRow, opId: string, agentKind: "cashin" | "slash"): Promise<void> {
    const n = await this.names(tx, r);
    const fcfa = toSafeInt(r.fcfa);
    const sats = toSafeInt(r.sats);
    const receipt = await this.receiptNo(tx);
    await this.history(tx, { userId: r.user_id, kind: "cashin", sats, fcfa, who: n.agent, whoId: r.agent_id, receipt, ref: opId, spend: false });
    await this.history(tx, { userId: r.agent_id, kind: agentKind === "cashin" ? "cashin_agent" : "slash", sats: -sats, fcfa: -fcfa, who: n.user, whoId: r.user_id, receipt, ref: opId, spend: false });
    await this.sms(tx, r.user_id, "cashin", "sms.dep_done", { ref: r.ref, fcfa: showFcfa(fcfa), balance: await this.balanceFcfa(tx, r.user_id, toSafeInt(r.rate)) });
  }

  /** The user's sats are in escrow. From now on they count toward the user's limits (a refund gives the room back). */
  private async onLocked(tx: Db, op: OpView): Promise<void> {
    const r = await this.tradeOf(tx, op);
    if (!r) return;
    if (op.status === "failed") {
      await this.move(tx, r, "lockFailed");
      return;
    }
    if (op.status !== "done") return;
    const moved = await this.move(tx, r, "locked", { deadline_at: this.d.clock.now() + WINDOW_MS });
    if (!moved) return;
    const n = await this.names(tx, moved);
    const fcfa = toSafeInt(moved.fcfa);
    await this.history(tx, { userId: moved.user_id, kind: "cashout", sats: -toSafeInt(moved.lock_sats), fcfa: -fcfa, who: n.agent, whoId: moved.agent_id, receipt: await this.receiptNo(tx), ref: op.id, spend: true });
    const number = localPhone(await this.d.users.phoneOf(moved.user_id, tx));
    await this.sms(tx, moved.agent_id, "wd_agent", "sms.wd_agent", { ref: moved.ref, fcfa: showFcfa(fcfa), method: methodName(moved.method), number, name: n.user, ussd: this.d.code });
  }

  /** The agent's wallet was paid from the escrow. */
  private async onPaid(tx: Db, op: OpView): Promise<void> {
    const r = await this.tradeOf(tx, op);
    if (!r || op.status !== "done") return; // a failed pay-out is retried by payStep under a new key
    const moved = await this.move(tx, r, "paid", { deadline_at: DUE_NOW, attempt: 0 });
    if (!moved) return;
    const n = await this.names(tx, moved);
    await this.history(tx, { userId: moved.agent_id, kind: "cashout_agent", sats: toSafeInt(moved.sats), fcfa: toSafeInt(moved.fcfa), who: n.user, whoId: moved.user_id, receipt: await this.receiptNo(tx), ref: op.id, spend: false });
    await this.sms(tx, moved.agent_id, "wd_done_agent", "sms.wd_done_agent", { ref: moved.ref, sats: showSats(toSafeInt(moved.sats)) });
  }

  /** What was left of the fee allowance is back with the user: the cash-out is done. */
  private async onChangeBack(tx: Db, op: OpView): Promise<void> {
    const r = await this.tradeOf(tx, op);
    if (!r || op.status !== "done") return;
    const moved = await this.move(tx, r, "changeBack");
    if (moved) await this.doneSms(tx, moved);
  }

  /** Every locked sat is back with the user. The francs of the cash-out count no more toward the limits. */
  private async onRefunded(tx: Db, op: OpView): Promise<void> {
    const r = await this.tradeOf(tx, op);
    if (!r || op.status !== "done") return;
    const moved = await this.move(tx, r, "refunded");
    if (!moved) return;
    const n = await this.names(tx, moved);
    const fcfa = toSafeInt(moved.fcfa);
    await this.history(tx, { userId: moved.user_id, kind: "cashout_refund", sats: op.amountSat, fcfa, who: n.agent, whoId: moved.agent_id, receipt: await this.receiptNo(tx), ref: op.id, spend: true });
    await this.sms(tx, moved.user_id, "wd_cancel", "sms.wd_cancel", { ref: moved.ref, fcfa: showFcfa(fcfa) });
    await this.sms(tx, moved.agent_id, "wd_cancel", "sms.wd_agent_cancel", { ref: moved.ref });
  }

  /** Sats moved between an agent's balance and their bond: one history row, no SMS (the screen says it). */
  private async onBond(tx: Db, op: OpView, sign: 1 | -1): Promise<void> {
    if (op.status !== "done") return;
    const meta = op.data.meta as { agent?: unknown; rate?: unknown } | undefined;
    const agentId = meta?.agent;
    if (typeof agentId !== "string") return;
    const rate = typeof meta?.rate === "number" ? meta.rate : 0;
    await this.history(tx, { userId: agentId, kind: sign < 0 ? "bond_in" : "bond_out", sats: sign * op.amountSat, fcfa: rate > 0 ? sign * satsToFcfa(op.amountSat, rate) : 0, who: "Melax", whoId: null, receipt: await this.receiptNo(tx), ref: op.id, spend: false });
  }

  /** For tests and the console: is this trade's escrow empty and its books right? */
  async escrowBalance(tradeId: string): Promise<number> {
    const o = escrowOwner(tradeId);
    return (await balance(this.d.db, `${o}:spendable`)) + (await balance(this.d.db, `${o}:locked`));
  }
}

