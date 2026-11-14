import fc from "fast-check";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppError, FakeClock } from "@melax/core";
import { type Db, allBalances, balance, createMemoryDb, ledgerMigrations, migrate, post, truncateAll, verifyLedger } from "../src/index.ts";

let db: Db;
const clock = new FakeClock();
let n = 0;
const key = () => `k${++n}`;

beforeAll(async () => {
  db = await createMemoryDb();
  await migrate(db, ledgerMigrations);
});
beforeEach(() => truncateAll(db));

async function fund(account: string, sats: number) {
  await post(db, clock, { kind: "test.fund", idemKey: key(), postings: [{ account: "ext:lightning", delta: -sats }, { account, delta: sats }] });
}

describe("posting", () => {
  it("moves sats and keeps the books at zero", async () => {
    await fund("user:a:spendable", 1000);
    await post(db, clock, { kind: "transfer", idemKey: key(), postings: [{ account: "user:a:spendable", delta: -300 }, { account: "user:b:spendable", delta: 300 }] });
    expect(await balance(db, "user:a:spendable")).toBe(700);
    expect(await balance(db, "user:b:spendable")).toBe(300);
    expect(await balance(db, "ext:lightning")).toBe(-1000);
    expect(await balance(db, "user:nobody:spendable")).toBe(0);
    const all = await allBalances(db);
    expect([...all.values()].reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("refuses an entry that does not balance, has one leg, a zero leg or a fractional leg", async () => {
    const bad = [
      [{ account: "user:a:spendable", delta: 5 }, { account: "ext:lightning", delta: -4 }],
      [{ account: "user:a:spendable", delta: 5 }],
      [{ account: "user:a:spendable", delta: 0 }, { account: "ext:lightning", delta: 0 }],
      [{ account: "user:a:spendable", delta: 1.5 }, { account: "ext:lightning", delta: -1.5 }],
      [],
    ];
    for (const postings of bad) {
      await expect(post(db, clock, { kind: "x", idemKey: key(), postings })).rejects.toThrow(AppError);
    }
    expect((await verifyLedger(db)).entries).toBe(0);
  });

  it("refuses to overdraw anything that is not the outside world, and leaves no trace of the attempt", async () => {
    await fund("user:a:spendable", 100);
    const before = await verifyLedger(db);
    await expect(
      post(db, clock, { kind: "transfer", idemKey: key(), postings: [{ account: "user:a:spendable", delta: -101 }, { account: "user:b:spendable", delta: 101 }] }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    expect(await balance(db, "user:a:spendable")).toBe(100);
    expect(await balance(db, "user:b:spendable")).toBe(0);
    expect((await verifyLedger(db)).head).toBe(before.head);
  });

  it("the same idempotency key applies once, however many times it is sent", async () => {
    await fund("user:a:spendable", 100);
    const entry = { kind: "transfer", idemKey: "pay-1", postings: [{ account: "user:a:spendable", delta: -40 }, { account: "user:b:spendable", delta: 40 }] };
    const first = await post(db, clock, entry);
    const second = await post(db, clock, entry);
    const third = await post(db, clock, { ...entry, postings: [...entry.postings].reverse() });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(third.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    expect(await balance(db, "user:b:spendable")).toBe(40);
  });

  it("the same key with different money is a conflict, not a silent success", async () => {
    await fund("user:a:spendable", 100);
    await post(db, clock, { kind: "transfer", idemKey: "pay-2", postings: [{ account: "user:a:spendable", delta: -40 }, { account: "user:b:spendable", delta: 40 }] });
    await expect(
      post(db, clock, { kind: "transfer", idemKey: "pay-2", postings: [{ account: "user:a:spendable", delta: -41 }, { account: "user:b:spendable", delta: 41 }] }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await balance(db, "user:b:spendable")).toBe(40);
  });

  it("concurrent spends of the same money: exactly one wins", async () => {
    await fund("user:a:spendable", 100);
    const spend = (to: string) =>
      post(db, clock, { kind: "transfer", idemKey: key(), postings: [{ account: "user:a:spendable", delta: -80 }, { account: `user:${to}:spendable`, delta: 80 }] }).then(
        () => "ok",
        (e: AppError) => e.code,
      );
    const results = await Promise.all([spend("b"), spend("c"), spend("d")]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "INSUFFICIENT_FUNDS")).toHaveLength(2);
    expect(await balance(db, "user:a:spendable")).toBe(20);
  });
});

describe("crash safety", () => {
  it("a failure after the posting but inside the same transaction undoes the posting", async () => {
    await fund("user:a:spendable", 100);
    const before = await verifyLedger(db);
    await expect(
      db.tx(async (tx) => {
        await post(tx, clock, { kind: "transfer", idemKey: "crash-1", postings: [{ account: "user:a:spendable", delta: -60 }, { account: "user:b:spendable", delta: 60 }] });
        throw new Error("process died here");
      }),
    ).rejects.toThrow("process died here");
    expect(await balance(db, "user:a:spendable")).toBe(100);
    const after = await verifyLedger(db);
    expect(after).toMatchObject({ ok: true, head: before.head, entries: before.entries });
    // the retry with the same key is then a first attempt, not a duplicate
    const retry = await post(db, clock, { kind: "transfer", idemKey: "crash-1", postings: [{ account: "user:a:spendable", delta: -60 }, { account: "user:b:spendable", delta: 60 }] });
    expect(retry.duplicate).toBe(false);
    expect((await verifyLedger(db)).ok).toBe(true);
  });
});

describe("tamper evidence", () => {
  async function seed() {
    await fund("user:a:spendable", 1000);
    for (let i = 0; i < 5; i++) {
      await post(db, clock, { kind: "transfer", idemKey: key(), meta: { i }, postings: [{ account: "user:a:spendable", delta: -10 }, { account: "user:b:spendable", delta: 10 }] });
    }
  }
  it("an untouched ledger verifies", async () => {
    await seed();
    expect(await verifyLedger(db)).toMatchObject({ ok: true, entries: 6 });
  });
  it("editing an amount in history is detected", async () => {
    await seed();
    await db.query("UPDATE postings SET delta = delta + 1 WHERE journal_seq = 3 AND delta > 0");
    await db.query("UPDATE postings SET delta = delta - 1 WHERE journal_seq = 3 AND delta < 0");
    const v = await verifyLedger(db);
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toContain("hash");
  });
  it("editing a balance without a journal entry is detected", async () => {
    await seed();
    await db.query("UPDATE accounts SET balance = balance + 500 WHERE account = 'user:b:spendable'");
    const v = await verifyLedger(db);
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toContain("user:b:spendable");
  });
  it("deleting an entry from the middle is detected", async () => {
    await seed();
    await db.query("DELETE FROM postings WHERE journal_seq = 4");
    await db.query("DELETE FROM journal WHERE seq = 4");
    expect((await verifyLedger(db)).ok).toBe(false);
  });
  it("rewriting the metadata of an entry is detected", async () => {
    await seed();
    await db.query(`UPDATE journal SET meta = '{"i": 99}'::jsonb WHERE seq = 2`);
    expect((await verifyLedger(db)).ok).toBe(false);
  });
});

describe("invariants under random operations", () => {
  // Default is a quick run. PROPERTY_RUNS=10000 runs the full campaign named in the plan.
  const runs = Number(process.env.PROPERTY_RUNS ?? 40);
  const accounts = ["user:a:spendable", "user:a:locked", "user:b:spendable", "user:b:locked", "escrow:t1", "fees:income", "float:node", "ext:lightning"];
  const op = fc.record({
    from: fc.integer({ min: 0, max: accounts.length - 1 }),
    to: fc.integer({ min: 0, max: accounts.length - 1 }),
    amount: fc.oneof(fc.integer({ min: 1, max: 5000 }), fc.constantFrom(0, -5, 1.5, Number.MAX_SAFE_INTEGER)),
    reuseKey: fc.boolean(),
  });

  it(`sum is zero, nothing internal goes negative, the chain verifies (${runs} sequences)`, async () => {
    let seqNo = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 25 }), async (ops) => {
        seqNo++;
        let lastKey = "";
        for (const [i, o] of ops.entries()) {
          const idemKey = o.reuseKey && lastKey ? lastKey : `p${seqNo}-${i}`;
          lastKey = idemKey;
          const before = await allBalances(db);
          try {
            await post(db, clock, { kind: "prop", idemKey, postings: [{ account: accounts[o.from]!, delta: -o.amount }, { account: accounts[o.to]!, delta: o.amount }] });
          } catch (e) {
            if (!(e instanceof AppError)) throw e;
            // a refused entry must change nothing
            expect(await allBalances(db)).toEqual(before);
          }
        }
        const all = await allBalances(db);
        expect([...all.values()].reduce((a, b) => a + b, 0)).toBe(0);
        for (const [account, bal] of all) if (!account.startsWith("ext:")) expect(bal, account).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: runs },
    );
    expect((await verifyLedger(db)).ok).toBe(true);
  }, 3_600_000);
});
