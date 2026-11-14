// @melax/vault: where money actually moves. It joins three things that must never disagree:
//   the ledger (who is owed what), the sealed ecash proofs (what we really hold), and the mint.
// Contract:
//   - each owner's balance is a set of Cashu proofs, sealed at rest with a key derived from the server
//     pepper and that owner's salt. For every owner: ledger(spendable + locked) = proofs(live + reserved).
//   - every operation is recorded (with its sealed plan) before any network call. If the process dies or
//     a reply is lost, recover() asks the mint or the Lightning node what happened and finishes or undoes
//     the operation. Nothing is retried blindly.
//   - one outgoing operation per owner at a time: a second one gets BUSY until the first is resolved.
//   - an idempotency key applies once.
// Callers: apps/gateway services (send, pay, vouchers, cash-in/out), apps/escrow, apps/lnurl, reserve snapshots.
import { AppError, type Clock, type Logger, isAppError, newId, silentLogger, toSafeInt } from "@melax/core";
import { deriveUserKey, open, randomBytes, seal, sha256Hex } from "@melax/crypto";
import { type MeltPlan, type MintClient, type MintPlan, type P2PKOptions, type PlainProof, type SwapPlan, sumPlain } from "@melax/cashu";
import { type Db, type Migration, balance, post } from "@melax/ledger";
import { type LightningBackend, decodeInvoice, feeCapSat } from "@melax/lightning";

export const vaultMigrations: Migration[] = [
  {
    name: "vault/001-init",
    sql: [
      `CREATE TABLE owners (
         owner TEXT PRIMARY KEY,
         salt BYTEA NOT NULL
       )`,
      `CREATE TABLE proofs (
         id BIGSERIAL PRIMARY KEY,
         owner TEXT NOT NULL REFERENCES owners(owner),
         keyset TEXT NOT NULL,
         amount BIGINT NOT NULL CHECK (amount > 0),
         secret_hash TEXT NOT NULL UNIQUE,
         sealed BYTEA NOT NULL,
         state TEXT NOT NULL CHECK (state IN ('live', 'reserved', 'spent')),
         op_id TEXT,
         created_at BIGINT NOT NULL,
         spent_at BIGINT
       )`,
      `CREATE INDEX proofs_owner_state ON proofs(owner, state)`,
      `CREATE TABLE ops (
         id TEXT PRIMARY KEY,
         kind TEXT NOT NULL CHECK (kind IN ('transfer', 'export', 'import', 'mint', 'melt')),
         idem_key TEXT NOT NULL UNIQUE,
         owner TEXT NOT NULL,
         stage TEXT NOT NULL,
         status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
         amount BIGINT NOT NULL,
         data JSONB NOT NULL,
         sealed BYTEA,
         error TEXT,
         created_at BIGINT NOT NULL,
         updated_at BIGINT NOT NULL
       )`,
      `CREATE INDEX ops_pending ON ops(status, updated_at)`,
    ],
  },
];

export type OpKind = "transfer" | "export" | "import" | "mint" | "melt";
export type OpStatus = "pending" | "done" | "failed";

/** What callers see of an operation. `data` holds no secrets. */
export interface OpView {
  id: string;
  kind: OpKind;
  idemKey: string;
  owner: string;
  status: OpStatus;
  stage: string;
  amountSat: number;
  data: Record<string, unknown>;
  error: string | null;
}

/** Runs inside the transaction that completes or fails an operation, so receipts and SMS rows commit with the money. */
export type SettleHook = (tx: Db, op: OpView) => Promise<void>;

interface OpRow {
  id: string;
  kind: OpKind;
  idem_key: string;
  owner: string;
  stage: string;
  status: OpStatus;
  amount: number;
  data: Record<string, unknown>;
  sealed: Buffer | null;
  error: string | null;
  updated_at: number;
}

interface HeldProof {
  rowId: number;
  proof: PlainProof;
}

const spendable = (owner: string) => `${owner}:spendable`;
const locked = (owner: string) => `${owner}:locked`;
/** Sats on the gateway's Lightning node that belong to a user and are on their way into ecash. */
export const FLOAT_NODE = "float:node";
const FLOAT_MINTING = "float:minting";
const EXT_LIGHTNING = "ext:lightning";
const EXT_ECASH = "ext:ecash";
const EXT_MINT_FEES = "ext:mintfees";
const EXT_LN_FEES = "ext:lnfees";
const EXT_OPERATOR = "ext:operator";

function view(r: OpRow): OpView {
  return { id: r.id, kind: r.kind, idemKey: r.idem_key, owner: r.owner, status: r.status, stage: r.stage, amountSat: toSafeInt(r.amount), data: r.data ?? {}, error: r.error };
}

export interface VaultDeps {
  db: Db;
  clock: Clock;
  mint: MintClient;
  /** The gateway's own Lightning node: pays the mint when sats arrive for a user. */
  ln: LightningBackend;
  /** Server secret from the environment. Never stored in the database. */
  pepper: Buffer;
  log?: Logger;
}

