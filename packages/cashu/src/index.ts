// @melax/cashu: the gateway's client for a Cashu mint. A thin, crash-safe layer over @cashu/cashu-ts.
// Contract: every operation that changes ecash is split in two.
//   plan*  builds the exact outputs (secrets and blinding factors) and returns plain JSON. No network.
//   run*   sends the planned request to the mint.
// The caller stores the plan before calling run. If the reply is lost, recover*/checkMelt asks the mint
// what happened (NUT-07 proof states, NUT-09 restore, quote state) and rebuilds the same proofs from the
// stored plan. Nothing is ever retried blindly and no ecash is created twice.
// The mint is reached only through its public HTTP API, so any standard mint can take Nutshell's place.
// Callers: @melax/vault (all money movement), apps/gateway (tokens, vouchers), scripts.
import {
  Amount,
  HttpResponseError,
  type MeltQuoteBolt11Response,
  OutputData,
  type P2PKOptions,
  RateLimitError,
  setGlobalRequestOptions,
  type Proof,
  type SerializedOutputData,
  Wallet,
  getDecodedToken,
  getEncodedToken,
  hasValidDleq,
  parseP2PKSecret,
  signP2PKProofs,
  stripDleq,
} from "@cashu/cashu-ts";
import { AppError } from "@melax/core";

/** A proof as plain JSON: safe to seal, store and log-redact. Amounts are whole sats. */
export interface PlainProof {
  id: string;
  amount: number;
  secret: string;
  C: string;
  dleq?: { s: string; e: string; r?: string };
  witness?: string;
  p2pk_e?: string;
}

export type PlannedOutput = SerializedOutputData;

export interface SwapPlan {
  kind: "swap";
  keysetId: string;
  inputs: PlainProof[];
  send: PlannedOutput[];
  keep: PlannedOutput[];
  feeSat: number;
}
export interface MintPlan {
  kind: "mint";
  keysetId: string;
  quote: string;
  amountSat: number;
  outputs: PlannedOutput[];
}
export interface MeltPlan {
  kind: "melt";
  keysetId: string;
  quote: string;
  bolt11: string;
  amountSat: number;
  feeReserveSat: number;
  expiry: number;
  inputs: PlainProof[];
  change: PlannedOutput[];
}

export type ProofState = "UNSPENT" | "PENDING" | "SPENT";
export type Recovered<T> = ({ status: "done" } & T) | { status: "not_run" } | { status: "unknown"; detail: string };
export interface MeltResult {
  state: "PAID" | "PENDING" | "UNPAID";
  change: PlainProof[];
  preimage: string | null;
}
export type { P2PKOptions };

export function toPlain(p: Proof): PlainProof {
  const out: PlainProof = { id: p.id, amount: Amount.from(p.amount).toNumber(), secret: p.secret, C: p.C };
  if (p.dleq) out.dleq = { s: p.dleq.s, e: p.dleq.e, ...(p.dleq.r ? { r: p.dleq.r } : {}) };
  if (typeof p.witness === "string") out.witness = p.witness;
  else if (p.witness) out.witness = JSON.stringify(p.witness);
  if (p.p2pk_e) out.p2pk_e = p.p2pk_e;
  return out;
}
export function fromPlain(p: PlainProof): Proof {
  return { ...p, amount: Amount.from(p.amount) } as Proof;
}
export function sumPlain(proofs: Array<{ amount: number }>): number {
  return proofs.reduce((s, p) => s + p.amount, 0);
}

function outputAmount(o: PlannedOutput): number {
  return Number(o.blindedMessage.amount);
}

// The library retries network errors on the mint's cached endpoints (NUT-19) up to 9 times, and its
// default request timeout is 5 minutes. A phone user cannot wait that long, so cap each attempt.
setGlobalRequestOptions({ requestTimeout: 15_000 });

/** The mint's API wants the witness as a JSON string; the signing helper leaves it as an object. */
function wireProofs(proofs: Proof[]): Proof[] {
  return (stripDleq(proofs) as Proof[]).map((p) => (p.witness && typeof p.witness !== "string" ? { ...p, witness: JSON.stringify(p.witness) } : p));
}

/** A definite "no" from the mint (it answered, with an error). Anything else is an unknown outcome. */
function isRefusal(e: unknown): e is HttpResponseError {
  return e instanceof HttpResponseError && e.status >= 400 && e.status < 500;
}
function upstream(e: unknown, what: string): AppError {
  if (e instanceof RateLimitError) return new AppError("BUSY", `mint rate limit hit on ${what}`, { refused: true });
  if (isRefusal(e)) return new AppError("UPSTREAM", `mint refused ${what}: ${e.message}`, { refused: true });
  return new AppError("UNKNOWN_OUTCOME", `no answer from the mint for ${what}: ${e instanceof Error ? e.message : "error"}`);
}

