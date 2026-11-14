// The vault against the real thing: Nutshell mint and LND nodes on regtest, Postgres in-process (PGlite).
// Needs: docker compose up, bash scripts/dev-creds.sh. Faults are injected at the network edge only.
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AppError, systemClock } from "@melax/core";
import { MintClient } from "@melax/cashu";
import { pubkeyFromPriv, randomPrivKey } from "@melax/crypto";
import { type Db, balance, createMemoryDb, ledgerMigrations, migrate, post, truncateAll, verifyLedger } from "@melax/ledger";
import { LndBackend } from "@melax/lightning";
import { FLOAT_NODE, type OpView, Vault, vaultMigrations } from "../src/index.ts";

const keys = resolve(import.meta.dirname, "../../../.keys");
const lnd = (name: string, port: number) =>
  LndBackend.fromFiles({ baseUrl: `https://localhost:${port}`, macaroonPath: `${keys}/lnd-${name}/admin.macaroon`, tlsCertPath: `${keys}/lnd-${name}/tls.cert` });
const MINT = process.env.MINT_URL ?? "http://localhost:3338";
const pepper = randomBytes(32);

let db: Db;
let mint: MintClient;
let gw: LndBackend;
let world: LndBackend;
let vault: Vault;
let settled: OpView[] = [];
let n = 0;
const key = (p = "t") => `${p}-${Date.now()}-${++n}`;
const realFetch = globalThis.fetch;

function fault(match: string, mode: "lost-reply" | "down"): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(match)) {
      if (mode === "lost-reply") await realFetch(input, init);
      throw new TypeError("fetch failed (injected " + mode + ")");
    }
    return realFetch(input, init);
  }) as typeof fetch;
}
const heal = () => {
  globalThis.fetch = realFetch;
};

/** Sats arrive on the gateway node for a user (here: the world node pays an invoice), then become ecash. */
async function deposit(owner: string, sats: number): Promise<OpView> {
  const inv = await gw.makeInvoice({ amountSat: sats, memo: "deposit" });
  expect((await world.pay({ bolt11: inv.bolt11, maxFeeSat: 20 })).status).toBe("succeeded");
  await post(db, systemClock, { kind: "ln.received", idemKey: `recv:${inv.paymentHash}`, postings: [{ account: "ext:lightning", delta: -sats }, { account: FLOAT_NODE, delta: sats }] });
  return vault.mintFor({ idemKey: `mint:${inv.paymentHash}`, owner, amountSat: sats });
}
const spendable = (o: string) => balance(db, `${o}:spendable`);
const lockedBal = (o: string) => balance(db, `${o}:locked`);

async function expectConsistent(): Promise<void> {
  const a = await vault.auditAll();
  expect(a.mismatches).toEqual([]);
  expect(a.ledgerSat).toBe(a.proofsSat);
  const v = await verifyLedger(db);
  expect(v.problems).toEqual([]);
}

beforeAll(async () => {
  db = await createMemoryDb();
  await migrate(db, [...ledgerMigrations, ...vaultMigrations]);
  mint = await MintClient.connect(MINT);
  gw = lnd("gw", 18081);
  world = lnd("world", 18082);
});
beforeEach(async () => {
  heal();
  await truncateAll(db);
  vault = new Vault({ db, clock: systemClock, mint, ln: gw, pepper });
  settled = [];
  vault.onSettled(async (_tx, op) => {
    settled.push(op);
  });
});
afterAll(async () => {
  heal();
  await gw?.close();
  await world?.close();
  await db?.close();
});

