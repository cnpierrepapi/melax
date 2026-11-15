// FCFA per bitcoin: one live source, a fallback through the fixed euro peg, and a cache for when both are away.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeClock, MINUTE, silentLogger } from "@melax/core";
import { type Db, truncateAll } from "@melax/ledger";
import { Rates } from "../src/rates.ts";
import { newDb } from "./helpers.ts";

// Recorded on 15 Nov 2026 from
// https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=xof,eur
const RECORDED = '{"bitcoin":{"xof":39090841,"eur":59594}}';

let db: Db;
let clock: FakeClock;
let calls: string[];

beforeAll(async () => {
  db = await newDb();
});
beforeEach(async () => {
  await truncateAll(db);
  clock = new FakeClock();
  calls = [];
});
afterAll(async () => {
  await db?.close();
});

type Answer = string | Error | (() => Promise<Response>);
function rates(answers: Answer[], fixed?: number): Rates {
  let i = 0;
  return new Rates({
    db,
    clock,
    log: silentLogger,
    fixedXofPerBtc: fixed,
    fetch: async (url) => {
      calls.push(String(url));
      const a = answers[Math.min(i++, answers.length - 1)]!;
      if (a instanceof Error) throw a;
      if (typeof a === "function") return a();
      return new Response(a, { status: 200, headers: { "content-type": "application/json" } });
    },
  });
}

describe("exchange rate", () => {
  it("reads FCFA per bitcoin from the recorded CoinGecko answer", async () => {
    const r = await rates([RECORDED]).get();
    expect(r).toMatchObject({ xofPerBtc: 39_090_841, source: "coingecko" });
    expect(calls).toEqual(["https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=xof,eur"]);
  });

  it("falls back to the euro price times the fixed peg when the franc price is missing", async () => {
    const r = await rates(['{"bitcoin":{"eur":59594}}']).get();
    expect(r).toMatchObject({ xofPerBtc: Math.round(59_594 * 655.957), source: "coingecko-eur" });
    // the peg keeps the two within a tenth of a percent of each other on the recorded answer
    expect(Math.abs(r.xofPerBtc - 39_090_841) / 39_090_841).toBeLessThan(0.001);
  });

  it("a fixed rate from the configuration never calls out", async () => {
    expect(await rates([new Error("must not be called")], 40_000_000).get()).toMatchObject({ xofPerBtc: 40_000_000, source: "fixed" });
    expect(calls).toEqual([]);
  });

  it("asks once and serves from the cache for two minutes, also across a restart", async () => {
    const a = rates([RECORDED]);
    await a.get();
    await a.get();
    clock.advance(2 * MINUTE - 1);
    await a.get();
    expect(calls).toHaveLength(1);
    const afterRestart = rates([new Error("must not be called")]);
    expect((await afterRestart.get()).xofPerBtc).toBe(39_090_841);
    clock.advance(2);
    const refreshed = rates(['{"bitcoin":{"xof":40000000,"eur":60979}}']);
    expect((await refreshed.get()).xofPerBtc).toBe(40_000_000);
  });

  it("many callers at once share one request", async () => {
    const r = rates([RECORDED]);
    const all = await Promise.all(Array.from({ length: 8 }, () => r.get()));
    expect(new Set(all.map((x) => x.xofPerBtc))).toEqual(new Set([39_090_841]));
    expect(calls).toHaveLength(1);
  });

  it("when the source is down an older rate is used for up to an hour and marked stale", async () => {
    await rates([RECORDED]).get();
    clock.advance(30 * MINUTE);
    const down = rates([new Error("fetch failed")]);
    expect(await down.get()).toMatchObject({ xofPerBtc: 39_090_841, source: "coingecko", stale: true });
    clock.advance(31 * MINUTE);
    await expect(rates([new Error("fetch failed")]).get()).rejects.toMatchObject({ code: "UPSTREAM" });
  });

  it("with no source and no cache there is no rate, and nothing is invented", async () => {
    await expect(rates([new Error("fetch failed")]).get()).rejects.toMatchObject({ code: "UPSTREAM" });
  });

  it("treats nonsense from the source as no answer", async () => {
    const junk = ['{"bitcoin":{"xof":0}}', '{"bitcoin":{"xof":-5,"eur":-1}}', '{"bitcoin":{"xof":"39090841"}}', "<html>rate limited</html>", '{"status":{"error_code":429}}', '{"bitcoin":{"xof":1e15}}'];
    for (const body of junk) {
      await truncateAll(db);
      await expect(rates([body]).get(), body).rejects.toMatchObject({ code: "UPSTREAM" });
    }
    await truncateAll(db);
    await expect(rates([() => Promise.resolve(new Response(RECORDED, { status: 429 }))]).get()).rejects.toMatchObject({ code: "UPSTREAM" });
  });
});