export class MintClient {
  readonly wallet: Wallet;
  readonly url: string;

  private constructor(wallet: Wallet, url: string) {
    this.wallet = wallet;
    this.url = url;
  }

  static async connect(url: string): Promise<MintClient> {
    const wallet = new Wallet(url, { unit: "sat" });
    try {
      await wallet.loadMint();
    } catch (e) {
      throw new AppError("UPSTREAM", "mint unreachable: " + (e instanceof Error ? e.message : ""));
    }
    return new MintClient(wallet, url.replace(/\/+$/, ""));
  }

  /** Re-read keysets, e.g. after the monthly rotation. */
  async refresh(): Promise<void> {
    await this.wallet.loadMint(true);
  }

  get keysetId(): string {
    return this.wallet.keysetId;
  }
  get name(): string {
    return this.wallet.getMintInfo().name ?? "";
  }
  get keysetIds(): string[] {
    return this.wallet.keyChain.getKeysets().map((k) => k.id);
  }

  private keyset(id: string) {
    return this.wallet.getKeyset(id);
  }

  feeFor(inputs: PlainProof[]): number {
    return this.wallet.getFeesForProofs(inputs).toNumber();
  }

  // ---------- swap ----------

  /**
   * Plan a swap of `inputs` into `sendSat` of fresh ecash (optionally locked to a key, NUT-11) plus change.
   * Always a real swap, even when the inputs already add up exactly: two owners never share a secret.
   */
  planSwap(inputs: PlainProof[], sendSat: number, lock?: P2PKOptions): SwapPlan {
    if (!Number.isSafeInteger(sendSat) || sendSat < 0) throw new AppError("BAD_AMOUNT", "bad swap amount");
    if (inputs.length === 0) throw new AppError("INSUFFICIENT_FUNDS", "no inputs");
    const keysetId = this.keysetId;
    const ks = this.keyset(keysetId);
    const feeSat = this.feeFor(inputs);
    const keepSat = sumPlain(inputs) - sendSat - feeSat;
    if (keepSat < 0) throw new AppError("INSUFFICIENT_FUNDS", "inputs do not cover the amount and the mint fee");
    const send = sendSat === 0 ? [] : lock ? OutputData.createP2PKData(lock, sendSat, ks) : OutputData.createRandomData(sendSat, ks);
    const keep = keepSat === 0 ? [] : OutputData.createRandomData(keepSat, ks);
    return { kind: "swap", keysetId, inputs, send: send.map((o) => OutputData.serialize(o)), keep: keep.map((o) => OutputData.serialize(o)), feeSat };
  }

  private swapOutputs(plan: SwapPlan): Array<{ out: OutputData; send: boolean }> {
    const all = [...plan.send.map((o) => ({ out: OutputData.deserialize(o), send: true })), ...plan.keep.map((o) => ({ out: OutputData.deserialize(o), send: false }))];
    // Ascending by amount, so the position of an output does not tell the mint which side it belongs to.
    return all.sort((a, b) => outputAmount(OutputData.serialize(a.out)) - outputAmount(OutputData.serialize(b.out)));
  }

  private finish(outs: Array<{ out: OutputData; send: boolean }>, sigs: Array<{ id: string; amount: unknown; C_: string }>): { send: PlainProof[]; keep: PlainProof[] } {
    const send: PlainProof[] = [];
    const keep: PlainProof[] = [];
    sigs.forEach((sig, i) => {
      const o = outs[i]!;
      const ks = this.keyset(sig.id);
      const proof = o.out.toProof(sig as never, ks);
      if (proof.dleq && !hasValidDleq(proof, ks)) throw new AppError("UPSTREAM", "mint returned a signature with an invalid DLEQ proof");
      (o.send ? send : keep).push(toPlain(proof));
    });
    return { send, keep };
  }

  /** Execute a planned swap. `privkey` signs inputs that are locked to a key. */
  async runSwap(plan: SwapPlan, privkey?: string): Promise<{ send: PlainProof[]; keep: PlainProof[] }> {
    let inputs = plan.inputs.map(fromPlain);
    if (privkey) inputs = signP2PKProofs(inputs, privkey);
    const outs = this.swapOutputs(plan);
    try {
      const res = await this.wallet.mint.swap({ inputs: wireProofs(inputs), outputs: outs.map((o) => o.out.blindedMessage) });
      if (res.signatures.length !== outs.length) throw new AppError("UPSTREAM", "mint returned the wrong number of signatures");
      return this.finish(outs, res.signatures);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw upstream(e, "swap");
    }
  }

