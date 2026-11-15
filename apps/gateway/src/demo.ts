// Everything that exists only for the demo: what the web phone simulator reads (/sim/sms, /sim/people,
// /sim/state), the top-up button (/sim/fund), and the seed that opens six accounts at a market in Dakar.
// Contract:
//   - nothing here is mounted outside demo mode (http.ts, behind `if (config.demo)`), and these routes
//     have no authentication: in a demo anyone can hold any phone;
//   - /sim/state never returns a proof, a phone number, a user id, an idempotency key or a sealed
//     column. Accounts are shown under first names;
//   - a top-up is a real deposit: the regtest "world" node pays an invoice of the gateway's node, and
//     Wallet.deposit turns the sats into ecash. It exists only when both nodes say they are on regtest,
//     and one call is capped at FUND_CAP_FCFA;
//   - the seed does nothing when any user already exists.
// Callers: http.ts (mountDemo), boot.ts (regtestWorld), main.ts and scripts/demo-seed.ts (seedDemo).
import type { FastifyInstance } from "fastify";
import { type Logger, fcfaToSats, normalizePhone, toSafeInt } from "@melax/core";
import type { Lang } from "@melax/i18n";
import { type LightningBackend, LndBackend } from "@melax/lightning";
import type { App } from "./app.ts";
import type { Config } from "./config.ts";

/** The one code every seeded account shares. It is printed on the demo page. */
export const DEMO_PIN = "27495";
export const FUND_CAP_FCFA = 25_000;
export const FUND_MIN_FCFA = 100;
const STATE_ENTRIES = 20;

/**
 * Six people at a market in Dakar, then two agents. The numbers are made up. An agent's `momo` is the
 * mobile-money number the users of a cash-in are told to pay; `bondFcfa` goes from their balance into
 * their bond. Add people at the end: the browser tests use these by position and by name.
 */
export const DEMO_PEOPLE: ReadonlyArray<{ name: string; phone: string; lang: Lang; fcfa: number; agent?: { momo: string; method: "wave" | "om"; premiumBp: number; bondFcfa: number } }> = [
  { name: "Awa", phone: "+221770000101", lang: "fr", fcfa: 15_000 },
  { name: "Moussa", phone: "+221780000102", lang: "wo", fcfa: 8000 },
  { name: "Fatou", phone: "+221760000103", lang: "fr", fcfa: 12_000 },
  { name: "Ibrahima", phone: "+221770000104", lang: "wo", fcfa: 5000 },
  { name: "Aminata", phone: "+221700000105", lang: "en", fcfa: 20_000 },
  { name: "Cheikh", phone: "+221750000106", lang: "fr", fcfa: 3000 },
  { name: "Ndeye", phone: "+221770000107", lang: "fr", fcfa: 25_000, agent: { momo: "+221776665544", method: "wave", premiumBp: 100, bondFcfa: 20_000 } },
  { name: "Ousmane", phone: "+221780000108", lang: "wo", fcfa: 25_000, agent: { momo: "+221786665533", method: "om", premiumBp: 150, bondFcfa: 20_000 } },
];
export const DEMO_AGENT_RANGE = { minFcfa: 500, maxFcfa: 20_000 };
/** A morning's payments between them, as [from, to, FCFA], so nobody's history is empty. */
const DEMO_SENDS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 2, 2500],
  [2, 1, 1000],
  [4, 5, 3000],
  [1, 0, 500],
  [3, 4, 1500],
];

// ---------- the world node ----------

/**
 * The node that pays top-ups, or nothing. It is handed over only when it is configured, demo mode is
 * on, and both it and the gateway's own node report regtest. Any doubt means no top-up button.
 */