export class Vault {
  private readonly db: Db;
  private readonly clock: Clock;
  readonly mint: MintClient;
  private readonly ln: LightningBackend;
  private readonly pepper: Buffer;
  private readonly log: Logger;
  private readonly keys = new Map<string, Buffer>();
  private readonly active = new Set<string>();
  private hook: SettleHook = async () => undefined;

  constructor(deps: VaultDeps) {
    if (deps.pepper.length < 32) throw new AppError("BAD_INPUT", "pepper must be at least 32 bytes");
    this.db = deps.db;
    this.clock = deps.clock;
    this.mint = deps.mint;
    this.ln = deps.ln;
    this.pepper = deps.pepper;
    this.log = deps.log ?? silentLogger;
  }

  onSettled(hook: SettleHook): void {
    this.hook = hook;
  }

  // ---------- keys and proof rows ----------

  /**
   * Give each owner a salt, committed on its own before any money transaction starts. The key cache below
   * must never hold a key whose salt could still be rolled back: proofs sealed with it would be unreadable.
   */
  private async ensureOwners(owners: Array<string | null | undefined>): Promise<void> {
    for (const owner of owners) {
      if (!owner || this.keys.has(owner)) continue;
      await this.db.query("INSERT INTO owners (owner, salt) VALUES ($1, $2) ON CONFLICT (owner) DO NOTHING", [owner, randomBytes(16)]);
    }
  }

  private async ownerKey(tx: Db, owner: string): Promise<Buffer> {
    const hit = this.keys.get(owner);
    if (hit) return hit;
    const row = (await tx.query<{ salt: Buffer }>("SELECT salt FROM owners WHERE owner = $1", [owner]))[0];
    if (!row) throw new AppError("INTERNAL", "owner has no sealing salt yet", { owner });
    const key = deriveUserKey(this.pepper, Buffer.from(row.salt));
    this.keys.set(owner, key);
    return key;
  }

  /** Serialises everything that spends from one owner. Held until the surrounding transaction ends. */
  private async lockOwner(tx: Db, owner: string): Promise<void> {
    await this.ownerKey(tx, owner);
    await tx.query("SELECT owner FROM owners WHERE owner = $1 FOR UPDATE", [owner]);
  }