  /** After a lost reply: did the swap happen? If yes, rebuild the outputs from the plan (NUT-09). */
  async recoverSwap(plan: SwapPlan): Promise<Recovered<{ send: PlainProof[]; keep: PlainProof[] }>> {
    const states = await this.states(plan.inputs);
    if (states.every((s) => s === "UNSPENT")) return { status: "not_run" };
    if (!states.every((s) => s === "SPENT")) return { status: "unknown", detail: "inputs are " + [...new Set(states)].join("/") };
    const outs = this.swapOutputs(plan);
    const restored = await this.restore(outs.map((o) => o.out));
    if (restored.length !== outs.length) return { status: "unknown", detail: `inputs are spent but the mint signed ${restored.length} of ${outs.length} planned outputs` };
    const send: PlainProof[] = [];
    const keep: PlainProof[] = [];
    restored.forEach((p, i) => (outs[i]!.send ? send : keep).push(p));
    return { status: "done", send, keep };
  }

  /** NUT-09: ask the mint for the signatures it already issued for these outputs. Order of `outs` is kept. */
  private async restore(outs: OutputData[]): Promise<PlainProof[]> {
    if (outs.length === 0) return [];
    const res = await this.wallet.mint.restore({ outputs: outs.map((o) => o.blindedMessage) });
    const byB = new Map(res.outputs.map((o, i) => [o.B_, res.signatures[i]!]));
    const proofs: PlainProof[] = [];
    for (const o of outs) {
      const sig = byB.get(o.blindedMessage.B_);
      if (!sig) continue;
      proofs.push(toPlain(o.toProof(sig, this.keyset(sig.id))));
    }
    return proofs;
  }

  // ---------- mint (Lightning in, ecash out) ----------

  async mintQuote(amountSat: number): Promise<{ quote: string; bolt11: string; amountSat: number; expiresAt: number | null }> {
    try {
      const q = await this.wallet.createMintQuoteBolt11(amountSat);
      return { quote: q.quote, bolt11: q.request, amountSat, expiresAt: q.expiry ? q.expiry * 1000 : null };
    } catch (e) {
      throw upstream(e, "mint quote");
    }
  }

  async mintQuoteState(quote: string): Promise<"UNPAID" | "PAID" | "ISSUED"> {
    return (await this.wallet.checkMintQuoteBolt11(quote)).state;
  }

  planMint(quote: string, amountSat: number): MintPlan {
    const keysetId = this.keysetId;
    const outputs = OutputData.createRandomData(amountSat, this.keyset(keysetId)).map((o) => OutputData.serialize(o));
    return { kind: "mint", keysetId, quote, amountSat, outputs };
  }

  async runMint(plan: MintPlan): Promise<PlainProof[]> {
    const outs = plan.outputs.map((o) => ({ out: OutputData.deserialize(o), send: true }));
    try {
      const res = await this.wallet.mint.mintBolt11({ quote: plan.quote, outputs: outs.map((o) => o.out.blindedMessage) });
      if (res.signatures.length !== outs.length) throw new AppError("UPSTREAM", "mint returned the wrong number of signatures");
      return this.finish(outs, res.signatures).send;
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw upstream(e, "mint");
    }
  }

  /** "done": already issued, here are the proofs. "not_run": paid but not issued, run it. "unknown": not paid yet. */
  async recoverMint(plan: MintPlan): Promise<Recovered<{ proofs: PlainProof[] }>> {
    const state = await this.mintQuoteState(plan.quote);
    if (state === "PAID") return { status: "not_run" };
    if (state === "UNPAID") return { status: "unknown", detail: "quote is not paid" };
    const proofs = await this.restore(plan.outputs.map((o) => OutputData.deserialize(o)));
    if (proofs.length !== plan.outputs.length) return { status: "unknown", detail: "quote is issued but not to this plan's outputs" };
    return { status: "done", proofs };
  }

  // ---------- melt (ecash in, Lightning out) ----------

  async meltQuote(bolt11: string): Promise<{ quote: string; bolt11: string; amountSat: number; feeReserveSat: number; expiry: number }> {
    try {
      const q = await this.wallet.createMeltQuoteBolt11(bolt11);
      return { quote: q.quote, bolt11, amountSat: q.amount.toNumber(), feeReserveSat: q.fee_reserve.toNumber(), expiry: q.expiry };
    } catch (e) {
      throw upstream(e, "melt quote");
    }
  }

