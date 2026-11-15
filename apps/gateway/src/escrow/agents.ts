// Agents: people with a mobile-money account who turn francs into sats and back. Their offer (method,
// premium, range, on or off), their sealed mobile-money number, their bond and their wallet.
// Contract:
//   - the mobile-money number is sealed with the data key under agent:momo:<userId>; only the masked
//     copy is stored in the clear. momoOf() returns it for the one screen and the one SMS that need it;
//   - an agent's wallet is a LightningBackend: on regtest the demo's world node, otherwise a wallet
//     linked by Nostr Wallet Connect whose connection string is sealed under agent:wallet:<userId>;
//   - the bond is ecash under the vault owner bond:<agentUserId>. This file reads its balance; it is
//     moved only by the engine, through Vault.transfer;
//   - prices: a cash-in gives the user the francs' worth in sats less the agent's premium, rounded
//     down; a cash-out takes the francs' worth plus the premium, rounded up. Both from Rates.get().
// Callers: escrow/engine.ts, demo.ts (the seeded agents), tests.
import { AppError, type Clock, type Logger, fcfaToSats, maskPhone, normalizePhone, silentLogger, toSafeInt } from "@melax/core";
import { open, seal } from "@melax/crypto";
import { type Db, balance } from "@melax/ledger";
import { type LightningBackend, NwcBackend } from "@melax/lightning";
import type { Users } from "../users.ts";
import { BONDED_STATES } from "./trade.ts";

export const METHODS = ["wave", "om", "free", "cash"] as const;
export type Method = (typeof METHODS)[number];

export interface Agent {
  userId: string;
  name: string;
  method: Method;
  premiumBp: number;
  minFcfa: number;
  maxFcfa: number;
  active: boolean;
  momoMasked: string;
  walletKind: "world" | "nwc";
}

interface AgentRow {
  user_id: string;
  name: string;
  momo_sealed: Buffer;
  momo_masked: string;
  method: Method;
  premium_bp: number;
  min_fcfa: number;
  max_fcfa: number;
  active: boolean;
  wallet_kind: "world" | "nwc";
  wallet_sealed: Buffer | null;
}

const toAgent = (r: AgentRow): Agent => ({
  userId: r.user_id,
  name: r.name,
  method: r.method,
  premiumBp: toSafeInt(r.premium_bp),
  minFcfa: toSafeInt(r.min_fcfa),
  maxFcfa: toSafeInt(r.max_fcfa),
  active: r.active,
  momoMasked: r.momo_masked,
  walletKind: r.wallet_kind,
});

export const bondOwner = (agentId: string): string => `bond:${agentId}`;

/** Sats a user gets for `fcfa` francs paid to an agent. */
export function cashinSats(fcfa: number, xofPerBtc: number, premiumBp: number): number {
  return Math.floor((fcfaToSats(fcfa, xofPerBtc) * (10_000 - premiumBp)) / 10_000);
}
/** Sats a user gives for `fcfa` francs paid out by an agent. */
export function cashoutSats(fcfa: number, xofPerBtc: number, premiumBp: number): number {
  return Math.ceil((fcfaToSats(fcfa, xofPerBtc) * (10_000 + premiumBp)) / 10_000);
}

export interface AgentsDeps {
  db: Db;
  clock: Clock;
  log?: Logger;
  dataKey: Buffer;
  users: Users;
  /** Regtest demo only: the node that plays everybody else. Agents enrolled with wallet kind "world" use it. */
  world?: LightningBackend;
}

export class Agents {
  private readonly d: AgentsDeps;
  private readonly log: Logger;
  private readonly wallets = new Map<string, LightningBackend>();

  constructor(deps: AgentsDeps) {
    this.d = deps;
    this.log = deps.log ?? silentLogger;
  }