export async function regtestWorld(a: { config: Config; ln: LightningBackend; log: Logger; open?: (c: NonNullable<Config["demoWorld"]>) => LightningBackend }): Promise<LightningBackend | undefined> {
  const c = a.config.demoWorld;
  if (!a.config.demo || !c) return undefined;
  const open = a.open ?? ((x: NonNullable<Config["demoWorld"]>) => LndBackend.fromFiles({ baseUrl: x.restUrl, macaroonPath: x.macaroonPath, tlsCertPath: x.tlsCertPath }));
  let world: LightningBackend | undefined;
  try {
    world = open(c);
    const mine = await a.ln.capabilities();
    const theirs = await world.capabilities();
    if (mine.network === "regtest" && theirs.network === "regtest") return world;
    a.log.warn("demo.world.refused", { gateway: mine.network, world: theirs.network });
  } catch (err) {
    a.log.warn("demo.world.unavailable", { err });
  }
  await world?.close().catch(() => undefined);
  return undefined;
}

// ---------- the funding path ----------

export type FundResult = { ok: true; fcfa: number; sats: number } | { ok: false; err: "BAD_INPUT" | "NOT_FOUND" | "PENDING" | "UNAVAILABLE" };

/** One top-up: the world node pays the gateway node, the wallet credits the user. Real sats, real ecash, regtest. */
export async function fundAccount(app: App, world: LightningBackend, a: { phone: unknown; fcfa: unknown }): Promise<FundResult> {
  const fcfa = a.fcfa;
  if (typeof fcfa !== "number" || !Number.isSafeInteger(fcfa) || fcfa < FUND_MIN_FCFA || fcfa > FUND_CAP_FCFA) return { ok: false, err: "BAD_INPUT" };
  let phone: string;
  try {
    phone = normalizePhone(a.phone as string);
  } catch {
    return { ok: false, err: "BAD_INPUT" };
  }
  const user = await app.users.findByPhone(phone);
  if (!user) return { ok: false, err: "NOT_FOUND" };

  try {
    const rate = await app.rates.get();
    const sats = fcfaToSats(fcfa, rate.xofPerBtc);
    if (sats <= 0) return { ok: false, err: "BAD_INPUT" };
    const inv = await app.ln.makeInvoice({ amountSat: sats, memo: "Melax demo top-up", expirySec: 120 });
    const paid = await world.pay({ bolt11: inv.bolt11, maxFeeSat: 20, timeoutSec: 20 });
    if (paid.status !== "succeeded") {
      app.log.warn("demo.fund.unpaid", { user: user.id, status: paid.status, reason: paid.status === "failed" ? paid.reason : undefined });
      return { ok: false, err: "UNAVAILABLE" };
    }
    const r = await app.wallet.deposit({ userId: user.id, paymentHash: inv.paymentHash });
    if (r.ok) return { ok: true, fcfa: r.fcfa, sats: r.sats };
    return { ok: false, err: r.err === "PENDING" ? "PENDING" : "UNAVAILABLE" };
  } catch (err) {
    app.log.error("demo.fund.failed", { user: user.id, err });
    return { ok: false, err: "UNAVAILABLE" };
  }
}

// ---------- the seed ----------

/**
 * Open the six accounts, top each one up through the funding path, then make a few payments between
 * them. Does nothing when a user already exists. Without a world node the accounts are opened empty.
 * `funded` is true only when every top-up and every payment went through.
 */