  private meltQuoteObject(p: { quote: string; bolt11: string; amountSat: number; feeReserveSat: number; expiry: number }): MeltQuoteBolt11Response {
    return { quote: p.quote, amount: Amount.from(p.amountSat), unit: "sat", state: "UNPAID", expiry: p.expiry, request: p.bolt11, fee_reserve: Amount.from(p.feeReserveSat), payment_preimage: null };
  }

  /** `inputs` must add up to exactly amount + fee reserve + mint input fee: the mint only returns change within the fee reserve. */
  async planMelt(q: { quote: string; bolt11: string; amountSat: number; feeReserveSat: number; expiry: number }, inputs: PlainProof[]): Promise<MeltPlan> {
    const need = q.amountSat + q.feeReserveSat + this.feeFor(inputs);
    if (sumPlain(inputs) !== need) throw new AppError("BAD_AMOUNT", `melt inputs must total exactly ${need} sats`);
    const preview = await this.wallet.prepareMelt("bolt11", this.meltQuoteObject(q), inputs.map(fromPlain));
    return { kind: "melt", keysetId: preview.keysetId, ...q, inputs, change: preview.outputData.map((o) => OutputData.serialize(o)) };
  }

  /** Ask the mint to pay. A thrown UNKNOWN_OUTCOME means: keep the funds reserved and call checkMelt later. */
  async runMelt(plan: MeltPlan): Promise<MeltResult> {
    const outputData = plan.change.map((o) => OutputData.deserialize(o));
    try {
      const res = await this.wallet.completeMelt({ method: "bolt11", inputs: plan.inputs.map(fromPlain), outputData, keysetId: plan.keysetId, quote: this.meltQuoteObject(plan) });
      return { state: res.quote.state, change: res.change.map(toPlain), preimage: res.quote.payment_preimage ?? null };
    } catch (e) {
      if (isRefusal(e)) {
        // The mint answered. Its quote state is the truth (a failed Lightning payment arrives here as an error).
        const now = await this.checkMelt(plan).catch(() => null);
        if (now) return now;
      }
      throw upstream(e, "melt");
    }
  }

  async checkMelt(plan: MeltPlan): Promise<MeltResult> {
    const q = await this.wallet.checkMeltQuoteBolt11(plan.quote);
    if (q.state !== "PAID") return { state: q.state, change: [], preimage: null };
    const change = q.change?.length ? this.wallet.createMeltChangeProofs(plan.change.map((o) => OutputData.deserialize(o)), q.change).map(toPlain) : [];
    return { state: "PAID", change, preimage: q.payment_preimage ?? null };
  }

  // ---------- states, tokens, offline checks ----------

  async states(proofs: PlainProof[]): Promise<ProofState[]> {
    if (proofs.length === 0) return [];
    const r = await this.wallet.checkProofsStates(proofs.map((p) => ({ secret: p.secret, id: p.id })));
    return r.map((s) => s.state);
  }

  encodeToken(proofs: PlainProof[], memo?: string): string {
    return getEncodedToken({ mint: this.url, proofs: proofs.map(fromPlain), unit: "sat", ...(memo ? { memo } : {}) });
  }

  /** Decode a token and insist it is from this mint. Tokens from other mints are refused, not swapped. */
  decodeToken(token: string): PlainProof[] {
    let t;
    try {
      t = getDecodedToken(token.trim(), this.keysetIds);
    } catch {
      throw new AppError("BAD_INPUT", "not a valid ecash token");
    }
    if (t.mint.replace(/\/+$/, "") !== this.url) throw new AppError("BAD_INPUT", "token is from another mint");
    if (t.unit && t.unit !== "sat") throw new AppError("BAD_INPUT", "token is not in sats");
    return t.proofs.map(toPlain);
  }

  /**
   * What can be checked with no connection: every proof carries a valid DLEQ proof from this mint's key
   * (NUT-12), and, when `lockPubkey` is given, is locked to that key (NUT-11). It cannot rule out that
   * the proof was already spent; that needs the mint.
   */
  verifyOffline(proofs: PlainProof[], lockPubkey?: string): boolean {
    try {
      return proofs.every((p) => {
        const ks = this.keyset(p.id);
        if (!hasValidDleq(fromPlain(p), ks, { require: true })) return false;
        if (lockPubkey === undefined) return true;
        const s = parseP2PKSecret(p.secret);
        return s[0] === "P2PK" && s[1].data === lockPubkey;
      });
    } catch {
      return false;
    }
  }
}