describe("deposit: Lightning in, ecash for the owner", () => {
  it("credits the full amount and leaves no float behind", async () => {
    const op = await deposit("user:awa", 5000);
    expect(op.status).toBe("done");
    expect(await spendable("user:awa")).toBe(5000);
    expect(await balance(db, FLOAT_NODE)).toBe(0);
    expect(await balance(db, "float:minting")).toBe(0);
    expect(await vault.audit("user:awa")).toEqual({ ok: true, ledgerSat: 5000, proofsSat: 5000 });
    expect(settled.map((s) => [s.kind, s.status])).toEqual([["mint", "done"]]);
    await expectConsistent();
  });

  it("the same deposit key credits once", async () => {
    const inv = await gw.makeInvoice({ amountSat: 800 });
    await world.pay({ bolt11: inv.bolt11, maxFeeSat: 20 });
    await post(db, systemClock, { kind: "ln.received", idemKey: "recv:x", postings: [{ account: "ext:lightning", delta: -800 }, { account: FLOAT_NODE, delta: 800 }] });
    const a = await vault.mintFor({ idemKey: "mint:x", owner: "user:awa", amountSat: 800 });
    const b = await vault.mintFor({ idemKey: "mint:x", owner: "user:awa", amountSat: 800 });
    expect(b.id).toBe(a.id);
    expect(await spendable("user:awa")).toBe(800);
  });

  it("refuses to mint sats that never arrived", async () => {
    await expect(vault.mintFor({ idemKey: key(), owner: "user:awa", amountSat: 1000 })).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    expect(await spendable("user:awa")).toBe(0);
  });

  it("reply from the mint lost while issuing: recovery finds the ecash, credits once", async () => {
    const inv = await gw.makeInvoice({ amountSat: 1200 });
    await world.pay({ bolt11: inv.bolt11, maxFeeSat: 20 });
    await post(db, systemClock, { kind: "ln.received", idemKey: "recv:y", postings: [{ account: "ext:lightning", delta: -1200 }, { account: FLOAT_NODE, delta: 1200 }] });
    fault("/v1/mint/bolt11", "lost-reply");
    const first = await vault.mintFor({ idemKey: "mint:y", owner: "user:awa", amountSat: 1200 });
    heal();
    // either the library's own retry already healed it, or it is pending and recover() finishes it
    if (first.status === "pending") {
      expect(await spendable("user:awa")).toBe(0);
      const r = await vault.recover();
      expect(r.done).toBe(1);
    }
    expect(await spendable("user:awa")).toBe(1200);
    await expectConsistent();
  }, 120_000);
});