  /** Make an existing user an agent. Throws BAD_INPUT on a bad offer, NOT_FOUND for an unknown user, DUPLICATE if already one. */
  async enroll(a: { userId: string; momo: string; method: Method; premiumBp: number; minFcfa: number; maxFcfa: number; wallet: { kind: "world" } | { kind: "nwc"; url: string } }): Promise<Agent> {
    const momo = normalizePhone(a.momo);
    if (!METHODS.includes(a.method)) throw new AppError("BAD_INPUT", "unknown method");
    if (!Number.isSafeInteger(a.premiumBp) || a.premiumBp < 0 || a.premiumBp > 1000) throw new AppError("BAD_INPUT", "premium is 0 to 1000 basis points");
    if (!Number.isSafeInteger(a.minFcfa) || !Number.isSafeInteger(a.maxFcfa) || a.minFcfa <= 0 || a.maxFcfa < a.minFcfa) throw new AppError("BAD_INPUT", "bad range");
    if (a.wallet.kind === "nwc" && !a.wallet.url.startsWith("nostr+walletconnect://")) throw new AppError("BAD_INPUT", "not a wallet connect string");
    const user = await this.d.users.byId(a.userId);
    if (!user) throw new AppError("NOT_FOUND", "no such user");
    await this.d.db.tx(async (tx) => {
      const rows = await tx.query(
        `INSERT INTO agents (user_id, momo_sealed, momo_masked, method, premium_bp, min_fcfa, max_fcfa, wallet_kind, wallet_sealed, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
        [
          a.userId,
          seal(this.d.dataKey, Buffer.from(momo, "utf8"), `agent:momo:${a.userId}`),
          maskPhone(momo),
          a.method,
          a.premiumBp,
          a.minFcfa,
          a.maxFcfa,
          a.wallet.kind,
          a.wallet.kind === "nwc" ? seal(this.d.dataKey, Buffer.from(a.wallet.url, "utf8"), `agent:wallet:${a.userId}`) : null,
          this.d.clock.now(),
        ],
      );
      if (rows.length === 0) throw new AppError("DUPLICATE", "already an agent");
      await tx.query("UPDATE users SET role = 'agent' WHERE id = $1", [a.userId]);
    });
    this.log.info("agent.enrolled", { agent: a.userId, method: a.method });
    return (await this.get(a.userId))!;
  }

  private async row(userId: string, db: Db, forUpdate = false): Promise<AgentRow | null> {
    const rows = await db.query<AgentRow>(`SELECT a.*, u.name FROM agents a JOIN users u ON u.id = a.user_id WHERE a.user_id = $1${forUpdate ? " FOR UPDATE OF a" : ""}`, [userId]);
    return rows[0] ?? null;
  }

  async get(userId: string, db: Db = this.d.db): Promise<Agent | null> {
    const r = await this.row(userId, db);
    return r ? toAgent(r) : null;
  }

  /** Lock the agent's row until the surrounding transaction ends. Starts and bond withdrawals take it, so they run one at a time per agent. */
  async lock(tx: Db, userId: string): Promise<Agent | null> {
    const r = await this.row(userId, tx, true);
    return r ? toAgent(r) : null;
  }

  /** The agent's mobile-money number in the clear. For the user's screen and SMS of a cash-in only. Never log it. */
  async momoOf(userId: string, db: Db = this.d.db): Promise<string> {
    const r = await this.row(userId, db);
    if (!r) throw new AppError("NOT_FOUND", "no such agent");
    return open(this.d.dataKey, Buffer.from(r.momo_sealed), `agent:momo:${userId}`).toString("utf8");
  }

  /** The agent's own Lightning wallet: pays the hold invoice of a cash-in, makes the invoice of a cash-out. */
  async wallet(userId: string): Promise<LightningBackend> {
    const hit = this.wallets.get(userId);
    if (hit) return hit;
    const r = await this.row(userId, this.d.db);
    if (!r) throw new AppError("NOT_FOUND", "no such agent");
    let w: LightningBackend;
    if (r.wallet_kind === "world") {
      if (!this.d.world) throw new AppError("UPSTREAM", "this agent's wallet is the demo node, and there is none here");
      w = this.d.world;
    } else {
      if (!r.wallet_sealed) throw new AppError("INTERNAL", "an NWC agent has no wallet string");
      w = new NwcBackend(open(this.d.dataKey, Buffer.from(r.wallet_sealed), `agent:wallet:${userId}`).toString("utf8"));
    }
    this.wallets.set(userId, w);
    return w;
  }

  async setActive(userId: string, on: boolean): Promise<boolean> {
    const rows = await this.d.db.query("UPDATE agents SET active = $2 WHERE user_id = $1 RETURNING user_id", [userId, on]);
    return rows.length > 0;
  }

  async bondSats(userId: string, db: Db = this.d.db): Promise<number> {
    return balance(db, `${bondOwner(userId)}:spendable`);
  }

  /** Sats of this agent's cash-ins that are not closed: they must never add up to more than the bond. */
  async bondedSats(userId: string, db: Db = this.d.db): Promise<number> {
    const r = await db.query<{ s: number }>("SELECT COALESCE(SUM(sats), 0)::bigint AS s FROM trades WHERE agent_id = $1 AND kind = 'cashin' AND state = ANY($2::text[])", [userId, [...BONDED_STATES]]);
    return toSafeInt(r[0]!.s);
  }

  /** Every active agent, best first for whoever picks: for a cash-in the lowest premium gives the most sats. */
  async active(db: Db = this.d.db): Promise<Agent[]> {
    const rows = await db.query<AgentRow>("SELECT a.*, u.name FROM agents a JOIN users u ON u.id = a.user_id WHERE a.active ORDER BY a.premium_bp, a.created_at");
    return rows.map(toAgent);
  }

  async close(): Promise<void> {
    for (const w of this.wallets.values()) if (w !== this.d.world) await w.close().catch(() => undefined);
    this.wallets.clear();
  }
}