  private async addProofs(tx: Db, owner: string, proofs: PlainProof[], state: "live" | "reserved" = "live", opId: string | null = null): Promise<void> {
    const key = await this.ownerKey(tx, owner);
    for (const p of proofs) {
      await tx.query("INSERT INTO proofs (owner, keyset, amount, secret_hash, sealed, state, op_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [
        owner,
        p.id,
        p.amount,
        sha256Hex(p.secret),
        seal(key, Buffer.from(JSON.stringify(p), "utf8"), `proof:${owner}`),
        state,
        opId,
        this.clock.now(),
      ]);
    }
  }

  private async readProofs(tx: Db, owner: string, where: string, params: unknown[], forUpdate = false): Promise<HeldProof[]> {
    const key = await this.ownerKey(tx, owner);
    const rows = await tx.query<{ id: number; sealed: Buffer }>(`SELECT id, sealed FROM proofs WHERE owner = $1 AND ${where} ORDER BY amount DESC, id${forUpdate ? " FOR UPDATE" : ""}`, [owner, ...params]);
    return rows.map((r) => ({ rowId: toSafeInt(r.id), proof: JSON.parse(open(key, Buffer.from(r.sealed), `proof:${owner}`).toString("utf8")) as PlainProof }));
  }

  /** The owner's spendable proofs, decrypted. Used to hand a locked voucher token to its redeem page. */
  async liveProofs(owner: string): Promise<PlainProof[]> {
    await this.ensureOwners([owner]);
    return (await this.readProofs(this.db, owner, "state = 'live'", [])).map((h) => h.proof);
  }

  private sealPlan(key: Buffer, opId: string, value: unknown): Buffer {
    return seal(key, Buffer.from(JSON.stringify(value), "utf8"), `op:${opId}`);
  }
  private async openPlan<T>(tx: Db, op: OpRow): Promise<T> {
    if (!op.sealed) throw new AppError("INTERNAL", "operation has no stored plan", { op: op.id });
    const key = await this.ownerKey(tx, op.owner);
    return JSON.parse(open(key, Buffer.from(op.sealed), `op:${op.id}`).toString("utf8")) as T;
  }

  private async getOp(tx: Db, id: string, forUpdate = false): Promise<OpRow> {
    const r = await tx.query<OpRow>(`SELECT * FROM ops WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [id]);
    if (!r[0]) throw new AppError("NOT_FOUND", "operation not found");
    return r[0];
  }

  async findOp(idemKey: string): Promise<OpView | null> {
    const r = await this.db.query<OpRow>("SELECT * FROM ops WHERE idem_key = $1", [idemKey]);
    return r[0] ? view(r[0]) : null;
  }

  private async insertOp(tx: Db, op: { id: string; kind: OpKind; idemKey: string; owner: string; stage: string; amount: number; data: Record<string, unknown>; plan: unknown }): Promise<void> {
    const key = await this.ownerKey(tx, op.owner);
    const now = this.clock.now();
    await tx.query("INSERT INTO ops (id, kind, idem_key, owner, stage, status, amount, data, sealed, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7::jsonb, $8, $9, $9)", [
      op.id,
      op.kind,
      op.idemKey,
      op.owner,
      op.stage,
      op.amount,
      JSON.stringify(op.data),
      this.sealPlan(key, op.id, op.plan),
      now,
    ]);
  }

  private async updateOp(tx: Db, id: string, patch: { stage?: string; status?: OpStatus; data?: Record<string, unknown>; plan?: unknown | null; error?: string | null }): Promise<OpRow> {
    const cur = await this.getOp(tx, id, true);
    const key = await this.ownerKey(tx, cur.owner);
    const sealedNext = patch.plan === undefined ? cur.sealed : patch.plan === null ? null : this.sealPlan(key, id, patch.plan);
    const r = await tx.query<OpRow>("UPDATE ops SET stage = $2, status = $3, data = $4::jsonb, sealed = $5, error = $6, updated_at = $7 WHERE id = $1 RETURNING *", [
      id,
      patch.stage ?? cur.stage,
      patch.status ?? cur.status,
      JSON.stringify({ ...(cur.data ?? {}), ...(patch.data ?? {}) }),
      sealedNext,
      patch.error === undefined ? cur.error : patch.error,
      this.clock.now(),
    ]);
    return r[0]!;
  }

  private async assertFree(tx: Db, owner: string): Promise<void> {
    const busy = await tx.query("SELECT 1 FROM ops WHERE owner = $1 AND status = 'pending' AND kind IN ('transfer', 'export', 'melt') LIMIT 1", [owner]);
    if (busy.length > 0) throw new AppError("BUSY", "another operation is still in progress for this account");
  }

  /** Pick live proofs covering `amountSat` plus the mint's input fee. Largest first keeps the input count small. */
  private async select(tx: Db, owner: string, amountSat: number | "all"): Promise<{ picked: HeldProof[]; amount: number }> {
    const live = await this.readProofs(tx, owner, "state = 'live'", [], true);
    const ledgerSpendable = await balance(tx, spendable(owner));
    if (amountSat === "all") {
      const amount = sumPlain(live.map((h) => h.proof)) - this.mint.feeFor(live.map((h) => h.proof));
      if (live.length === 0 || amount <= 0) throw new AppError("INSUFFICIENT_FUNDS", "nothing to move");
      return { picked: live, amount };
    }
    const picked: HeldProof[] = [];
    let sum = 0;
    for (const h of live) {
      if (sum >= amountSat + this.mint.feeFor(picked.map((x) => x.proof))) break;
      picked.push(h);
      sum += h.proof.amount;
    }
    const need = amountSat + this.mint.feeFor(picked.map((x) => x.proof));
    if (sum < need) {
      // The ledger says the money is there but part of it is tied up as change of an unfinished operation.
      if (ledgerSpendable >= need) throw new AppError("BUSY", "funds are tied up in an unfinished operation");
      throw new AppError("INSUFFICIENT_FUNDS", "balance too low");
    }
    return { picked, amount: amountSat };
  }

  // ---------- transfer, export, import: all are one swap at the mint ----------

  /**
   * Move ecash from one owner to another by swapping at the mint: the receiver gets fresh proofs sealed
   * under their own key, the sender gets change. `lock` makes the receiver's proofs spendable only with a
   * key (vouchers). `privkey` signs inputs that are themselves locked (redeeming or refunding a voucher).
   */
  async transfer(req: { idemKey: string; from: string; to: string; amountSat: number | "all"; lock?: P2PKOptions; privkey?: string; meta?: Record<string, unknown> }): Promise<OpView> {
    if (req.from === req.to) throw new AppError("BAD_INPUT", "cannot transfer to the same account");
    return this.startSwap("transfer", { idemKey: req.idemKey, owner: req.from, to: req.to, amountSat: req.amountSat, lock: req.lock, meta: req.meta }, req.privkey);
  }

  /** Take ecash out of the system as a standard Cashu token (self-custody, or a voucher handed to another wallet). */
  async exportToken(req: { idemKey: string; owner: string; amountSat: number | "all"; meta?: Record<string, unknown> }): Promise<{ op: OpView; token: string | null }> {
    const op = await this.startSwap("export", { idemKey: req.idemKey, owner: req.owner, to: null, amountSat: req.amountSat, meta: req.meta });
    return { op, token: op.status === "done" ? await this.exportedToken(op.id) : null };
  }

  /** The token of a finished export. Kept sealed with the operation so a lost reply never loses the money. */
  async exportedToken(opId: string): Promise<string | null> {
    const op = await this.getOp(this.db, opId);
    if (op.kind !== "export" || op.status !== "done" || !op.sealed) return null;
    return (await this.openPlan<{ token: string }>(this.db, op)).token;
  }

  private async startSwap(kind: "transfer" | "export", req: { idemKey: string; owner: string; to: string | null; amountSat: number | "all"; lock?: P2PKOptions; meta?: Record<string, unknown> }, privkey?: string): Promise<OpView> {
    if (req.amountSat !== "all" && (!Number.isSafeInteger(req.amountSat) || req.amountSat <= 0)) throw new AppError("BAD_AMOUNT", "amount must be a positive whole number of sats");
    const prior = await this.findOp(req.idemKey);
    if (prior) return prior.status === "pending" ? this.resume(prior.id) : prior;
    await this.ensureOwners([req.owner, req.to]);

    const opId = await this.db.tx(async (tx) => {
      await this.lockOwner(tx, req.owner);
      await this.assertFree(tx, req.owner);
      const { picked, amount } = await this.select(tx, req.owner, req.amountSat);
      const plan = this.mint.planSwap(picked.map((h) => h.proof), amount, req.lock);
      const total = amount + plan.feeSat;
      const id = newId("op", this.clock);
      await post(tx, this.clock, { kind: "vault.reserve", idemKey: `${id}:reserve`, meta: { op: id }, postings: [{ account: spendable(req.owner), delta: -total }, { account: locked(req.owner), delta: total }] });
      await tx.query("UPDATE proofs SET state = 'reserved', op_id = $2 WHERE id = ANY($1::bigint[])", [picked.map((h) => h.rowId), id]);
      await this.insertOp(tx, { id, kind, idemKey: req.idemKey, owner: req.owner, stage: "planned", amount, data: { to: req.to, feeSat: plan.feeSat, meta: req.meta ?? {} }, plan });
      return id;
    });
    return this.driveSwap(opId, privkey);
  }

  /** Accept ecash from outside (a token someone sent, a voucher redeemed from another wallet). */
  async importToken(req: { idemKey: string; to: string; token: string; privkey?: string; meta?: Record<string, unknown> }): Promise<OpView> {
    const prior = await this.findOp(req.idemKey);
    if (prior) return prior.status === "pending" ? this.resume(prior.id) : prior;
    const proofs = this.mint.decodeToken(req.token);
    const total = sumPlain(proofs);
    const fee = this.mint.feeFor(proofs);
    if (proofs.length === 0 || total - fee <= 0) throw new AppError("BAD_AMOUNT", "token is empty");
    const plan = this.mint.planSwap(proofs, total - fee);
    await this.ensureOwners([req.to]);
    const opId = await this.db.tx(async (tx) => {
      const id = newId("op", this.clock);
      await this.insertOp(tx, { id, kind: "import", idemKey: req.idemKey, owner: req.to, stage: "planned", amount: total - fee, data: { to: req.to, feeSat: fee, meta: req.meta ?? {} }, plan });
      return id;
    });
    return this.driveSwap(opId, req.privkey);
  }

  private async driveSwap(opId: string, privkey?: string): Promise<OpView> {
    if (this.active.has(opId)) return view(await this.getOp(this.db, opId));
    this.active.add(opId);
    try {
      const op = await this.getOp(this.db, opId);
      if (op.status !== "pending") return view(op);
      const plan = await this.openPlan<SwapPlan>(this.db, op);
      let res: { send: PlainProof[]; keep: PlainProof[] };
      try {
        res = await this.mint.runSwap(plan, privkey);
      } catch (e) {
        if (isAppError(e, "UNKNOWN_OUTCOME")) {
          this.log.warn("vault.swap.unknown", { op: opId });
          return view(op); // stays pending; recover() will find out
        }
        await this.failSwap(opId, e instanceof Error ? e.message : "refused");
        throw e instanceof AppError ? e : new AppError("UPSTREAM", "swap failed");
      }
      return await this.settleSwap(opId, res);
    } finally {
      this.active.delete(opId);
    }
  }

  private async settleSwap(opId: string, res: { send: PlainProof[]; keep: PlainProof[] }): Promise<OpView> {
    return this.db.tx(async (tx) => {
      const op = await this.getOp(tx, opId, true);
      if (op.status !== "pending") return view(op);
      const amount = toSafeInt(op.amount);
      const fee = Number(op.data.feeSat ?? 0);
      const to = (op.data.to as string | null) ?? null;
      const now = this.clock.now();
      let donePlan: unknown | null = null;
      const postings: Array<{ account: string; delta: number }> = [];

      if (op.kind === "import") {
        await this.addProofs(tx, op.owner, res.send);
        postings.push({ account: EXT_ECASH, delta: -(amount + fee) }, { account: spendable(op.owner), delta: amount });
      } else {
        await tx.query("UPDATE proofs SET state = 'spent', spent_at = $2 WHERE op_id = $1 AND state = 'reserved'", [opId, now]);
        await this.addProofs(tx, op.owner, res.keep);
        postings.push({ account: locked(op.owner), delta: -(amount + fee) });
        if (op.kind === "export") {
          donePlan = { token: this.mint.encodeToken(res.send) };
          postings.push({ account: EXT_ECASH, delta: amount });
        } else {
          await this.addProofs(tx, to!, res.send);
          postings.push({ account: spendable(to!), delta: amount });
        }
      }
      if (fee > 0) postings.push({ account: EXT_MINT_FEES, delta: fee });
      await post(tx, this.clock, { kind: `vault.${op.kind}`, idemKey: `${opId}:settle`, meta: { op: opId }, postings });
      const done = await this.updateOp(tx, opId, { status: "done", stage: "done", plan: donePlan });
      await this.hook(tx, view(done));
      return view(done);
    });
  }

  private async failSwap(opId: string, reason: string): Promise<OpView> {
    return this.db.tx(async (tx) => {
      const op = await this.getOp(tx, opId, true);
      if (op.status !== "pending") return view(op);
      if (op.kind !== "import") {
        const total = toSafeInt(op.amount) + Number(op.data.feeSat ?? 0);
        await tx.query("UPDATE proofs SET state = 'live', op_id = NULL WHERE op_id = $1 AND state = 'reserved'", [opId]);
        await post(tx, this.clock, { kind: "vault.release", idemKey: `${opId}:release`, meta: { op: opId }, postings: [{ account: locked(op.owner), delta: -total }, { account: spendable(op.owner), delta: total }] });
      }
      const failed = await this.updateOp(tx, opId, { status: "failed", stage: "failed", plan: null, error: reason.slice(0, 300) });
      await this.hook(tx, view(failed));
      return view(failed);
    });
  }

  /** A voucher redeemed from another wallet is spent at the mint without us. Notice, and move it out of the books. */
  async writeOffSpent(owner: string, idemKey: string): Promise<number> {
    await this.ensureOwners([owner]);
    const live = await this.readProofs(this.db, owner, "state = 'live'", []);
    if (live.length === 0) return 0;
    const states = await this.mint.states(live.map((h) => h.proof));
    const gone = live.filter((_, i) => states[i] === "SPENT");
    if (gone.length === 0) return 0;
    const amount = sumPlain(gone.map((h) => h.proof));
    await this.db.tx(async (tx) => {
      await this.lockOwner(tx, owner);
      const still = await tx.query<{ id: number }>("SELECT id FROM proofs WHERE id = ANY($1::bigint[]) AND state = 'live' FOR UPDATE", [gone.map((h) => h.rowId)]);
      if (still.length !== gone.length) throw new AppError("BUSY", "proofs changed while checking");
      await tx.query("UPDATE proofs SET state = 'spent', spent_at = $2 WHERE id = ANY($1::bigint[])", [gone.map((h) => h.rowId), this.clock.now()]);
      await post(tx, this.clock, { kind: "vault.spent_outside", idemKey, meta: { owner }, postings: [{ account: spendable(owner), delta: -amount }, { account: EXT_ECASH, delta: amount }] });
    });
    return amount;
  }

  // ---------- mint: sats that arrived on our node become the owner's ecash ----------

  /**
   * Turn `amountSat` already sitting in float:node into ecash for `owner`: our node pays the mint's
   * invoice, the mint issues the proofs. The owner is credited the full amount; a routing fee to the
   * mint, if any, is the operator's cost (zero over a direct channel).
   */
  async mintFor(req: { idemKey: string; owner: string; amountSat: number; meta?: Record<string, unknown> }): Promise<OpView> {
    if (!Number.isSafeInteger(req.amountSat) || req.amountSat <= 0) throw new AppError("BAD_AMOUNT", "amount must be a positive whole number of sats");
    const prior = await this.findOp(req.idemKey);
    if (prior) return prior.status === "pending" ? this.resume(prior.id) : prior;
    const q = await this.mint.mintQuote(req.amountSat);
    const inv = decodeInvoice(q.bolt11);
    if (inv.amountSat !== req.amountSat) throw new AppError("UPSTREAM", "mint quoted a different amount than asked");
    const plan = this.mint.planMint(q.quote, req.amountSat);
    await this.ensureOwners([req.owner]);
    const opId = await this.db.tx(async (tx) => {
      const again = await tx.query<OpRow>("SELECT * FROM ops WHERE idem_key = $1", [req.idemKey]);
      if (again[0]) return again[0].id;
      const id = newId("op", this.clock);
      await post(tx, this.clock, { kind: "vault.mint.reserve", idemKey: `${id}:reserve`, meta: { op: id }, postings: [{ account: FLOAT_NODE, delta: -req.amountSat }, { account: FLOAT_MINTING, delta: req.amountSat }] });
      await this.insertOp(tx, { id, kind: "mint", idemKey: req.idemKey, owner: req.owner, stage: "quoted", amount: req.amountSat, data: { quote: q.quote, paymentHash: inv.paymentHash, meta: req.meta ?? {} }, plan: { plan, bolt11: q.bolt11 } });
      return id;
    });
    return this.driveMint(opId);
  }

  private async driveMint(opId: string): Promise<OpView> {
    if (this.active.has(opId)) return view(await this.getOp(this.db, opId));
    this.active.add(opId);
    try {
      let op = await this.getOp(this.db, opId);
      if (op.status !== "pending") return view(op);
      const { plan, bolt11 } = await this.openPlan<{ plan: MintPlan; bolt11: string }>(this.db, op);
      const amount = toSafeInt(op.amount);

      if (op.stage === "quoted") {
        // Never pay twice: if the node already knows this payment hash, take its word for it.
        const known = await this.ln.lookupPayment(String(op.data.paymentHash));
        const out = known ?? (await this.ln.pay({ bolt11, maxFeeSat: feeCapSat(amount), timeoutSec: 30 }));
        if (out.status === "pending") return view(op);
        if (out.status === "failed") return await this.failMint(opId, "could not pay the mint: " + out.reason);
        op = await this.db.tx((tx) => this.updateOp(tx, opId, { stage: "paid", data: { lnFeeSat: out.feeSat } }));
      }

      let proofs: PlainProof[] | null = null;
      for (let attempt = 0; attempt < 12 && !proofs; attempt++) {
        try {
          const rec = await this.mint.recoverMint(plan);
          if (rec.status === "done") proofs = rec.proofs;
          else if (rec.status === "not_run") proofs = await this.mint.runMint(plan);
          else await new Promise((r) => setTimeout(r, 400)); // the mint has not seen our payment yet
        } catch (e) {
          if (isAppError(e, "UNKNOWN_OUTCOME")) return view(op);
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      if (!proofs) return view(op);
      const minted = proofs;
      return await this.db.tx(async (tx) => {
        const cur = await this.getOp(tx, opId, true);
        if (cur.status !== "pending") return view(cur);
        await this.addProofs(tx, cur.owner, minted);
        await post(tx, this.clock, { kind: "vault.mint", idemKey: `${opId}:settle`, meta: { op: opId }, postings: [{ account: FLOAT_MINTING, delta: -amount }, { account: spendable(cur.owner), delta: amount }] });
        const lnFee = Number(cur.data.lnFeeSat ?? 0);
        if (lnFee > 0) await post(tx, this.clock, { kind: "vault.mint.routing_fee", idemKey: `${opId}:lnfee`, meta: { op: opId }, postings: [{ account: EXT_OPERATOR, delta: -lnFee }, { account: EXT_LN_FEES, delta: lnFee }] });
        const done = await this.updateOp(tx, opId, { status: "done", stage: "done", plan: null });
        await this.hook(tx, view(done));
        return view(done);
      });
    } finally {
      this.active.delete(opId);
    }
  }

  private async failMint(opId: string, reason: string): Promise<OpView> {
    return this.db.tx(async (tx) => {
      const op = await this.getOp(tx, opId, true);
      if (op.status !== "pending") return view(op);
      const amount = toSafeInt(op.amount);
      await post(tx, this.clock, { kind: "vault.mint.release", idemKey: `${opId}:release`, meta: { op: opId }, postings: [{ account: FLOAT_MINTING, delta: -amount }, { account: FLOAT_NODE, delta: amount }] });
      const failed = await this.updateOp(tx, opId, { status: "failed", stage: "failed", plan: null, error: reason.slice(0, 300) });
      await this.hook(tx, view(failed));
      return view(failed);
    });
  }

  // ---------- melt: the owner's ecash pays a Lightning invoice ----------

  /**
   * Pay `bolt11` from the owner's balance. The mint makes the Lightning payment; unused fee reserve comes
   * back as change. Returns "pending" when the outcome is not known yet: the funds stay locked until it is.
   */
  async melt(req: { idemKey: string; owner: string; bolt11: string; maxFeeSat?: number; meta?: Record<string, unknown> }): Promise<OpView> {
    const prior = await this.findOp(req.idemKey);
    if (prior) return prior.status === "pending" ? this.resume(prior.id) : prior;
    const inv = decodeInvoice(req.bolt11);
    if (inv.amountSat === null) throw new AppError("BAD_AMOUNT", "invoice has no amount");
    const q = await this.mint.meltQuote(req.bolt11);
    if (q.amountSat !== inv.amountSat) throw new AppError("UPSTREAM", "mint quoted a different amount than the invoice");
    const cap = req.maxFeeSat ?? feeCapSat(q.amountSat);
    if (q.feeReserveSat > cap) throw new AppError("LIMIT_EXCEEDED", "the fee reserve asked by the mint is above the fee cap", { feeReserveSat: q.feeReserveSat, cap });
    const need = q.amountSat + q.feeReserveSat;
    await this.ensureOwners([req.owner]);

    const opId = await this.db.tx(async (tx) => {
      await this.lockOwner(tx, req.owner);
      await this.assertFree(tx, req.owner);
      const { picked } = await this.select(tx, req.owner, need);
      const split = this.mint.planSwap(picked.map((h) => h.proof), need);
      if (split.feeSat > 0) throw new AppError("INTERNAL", "melt does not support mints with input fees yet");
      const id = newId("op", this.clock);
      await post(tx, this.clock, { kind: "vault.reserve", idemKey: `${id}:reserve`, meta: { op: id }, postings: [{ account: spendable(req.owner), delta: -need }, { account: locked(req.owner), delta: need }] });
      await tx.query("UPDATE proofs SET state = 'reserved', op_id = $2 WHERE id = ANY($1::bigint[])", [picked.map((h) => h.rowId), id]);
      await this.insertOp(tx, { id, kind: "melt", idemKey: req.idemKey, owner: req.owner, stage: "split", amount: q.amountSat, data: { feeReserveSat: q.feeReserveSat, paymentHash: inv.paymentHash, quote: q.quote, meta: req.meta ?? {} }, plan: { q, split } });
      return id;
    });
    return this.driveMelt(opId);
  }

  private async driveMelt(opId: string): Promise<OpView> {
    if (this.active.has(opId)) return view(await this.getOp(this.db, opId));
    this.active.add(opId);
    try {
      let op = await this.getOp(this.db, opId);
      if (op.status !== "pending") return view(op);
      type Stored = { q: { quote: string; bolt11: string; amountSat: number; feeReserveSat: number; expiry: number }; split?: SwapPlan; melt?: MeltPlan };
      let stored = await this.openPlan<Stored>(this.db, op);

      if (op.stage === "split") {
        // Step 1: swap into proofs worth exactly amount + fee reserve. The mint only gives change within the reserve.
        let res: { send: PlainProof[]; keep: PlainProof[] } | null = null;
        const rec = await this.mint.recoverSwap(stored.split!).catch(() => ({ status: "unknown" as const, detail: "mint unreachable" }));
        if (rec.status === "done") res = rec;
        else if (rec.status === "unknown") return view(op);
        else {
          try {
            res = await this.mint.runSwap(stored.split!);
          } catch (e) {
            if (isAppError(e, "UNKNOWN_OUTCOME")) return view(op);
            return await this.failMelt(opId, e instanceof Error ? e.message : "split refused");
          }
        }
        const exact = res.send;
        const keep = res.keep;
        stored = { q: stored.q };
        const meltPlan = await this.mint.planMelt(stored.q, exact);
        stored.melt = meltPlan;
        op = await this.db.tx(async (tx) => {
          const cur = await this.getOp(tx, opId, true);
          if (cur.stage !== "split") return cur;
          await tx.query("UPDATE proofs SET state = 'spent', spent_at = $2 WHERE op_id = $1 AND state = 'reserved'", [opId, this.clock.now()]);
          await this.addProofs(tx, cur.owner, exact, "reserved", opId);
          await this.addProofs(tx, cur.owner, keep);
          return this.updateOp(tx, opId, { stage: "melting", plan: stored });
        });
      }

      // Step 2: ask the mint to pay. The quote is the mint's own idempotency key: it pays a quote once.
      // So after an interruption we look first, and only ask (again) while the mint says "unpaid, not in flight".
      // "Unpaid" straight after asking is the mint's definite answer that the payment failed.
      const plan = stored.melt!;
      let res;
      try {
        const before = await this.mint.checkMelt(plan);
        res = before.state === "UNPAID" ? await this.mint.runMelt(plan) : before;
      } catch (e) {
        // No answer, or an answer we cannot interpret: keep the funds locked and look again later.
        this.log.warn("vault.melt.unknown", { op: opId, err: e });
        return view(await this.getOp(this.db, opId));
      }
      if (res.state === "PENDING") return view(await this.getOp(this.db, opId));
      if (res.state === "UNPAID") return await this.failMelt(opId, "the Lightning payment failed");
      const paid = res;
      return await this.db.tx(async (tx) => {
        const cur = await this.getOp(tx, opId, true);
        if (cur.status !== "pending") return view(cur);
        const amount = toSafeInt(cur.amount);
        const need = amount + Number(cur.data.feeReserveSat);
        const change = sumPlain(paid.change);
        await tx.query("UPDATE proofs SET state = 'spent', spent_at = $2 WHERE op_id = $1 AND state = 'reserved'", [opId, this.clock.now()]);
        await this.addProofs(tx, cur.owner, paid.change);
        const postings = [{ account: locked(cur.owner), delta: -need }, { account: EXT_LIGHTNING, delta: need - change }];
        if (change > 0) postings.push({ account: spendable(cur.owner), delta: change });
        await post(tx, this.clock, { kind: "vault.melt", idemKey: `${opId}:settle`, meta: { op: opId }, postings });
        const done = await this.updateOp(tx, opId, { status: "done", stage: "done", plan: null, data: { feePaidSat: need - amount - change, preimage: paid.preimage } });
        await this.hook(tx, view(done));
        return view(done);
      });
    } finally {
      this.active.delete(opId);
    }
  }

  /** Give everything back: whichever proofs the operation holds (the originals, or the exact set after the split) go live again. */
  private async failMelt(opId: string, reason: string): Promise<OpView> {
    return this.db.tx(async (tx) => {
      const op = await this.getOp(tx, opId, true);
      if (op.status !== "pending") return view(op);
      const need = toSafeInt(op.amount) + Number(op.data.feeReserveSat);
      await tx.query("UPDATE proofs SET state = 'live', op_id = NULL WHERE op_id = $1 AND state = 'reserved'", [opId]);
      await post(tx, this.clock, { kind: "vault.release", idemKey: `${opId}:release`, meta: { op: opId }, postings: [{ account: locked(op.owner), delta: -need }, { account: spendable(op.owner), delta: need }] });
      const failed = await this.updateOp(tx, opId, { status: "failed", stage: "failed", plan: null, error: reason.slice(0, 300) });
      await this.hook(tx, view(failed));
      return view(failed);
    });
  }

  // ---------- recovery ----------

  /** Continue one unfinished operation from wherever it stopped. Safe to call at any time, any number of times. */
  async resume(opId: string): Promise<OpView> {
    const op = await this.getOp(this.db, opId);
    if (op.status !== "pending" || this.active.has(opId)) return view(op);
    if (op.kind === "mint") return this.driveMint(opId);
    if (op.kind === "melt") return this.driveMelt(opId);
    // Swap kinds: the plan tells us whether the mint ran it.
    this.active.add(opId);
    try {
      const plan = await this.openPlan<SwapPlan>(this.db, op);
      const rec = await this.mint.recoverSwap(plan);
      if (rec.status === "done") return await this.settleSwap(opId, rec);
      if (rec.status === "not_run") return await this.failSwap(opId, "not executed before the interruption");
      this.log.warn("vault.resume.unknown", { op: opId, detail: rec.detail });
      return view(op);
    } catch (e) {
      this.log.warn("vault.resume.error", { op: opId, err: e });
      return view(op);
    } finally {
      this.active.delete(opId);
    }
  }

  /** Resolve every operation left pending for longer than `olderThanMs`. Run on boot and on a timer. */
  async recover(olderThanMs = 0): Promise<{ checked: number; done: number; failed: number; pending: number }> {
    const rows = await this.db.query<{ id: string }>("SELECT id FROM ops WHERE status = 'pending' AND updated_at <= $1 ORDER BY created_at", [this.clock.now() - olderThanMs]);
    const out = { checked: rows.length, done: 0, failed: 0, pending: 0 };
    for (const r of rows) {
      const v = await this.resume(r.id).catch(() => null);
      if (v?.status === "done") out.done++;
      else if (v?.status === "failed") out.failed++;
      else out.pending++;
    }
    return out;
  }

  // ---------- audit ----------

  /** For one owner: does the ledger agree with the proofs we hold? */
  async audit(owner: string): Promise<{ ok: boolean; ledgerSat: number; proofsSat: number }> {
    const ledgerSat = (await balance(this.db, spendable(owner))) + (await balance(this.db, locked(owner)));
    const r = await this.db.query<{ s: number }>("SELECT COALESCE(SUM(amount), 0)::bigint AS s FROM proofs WHERE owner = $1 AND state IN ('live', 'reserved')", [owner]);
    const proofsSat = toSafeInt(r[0]!.s);
    return { ok: ledgerSat === proofsSat, ledgerSat, proofsSat };
  }

  /** Every owner at once, plus the grand totals the reserve snapshot publishes. */
  async auditAll(): Promise<{ ok: boolean; ledgerSat: number; proofsSat: number; mismatches: string[] }> {
    const owners = await this.db.query<{ owner: string }>("SELECT owner FROM owners ORDER BY owner");
    let ledgerSat = 0;
    let proofsSat = 0;
    const mismatches: string[] = [];
    for (const { owner } of owners) {
      const a = await this.audit(owner);
      ledgerSat += a.ledgerSat;
      proofsSat += a.proofsSat;
      if (!a.ok) mismatches.push(owner);
    }
    return { ok: mismatches.length === 0, ledgerSat, proofsSat, mismatches };
  }

  /** Ask the mint whether the proofs we believe are unspent really are. Used by the reserve check. */
  async verifyHoldingsWithMint(limit = 2000): Promise<{ checked: number; notUnspent: number }> {
    const owners = await this.db.query<{ owner: string }>("SELECT DISTINCT owner FROM proofs WHERE state = 'live' LIMIT 500");
    let checked = 0;
    let notUnspent = 0;
    for (const { owner } of owners) {
      if (checked >= limit) break;
      const live = await this.liveProofs(owner);
      const states = await this.mint.states(live);
      checked += live.length;
      notUnspent += states.filter((s) => s !== "UNSPENT").length;
    }
    return { checked, notUnspent };
  }
}

export { FLOAT_MINTING, EXT_LIGHTNING, EXT_ECASH, EXT_MINT_FEES, EXT_LN_FEES, EXT_OPERATOR };