describe("transfer", () => {
  it("moves ecash between owners and re-seals it under the receiver's key", async () => {
    await deposit("user:awa", 5000);
    const op = await vault.transfer({ idemKey: key(), from: "user:awa", to: "user:moussa", amountSat: 1234, meta: { note: "test" } });
    expect(op).toMatchObject({ status: "done", amountSat: 1234, kind: "transfer" });
    expect(await spendable("user:awa")).toBe(3766);
    expect(await spendable("user:moussa")).toBe(1234);
    expect(await lockedBal("user:awa")).toBe(0);
    expect((await vault.audit("user:moussa")).proofsSat).toBe(1234);
    await expectConsistent();
    // the mint agrees that what we hold is unspent
    expect(await vault.verifyHoldingsWithMint()).toMatchObject({ notUnspent: 0 });
  });

  it("refuses to overdraw, to send nothing, or to send to oneself, and changes nothing", async () => {
    await deposit("user:awa", 100);
    await expect(vault.transfer({ idemKey: key(), from: "user:awa", to: "user:moussa", amountSat: 101 })).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    await expect(vault.transfer({ idemKey: key(), from: "user:awa", to: "user:moussa", amountSat: 0 })).rejects.toMatchObject({ code: "BAD_AMOUNT" });
    await expect(vault.transfer({ idemKey: key(), from: "user:awa", to: "user:moussa", amountSat: 1.5 })).rejects.toMatchObject({ code: "BAD_AMOUNT" });
    await expect(vault.transfer({ idemKey: key(), from: "user:awa", to: "user:awa", amountSat: 10 })).rejects.toMatchObject({ code: "BAD_INPUT" });
    await expect(vault.transfer({ idemKey: key(), from: "user:nobody", to: "user:awa", amountSat: 10 })).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    expect(await spendable("user:awa")).toBe(100);
    await expectConsistent();
  });

  it("the same key moves money once", async () => {
    await deposit("user:awa", 1000);
    const k = key();
    const a = await vault.transfer({ idemKey: k, from: "user:awa", to: "user:moussa", amountSat: 300 });
    const b = await vault.transfer({ idemKey: k, from: "user:awa", to: "user:moussa", amountSat: 300 });
    expect(b.id).toBe(a.id);
    expect(await spendable("user:moussa")).toBe(300);
  });

  it("two sends at once from one account: both are safe, the books still balance", async () => {
    await deposit("user:awa", 1000);
    const results = await Promise.all(
      ["user:b", "user:c", "user:d"].map((to) => vault.transfer({ idemKey: key(), from: "user:awa", to, amountSat: 400 }).then((o) => o.status, (e: AppError) => e.code)),
    );
    const done = results.filter((r) => r === "done").length;
    expect(done).toBeGreaterThanOrEqual(1);
    expect(done).toBeLessThanOrEqual(2);
    expect(results.every((r) => ["done", "BUSY", "INSUFFICIENT_FUNDS"].includes(r))).toBe(true);
    expect(await spendable("user:awa")).toBe(1000 - 400 * done);
    await expectConsistent();
  });

  it("crash mid-swap after the mint ran it: funds stay locked, a second send gets BUSY, recovery completes the first", async () => {
    await deposit("user:awa", 2000);
    fault("/v1/swap", "lost-reply");
    const first = await vault.transfer({ idemKey: "crash-1", from: "user:awa", to: "user:moussa", amountSat: 700 });
    expect(first.status).toBe("pending");
    expect(await lockedBal("user:awa")).toBe(700);
    expect(await spendable("user:moussa")).toBe(0);
    await expect(vault.transfer({ idemKey: key(), from: "user:awa", to: "user:c", amountSat: 100 })).rejects.toMatchObject({ code: "BUSY" });
    await expectConsistent(); // even mid-flight the ledger equals the proofs we hold

    // "restart": a fresh Vault on the same database, nothing in memory
    heal();
    vault = new Vault({ db, clock: systemClock, mint, ln: gw, pepper });
    const r = await vault.recover();
    expect(r).toMatchObject({ checked: 1, done: 1 });
    expect(await spendable("user:moussa")).toBe(700);
    expect(await spendable("user:awa")).toBe(1300);
    expect(await lockedBal("user:awa")).toBe(0);
    // replaying the original request now reports the finished operation
    expect((await vault.transfer({ idemKey: "crash-1", from: "user:awa", to: "user:moussa", amountSat: 700 })).status).toBe("done");
    expect(await spendable("user:moussa")).toBe(700);
    await expectConsistent();
    expect(await vault.verifyHoldingsWithMint()).toMatchObject({ notUnspent: 0 });
  }, 120_000);

  it("mint unreachable: nothing moved, recovery releases the funds", async () => {
    await deposit("user:awa", 900);
    fault("/v1/swap", "down");
    const first = await vault.transfer({ idemKey: key(), from: "user:awa", to: "user:moussa", amountSat: 500 });
    expect(first.status).toBe("pending");
    heal();
    const r = await vault.recover();
    expect(r).toMatchObject({ checked: 1, failed: 1 });
    expect(await spendable("user:awa")).toBe(900);
    expect(await lockedBal("user:awa")).toBe(0);
    await vault.transfer({ idemKey: key(), from: "user:awa", to: "user:moussa", amountSat: 500 });
    expect(await spendable("user:moussa")).toBe(500);
    await expectConsistent();
  }, 120_000);
});