export async function seedDemo(app: App): Promise<{ seeded: boolean; funded: boolean }> {
  if ((await app.db.query("SELECT 1 FROM users LIMIT 1")).length > 0) return { seeded: false, funded: false };
  const shoppers = DEMO_PEOPLE.filter((p) => !p.agent); // the agents are seedAgents' job
  for (const p of shoppers) await app.users.register({ phone: p.phone, pin: DEMO_PIN, name: p.name, lang: p.lang });
  const world = app.world;
  if (!world) {
    app.log.warn("demo.seed.no_world", {});
    return { seeded: true, funded: false };
  }

  let funded = true;
  for (const p of shoppers) {
    const r = await fundAccount(app, world, { phone: p.phone, fcfa: p.fcfa });
    if (!r.ok) {
      app.log.error("demo.seed.fund_failed", { reason: r.err });
      funded = false;
    }
  }
  for (const [i, [from, to, fcfa]] of DEMO_SENDS.entries()) {
    const sender = await app.users.findByPhone(DEMO_PEOPLE[from]!.phone);
    const recipient = await app.users.findByPhone(DEMO_PEOPLE[to]!.phone);
    if (!sender || !recipient) continue;
    const rate = await app.rates.get();
    const r = await app.wallet.send({ user: sender, toRef: recipient.id, fcfa, sats: fcfaToSats(fcfa, rate.xofPerBtc), pin: DEMO_PIN, idemKey: `seed:send:${i}` });
    if (!r.ok) {
      app.log.error("demo.seed.send_failed", { reason: r.err });
      funded = false;
    }
  }
  app.log.info("demo.seed.done", { accounts: shoppers.length, funded });
  return { seeded: true, funded };
}

/**
 * The two demo agents: an account, a top-up, the agent's offer, and a bond. Each part is done only if it
 * is missing, so this runs on every start and also completes a database seeded before agents existed.
 * The agents' wallet is the regtest world node. Without it there is nothing to seed.
 */
export async function seedAgents(app: App): Promise<{ agents: number }> {
  const world = app.world;
  if (!world) return { agents: 0 };
  let n = 0;
  for (const p of DEMO_PEOPLE) {
    if (!p.agent) continue;
    try {
      let user = await app.users.findByPhone(p.phone);
      if (!user) {
        user = await app.users.register({ phone: p.phone, pin: DEMO_PIN, name: p.name, lang: p.lang });
        const r = await fundAccount(app, world, { phone: p.phone, fcfa: p.fcfa });
        if (!r.ok) app.log.error("demo.agent.fund_failed", { reason: r.err });
      }
      if (!(await app.agents.get(user.id))) {
        await app.agents.enroll({ userId: user.id, momo: p.agent.momo, method: p.agent.method, premiumBp: p.agent.premiumBp, ...DEMO_AGENT_RANGE, wallet: { kind: "world" } });
      }
      if ((await app.agents.bondSats(user.id)) === 0) {
        const fresh = (await app.users.byId(user.id))!;
        const r = await app.escrow.bondAdd({ agent: fresh, fcfa: p.agent.bondFcfa, pin: DEMO_PIN, idemKey: `seed:bond:${user.id}:${app.clock.now()}` });
        if (!r.ok) app.log.error("demo.agent.bond_failed", { reason: r.err });
      }
      n++;
    } catch (err) {
      app.log.error("demo.agent.seed_failed", { err });
    }
  }
  return { agents: n };
}

// ---------- the routes ----------

/** `user:<id>:spendable` becomes `Awa:spendable`. Any other owner keeps its kind and loses its id. */
function publicAccount(account: string, names: Map<string, string>): string {
  const parts = account.split(":");
  if (parts.length < 3) return account; // float:node, ext:lightning and the other fixed accounts
  const last = parts[parts.length - 1]!;
  if (parts[0] === "user") return `${names.get(parts[1]!) ?? "?"}:${last}`;
  return `${parts[0]}:${last}`;
}

