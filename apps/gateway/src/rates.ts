// FCFA per bitcoin. Users type and read francs; the books are in sats; this is the bridge.
// Contract:
//   - whole FCFA per BTC. Source: CoinGecko's XOF price, or its EUR price times the fixed peg (655.957)
//     when the XOF figure is missing. A fixed rate from the configuration never calls out;
//   - a rate is reused for two minutes. When the source is down an older one is used for up to an hour
//     and marked stale. Past that there is no rate: the caller gets UPSTREAM and nothing is invented;
//   - an answer that is not a plausible positive number counts as no answer.
// Callers: wallet.ts (every screen that shows francs).
import { AppError, type Clock, HOUR, type Logger, MINUTE, XOF_PER_EUR, silentLogger, toSafeInt } from "@melax/core";
import type { Db } from "@melax/ledger";

export const RATE_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=xof,eur";
const FRESH_MS = 2 * MINUTE;
const STALE_MS = HOUR;
/** Outside this range the figure is a parsing accident, not a price. */
const MIN_XOF = 100_000;
const MAX_XOF = 100_000_000_000;

export interface RateInfo {
  xofPerBtc: number;
  source: string;
  fetchedAt: number;
  /** True when the source could not be reached and an older rate was used. */
  stale?: true;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RatesDeps {
  db: Db;
  clock: Clock;
  log?: Logger;
  fixedXofPerBtc?: number | null;
  fetch?: FetchLike;
}

const plausible = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= MIN_XOF && n <= MAX_XOF;

export class Rates {
  private readonly d: RatesDeps;
  private readonly log: Logger;
  private cached: RateInfo | null = null;
  private inFlight: Promise<RateInfo> | null = null;

  constructor(deps: RatesDeps) {
    this.d = deps;
    this.log = deps.log ?? silentLogger;
  }

  async get(): Promise<RateInfo> {
    const now = this.d.clock.now();
    if (this.d.fixedXofPerBtc) return { xofPerBtc: this.d.fixedXofPerBtc, source: "fixed", fetchedAt: now };
    if (this.cached && now - this.cached.fetchedAt < FRESH_MS) return this.cached;
    this.inFlight ??= this.refresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async refresh(): Promise<RateInfo> {
    const now = this.d.clock.now();
    const row = (await this.d.db.query<{ xof_per_btc: number; source: string; fetched_at: number }>("SELECT xof_per_btc, source, fetched_at FROM price_cache WHERE id = 1"))[0];
    const stored: RateInfo | null = row ? { xofPerBtc: toSafeInt(row.xof_per_btc), source: row.source, fetchedAt: toSafeInt(row.fetched_at) } : null;
    if (stored && now - stored.fetchedAt < FRESH_MS) return (this.cached = stored);

    try {
      const live = await this.fetchLive();
      await this.d.db.query(
        "INSERT INTO price_cache (id, xof_per_btc, source, fetched_at) VALUES (1, $1, $2, $3) ON CONFLICT (id) DO UPDATE SET xof_per_btc = $1, source = $2, fetched_at = $3",
        [live.xofPerBtc, live.source, live.fetchedAt],
      );
      return (this.cached = live);
    } catch (e) {
      this.log.warn("rates.source_down", { err: e });
      if (stored && now - stored.fetchedAt <= STALE_MS) return { ...stored, stale: true };
      throw new AppError("UPSTREAM", "no exchange rate available");
    }
  }

  private async fetchLive(): Promise<RateInfo> {
    const f = this.d.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
    const res = await f(RATE_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new AppError("UPSTREAM", `rate source answered ${res.status}`);
    const j = (await res.json()) as { bitcoin?: { xof?: unknown; eur?: unknown } };
    const fetchedAt = this.d.clock.now();
    const xof = j?.bitcoin?.xof;
    if (plausible(xof)) return { xofPerBtc: Math.round(xof), source: "coingecko", fetchedAt };
    const eur = j?.bitcoin?.eur;
    const viaPeg = typeof eur === "number" && Number.isFinite(eur) ? Math.round(eur * XOF_PER_EUR) : NaN;
    if (xof === undefined && plausible(viaPeg)) return { xofPerBtc: viaPeg, source: "coingecko-eur", fetchedAt };
    throw new AppError("UPSTREAM", "rate source sent no usable price");
  }
}