describe("at rest", () => {
  it("a database dump holds no readable secret, and the wrong pepper cannot open it", async () => {
    await deposit("user:awa", 640);
    const plain = await vault.liveProofs("user:awa");
    const rows = await db.query<{ sealed: Buffer; secret_hash: string }>("SELECT sealed, secret_hash FROM proofs");
    const dump = Buffer.concat(rows.map((r) => Buffer.from(r.sealed))).toString("latin1") + rows.map((r) => r.secret_hash).join("");
    for (const p of plain) {
      expect(dump).not.toContain(p.secret);
      expect(dump).not.toContain(p.C);
    }
    const thief = new Vault({ db, clock: systemClock, mint, ln: gw, pepper: randomBytes(32) });
    await expect(thief.liveProofs("user:awa")).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("a proof row copied under another owner does not open", async () => {
    await deposit("user:awa", 64);
    await deposit("user:eve", 64);
    await db.query("UPDATE proofs SET sealed = (SELECT sealed FROM proofs WHERE owner = 'user:awa' LIMIT 1) WHERE owner = 'user:eve'");
    await expect(vault.liveProofs("user:eve")).rejects.toMatchObject({ code: "INTERNAL" });
  });
});

describe("locked ecash for vouchers", () => {
  it("locks to a key, redeems with it, refuses the wrong key and a second redeem", async () => {
    await deposit("user:awa", 3000);
    const sk = randomPrivKey();
    const refundSk = randomPrivKey();
    const lock = { pubkey: pubkeyFromPriv(sk), locktime: Math.floor(Date.now() / 1000) + 3600, refundKeys: [pubkeyFromPriv(refundSk)] };
    await vault.transfer({ idemKey: key(), from: "user:awa", to: "voucher:v1", amountSat: 1000, lock });
    expect(await spendable("voucher:v1")).toBe(1000);
    expect(await spendable("user:awa")).toBe(2000);
    const lockedProofs = await vault.liveProofs("voucher:v1");
    expect(mint.verifyOffline(lockedProofs, lock.pubkey)).toBe(true);

    await expect(vault.transfer({ idemKey: key(), from: "voucher:v1", to: "user:moussa", amountSat: "all", privkey: randomPrivKey() })).rejects.toMatchObject({ code: "UPSTREAM" });
    await expect(vault.transfer({ idemKey: key(), from: "voucher:v1", to: "user:moussa", amountSat: "all" })).rejects.toMatchObject({ code: "UPSTREAM" });
    expect(await spendable("voucher:v1")).toBe(1000);
    expect(await lockedBal("voucher:v1")).toBe(0);

    const ok = await vault.transfer({ idemKey: key(), from: "voucher:v1", to: "user:moussa", amountSat: "all", privkey: sk });
    expect(ok).toMatchObject({ status: "done", amountSat: 1000 });
    expect(await spendable("user:moussa")).toBe(1000);
    await expect(vault.transfer({ idemKey: key(), from: "voucher:v1", to: "user:eve", amountSat: "all", privkey: sk })).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    await expectConsistent();
  });

  it("a voucher redeemed from another wallet is noticed and leaves the books", async () => {
    await deposit("user:awa", 500);
    const sk = randomPrivKey();
    const lock = { pubkey: pubkeyFromPriv(sk), locktime: Math.floor(Date.now() / 1000) + 3600, refundKeys: [pubkeyFromPriv(randomPrivKey())] };
    await vault.transfer({ idemKey: key(), from: "user:awa", to: "voucher:v2", amountSat: 200, lock });
    const token = mint.encodeToken(await vault.liveProofs("voucher:v2"));
    expect(await vault.writeOffSpent("voucher:v2", key())).toBe(0); // still there
    // someone redeems the published token directly at the mint, with the code-derived key
    const outside = await mint.runSwap(mint.planSwap(mint.decodeToken(token), 200), sk);
    expect(outside.send.reduce((s, p) => s + p.amount, 0)).toBe(200);
    expect(await vault.writeOffSpent("voucher:v2", key())).toBe(200);
    expect(await spendable("voucher:v2")).toBe(0);
    expect(await balance(db, "ext:ecash")).toBe(200);
    await expectConsistent();
  });
});

describe("export and import of standard tokens", () => {
  it("exports a token that any Cashu wallet can take, and imports one back", async () => {
    await deposit("user:awa", 1000);
    const { op, token } = await vault.exportToken({ idemKey: "exp-1", owner: "user:awa", amountSat: 400 });
    expect(op.status).toBe("done");
    expect(token).toMatch(/^cashuB/);
    expect(await spendable("user:awa")).toBe(600);
    expect(await balance(db, "ext:ecash")).toBe(400);
    // asking again with the same key returns the same token, it does not mint a second one
    expect((await vault.exportToken({ idemKey: "exp-1", owner: "user:awa", amountSat: 400 })).token).toBe(token);
    await expectConsistent();

    const back = await vault.importToken({ idemKey: "imp-1", to: "user:moussa", token: token! });
    expect(back).toMatchObject({ status: "done", amountSat: 400 });
    expect(await spendable("user:moussa")).toBe(400);
    expect(await balance(db, "ext:ecash")).toBe(0);
    // the same token a second time is refused by the mint and credits nothing
    await expect(vault.importToken({ idemKey: "imp-2", to: "user:eve", token: token! })).rejects.toMatchObject({ code: "UPSTREAM" });
    expect(await spendable("user:eve")).toBe(0);
    await expectConsistent();
  });
});

describe("pay a Lightning invoice", () => {
  it("pays, returns the unused fee reserve, books the fee actually paid", async () => {
    await deposit("user:awa", 5000);
    const inv = await world.makeInvoice({ amountSat: 2000, memo: "pay test" });
    const op = await vault.melt({ idemKey: key(), owner: "user:awa", bolt11: inv.bolt11 });
    expect(op.status).toBe("done");
    expect((await world.lookupInvoice(inv.paymentHash))?.state).toBe("settled");
    const fee = Number(op.data.feePaidSat);
    expect(fee).toBeGreaterThanOrEqual(0);
    expect(fee).toBeLessThanOrEqual(Number(op.data.feeReserveSat));
    expect(await spendable("user:awa")).toBe(5000 - 2000 - fee);
    expect(await lockedBal("user:awa")).toBe(0);
    expect(String(op.data.preimage)).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(Buffer.from(String(op.data.preimage), "hex")).digest("hex")).toBe(inv.paymentHash);
    await expectConsistent();
  });

  it("an invoice that cannot be paid gives every sat back", async () => {
    await deposit("user:awa", 1000);
    const preimage = randomBytes(32);
    const hash = createHash("sha256").update(preimage).digest("hex");
    const inv = await world.makeHoldInvoice({ amountSat: 300, paymentHash: hash, expirySec: 600 });
    await world.cancel(hash);
    const op = await vault.melt({ idemKey: key(), owner: "user:awa", bolt11: inv.bolt11 });
    expect(op.status).toBe("failed");
    expect(await spendable("user:awa")).toBe(1000);
    expect(await lockedBal("user:awa")).toBe(0);
    await expectConsistent();
    expect(await vault.verifyHoldingsWithMint()).toMatchObject({ notUnspent: 0 });
  });

  it("refuses when the balance cannot cover amount plus fee reserve, or the invoice has no amount", async () => {
    await deposit("user:awa", 500);
    const inv = await world.makeInvoice({ amountSat: 500 });
    await expect(vault.melt({ idemKey: key(), owner: "user:awa", bolt11: inv.bolt11 })).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    const r = await world.request<{ payment_request: string }>("POST", "/v1/invoices", { memo: "any amount" });
    await expect(vault.melt({ idemKey: key(), owner: "user:awa", bolt11: r.payment_request })).rejects.toMatchObject({ code: "BAD_AMOUNT" });
    expect(await spendable("user:awa")).toBe(500);
  });

  it("payment held by the payee: funds stay locked while pending, settle on resume", async () => {
    await deposit("user:awa", 3000);
    const preimage = randomBytes(32);
    const hash = createHash("sha256").update(preimage).digest("hex");
    const inv = await world.makeHoldInvoice({ amountSat: 1000, paymentHash: hash, expirySec: 600 });
    // The mint's melt call blocks while the payee holds the payment. Treat that as "no answer yet".
    const melting = vault.melt({ idemKey: "held-1", owner: "user:awa", bolt11: inv.bolt11 });
    for (let i = 0; i < 60 && (await world.lookupInvoice(hash))?.state !== "accepted"; i++) await new Promise((r) => setTimeout(r, 300));
    expect((await world.lookupInvoice(hash))?.state).toBe("accepted");
    expect(await lockedBal("user:awa")).toBeGreaterThanOrEqual(1000);
    expect(await spendable("user:awa")).toBeLessThanOrEqual(2000);
    await expect(vault.transfer({ idemKey: key(), from: "user:awa", to: "user:b", amountSat: 10 })).rejects.toMatchObject({ code: "BUSY" });
    await world.settle(preimage.toString("hex"));
    const op = await melting;
    const final = op.status === "pending" ? await vault.resume(op.id) : op;
    expect(final.status).toBe("done");
    expect(await lockedBal("user:awa")).toBe(0);
    await expectConsistent();
  }, 180_000);

  it("reply lost after the mint paid: recovery books the payment once and restores the change", async () => {
    await deposit("user:awa", 4000);
    const inv = await world.makeInvoice({ amountSat: 1500 });
    fault("/v1/melt/bolt11", "lost-reply");
    const first = await vault.melt({ idemKey: "melt-crash", owner: "user:awa", bolt11: inv.bolt11 });
    heal();
    expect((await world.lookupInvoice(inv.paymentHash))?.state).toBe("settled");
    vault = new Vault({ db, clock: systemClock, mint, ln: gw, pepper });
    const final = first.status === "pending" ? (await vault.recover(), await vault.findOp("melt-crash"))! : first;
    expect(final.status).toBe("done");
    const fee = Number(final.data.feePaidSat);
    expect(await spendable("user:awa")).toBe(4000 - 1500 - fee);
    expect(await lockedBal("user:awa")).toBe(0);
    await expectConsistent();
    expect(await vault.verifyHoldingsWithMint()).toMatchObject({ notUnspent: 0 });
  }, 180_000);
});

describe("ledger equals proofs under random traffic", () => {
  // Default is a short run. VAULT_SENDS=1000 runs the campaign named in the plan.
  const sends = Number(process.env.VAULT_SENDS ?? 60);
  it(`${sends} random sends between five accounts`, async () => {
    const owners = ["user:a", "user:b", "user:c", "user:d", "user:e"];
    for (const o of owners) await deposit(o, 20_000);
    const total = 100_000;
    let done = 0;
    let refused = 0;
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 4 }), fc.integer({ min: 0, max: 4 }), fc.oneof(fc.integer({ min: 1, max: 3000 }), fc.integer({ min: 1, max: 60_000 })), async (i, j, amount) => {
        try {
          const op = await vault.transfer({ idemKey: key("rnd"), from: owners[i]!, to: owners[j]!, amountSat: amount });
          expect(op.status).toBe("done");
          done++;
        } catch (e) {
          expect(["INSUFFICIENT_FUNDS", "BAD_INPUT"]).toContain((e as AppError).code);
          refused++;
        }
      }),
      { numRuns: sends },
    );
    let sum = 0;
    for (const o of owners) {
      const a = await vault.audit(o);
      expect(a.ok, o).toBe(true);
      sum += a.ledgerSat;
    }
    expect(sum).toBe(total);
    await expectConsistent();
    expect(await vault.verifyHoldingsWithMint(100_000)).toMatchObject({ notUnspent: 0 });
    console.log(`random sends: ${done} done, ${refused} refused, total still ${sum} sats`);
  }, 3_600_000);
});