export function mountDemo(http: FastifyInstance, app: App): void {
  const { db, config } = app;
  const world = app.world;

  http.get<{ Querystring: { phone?: unknown } }>("/sim/sms", async (req) => {
    const phone = normalizePhone(req.query.phone as string);
    const items = await app.outbox.list(phone);
    return { messages: items.map((m) => ({ id: m.id, kind: m.kind, text: m.body ?? "", at: m.createdAt })) };
  });

  http.get("/sim/people", async () => {
    const people: Array<{ name: string; phone: string; lang: Lang; agent: boolean }> = [];
    for (const p of DEMO_PEOPLE) {
      const u = await app.users.findByPhone(p.phone);
      if (u) people.push({ name: u.name, phone: p.phone.replace("+221", ""), lang: u.lang, agent: u.role === "agent" });
    }
    return { code: DEMO_PIN, ussd: config.ussdCode, topUp: { on: world !== undefined, capFcfa: FUND_CAP_FCFA }, people };
  });

  http.get("/sim/state", async () => {
    const journal = await db.query<{ seq: number; ts: number; kind: string; hash: string }>("SELECT seq, ts, kind, hash FROM journal ORDER BY seq DESC LIMIT $1", [STATE_ENTRIES]);
    const seqs = journal.map((j) => toSafeInt(j.seq));
    const postings = seqs.length > 0 ? await db.query<{ journal_seq: number; account: string; delta: number }>("SELECT journal_seq, account, delta FROM postings WHERE journal_seq = ANY($1::bigint[])", [seqs]) : [];
    const ids = [...new Set(postings.map((p) => p.account.split(":")).filter((a) => a[0] === "user" && a.length >= 3).map((a) => a[1]!))];
    const users = ids.length > 0 ? await db.query<{ id: string; name: string }>("SELECT id, name FROM users WHERE id = ANY($1::text[])", [ids]) : [];
    const names = new Map(users.map((u) => [u.id, u.name]));

    const entries = journal.map((j) => {
      const seq = toSafeInt(j.seq);
      const lines = postings
        .filter((p) => toSafeInt(p.journal_seq) === seq)
        .map((p) => ({ account: publicAccount(p.account, names), sats: toSafeInt(p.delta) }))
        .sort((a, b) => a.sats - b.sats || (a.account < b.account ? -1 : 1));
      return { seq, at: toSafeInt(j.ts), kind: j.kind, hash: j.hash.slice(0, 12), lines };
    });

    const audit = await app.vault.auditAll();
    const rate = await app.rates.get().catch(() => null);
    return {
      entries,
      totals: { ledgerSat: audit.ledgerSat, ecashSat: audit.proofsSat, match: audit.ok },
      mint: { name: app.mint.name, keyset: app.mint.keysetId },
      rate: rate ? { xofPerBtc: rate.xofPerBtc, source: rate.source } : null,
    };
  });

  // The arbiter's button of the demo: anyone holding the page decides a dispute, by its reference.
  http.post("/sim/decide", async (req, reply) => {
    const j = JSON.parse(typeof req.body === "string" ? req.body : "") as { ref?: unknown; winner?: unknown } | null;
    const trade = typeof j?.ref === "string" ? await app.escrow.byRef(j.ref) : null;
    if (!trade) return reply.code(404).send({ error: "not_found" });
    const r = await app.escrow.decide({ tradeId: trade.id, winner: j?.winner as "user" | "agent", arbiter: "demo", note: "" });
    if (r.ok) return { ok: true, state: r.trade.state };
    if (r.err === "BAD_INPUT") return reply.code(400).send({ error: "bad_request" });
    if (r.err === "STATE") return reply.code(409).send({ error: "conflict" });
    return reply.code(503).send({ error: "unavailable" });
  });

  if (world) {
    http.post("/sim/fund", async (req, reply) => {
      const j = JSON.parse(typeof req.body === "string" ? req.body : "") as { phone?: unknown; fcfa?: unknown } | null;
      const r = await fundAccount(app, world, { phone: j?.phone, fcfa: j?.fcfa });
      if (r.ok) return { ok: true, fcfa: r.fcfa, sats: r.sats };
      if (r.err === "BAD_INPUT") return reply.code(400).send({ error: "bad_request" });
      if (r.err === "NOT_FOUND") return reply.code(404).send({ error: "not_found" });
      // The sats arrived and the mint has not answered yet. The credit and its SMS follow.
      if (r.err === "PENDING") return reply.code(202).send({ ok: false, pending: true });
      return reply.code(503).send({ error: "unavailable" });
    });
  }
}
