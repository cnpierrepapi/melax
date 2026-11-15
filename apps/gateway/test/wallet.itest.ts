// The wallet end to end: accounts opened through the menus, real ecash from the real Nutshell mint,
// real payments between LND nodes on regtest. Postgres runs in-process (PGlite).
// Needs: docker compose up, bash scripts/dev-creds.sh. Faults are injected at the network edge only.
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MINUTE, systemClock } from "@melax/core";
import { MintClient } from "@melax/cashu";
import { shortDate } from "@melax/i18n";
import { type Db, balance, post, truncateAll, verifyLedger } from "@melax/ledger";
import { LndBackend } from "@melax/lightning";
import { FLOAT_NODE } from "@melax/vault";
import { buildHttp } from "../src/http.ts";
import { type TestApp, dial, inbox, logWords, newDb, signUp, testApp } from "./helpers.ts";

const keys = resolve(import.meta.dirname, "../../../.keys");
const lnd = (name: string, port: number) =>
  LndBackend.fromFiles({ baseUrl: `https://localhost:${port}`, macaroonPath: `${keys}/lnd-${name}/admin.macaroon`, tlsCertPath: `${keys}/lnd-${name}/tls.cert` });
const MINT = process.env.MINT_URL ?? "http://localhost:3338";

const AWA = "+221771234567";
const MOUSSA = "+221781112233";
const FATOU = "+221761239876";
const AWA_PIN = "48291";
const MOUSSA_PIN = "73915";
const FATOU_PIN = "26804";
const AT_SECRET = "at-" + "s".repeat(30);

let db: Db;
let mint: MintClient;
let gw: LndBackend;
let world: LndBackend;
let T: TestApp;
/** The server secret of the test in progress. A restart keeps it, as a real one would. */
let pepper: string;
/** Every log line of every test in this file, for the last test. */
const allLogs: string[] = [];

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

const idOf = async (phone: string) => (await T.app.users.findByPhone(phone))!.id;
const sats = async (phone: string) => balance(db, `user:${await idOf(phone)}:spendable`);
const lockedSats = async (phone: string) => balance(db, `user:${await idOf(phone)}:locked`);

/**
 * Until phases 6 and 8 exist, an account is funded the way the vault tests do it: the world node pays
 * an invoice of the gateway node, the ledger books the arrival, and the vault turns it into ecash.
 */
async function fund(phone: string, amountSat: number): Promise<void> {
  const inv = await gw.makeInvoice({ amountSat, memo: "test deposit" });
  expect((await world.pay({ bolt11: inv.bolt11, maxFeeSat: 20 })).status).toBe("succeeded");
  await post(db, systemClock, { kind: "ln.received", idemKey: `recv:${inv.paymentHash}`, postings: [{ account: "ext:lightning", delta: -amountSat }, { account: FLOAT_NODE, delta: amountSat }] });
  const op = await T.app.vault.mintFor({ idemKey: `mint:${inv.paymentHash}`, owner: `user:${await idOf(phone)}`, amountSat });
  expect(op.status).toBe("done");
}

async function expectConsistent(): Promise<void> {
  const a = await T.app.vault.auditAll();
  expect(a.mismatches).toEqual([]);
  expect(a.ledgerSat).toBe(a.proofsSat);
  expect((await verifyLedger(db)).problems).toEqual([]);
}

/** Start a fresh app on the same database (a restart), keeping the clock. */
function start(env: Record<string, string> = {}): TestApp {
  const t = testApp(db, { mint, ln: gw, clock: T?.clock, env: { MELAX_PEPPER: pepper, STEP_BUDGET_MS: "60000", AT_SECRET, ...env } });
  const push = t.logs.push.bind(t.logs);
  t.logs.push = (...lines: string[]) => {
    allLogs.push(...lines);
    return push(...lines);
  };
  return t;
}

/** Awa and Moussa with accounts, Awa holding `awaSats`. */
async function twoAccounts(awaSats: number): Promise<void> {
  await signUp(T.app, AWA, AWA_PIN, "Awa");
  await signUp(T.app, MOUSSA, MOUSSA_PIN, "Moussa");
  if (awaSats > 0) await fund(AWA, awaSats);
}

async function sendFlow(from: string, to: string, fcfa: number, pin: string) {
  const s = dial(T.app, from);
  await s.open();
  const confirm = await s.run("2", to.replace("+221", ""), String(fcfa));
  const pinPrompt = await s.type("1");
  const last = await s.type(pin);
  return { s, confirm, pinPrompt, last };
}

const movedNothing = async (awaBefore: number) => {
  expect(await sats(AWA)).toBe(awaBefore);
  expect(await lockedSats(AWA)).toBe(0);
  expect(await sats(MOUSSA)).toBe(0);
  expect(await db.query("SELECT 1 FROM txlog")).toHaveLength(0);
  expect(await db.query("SELECT 1 FROM ops WHERE kind = 'transfer'")).toHaveLength(0);
};

beforeAll(async () => {
  db = await newDb();
  mint = await MintClient.connect(MINT);
  gw = lnd("gw", 18081);
  world = lnd("world", 18082);
});
beforeEach(async () => {
  heal();
  await truncateAll(db);
  pepper = randomBytes(32).toString("hex");
  T = undefined as unknown as TestApp;
  T = start();
});
afterAll(async () => {
  heal();
  await gw?.close();
  await world?.close();
  await db?.close();
});

describe("a send between two phones", () => {
  it("moves real ecash, shows up in both histories, and texts both sides under one receipt number", async () => {
    await twoAccounts(20_000); // 8 000 F at the test rate
    const { confirm, pinPrompt, last } = await sendFlow(AWA, MOUSSA, 500, AWA_PIN);
    expect(confirm).toBe("Envoyer 500 F (1 250 sats) a Moussa (78*****33)?\n1 Confirmer\n2 Annuler");
    expect(pinPrompt).toBe("Code secret:");
    expect(last).toBe("Envoye: 500 F a Moussa.\nRecu no 1001\nSolde: 7 500 F");

    expect(await sats(AWA)).toBe(18_750);
    expect(await sats(MOUSSA)).toBe(1250);
    expect(await lockedSats(AWA)).toBe(0);

    const today = shortDate(T.clock.now());
    const awaHistory = dial(T.app, AWA);
    await awaHistory.open();
    expect(await awaHistory.run("8", AWA_PIN)).toBe(`${today} -500 F Moussa\n0 Menu`);
    const moussaHistory = dial(T.app, MOUSSA);
    await moussaHistory.open();
    expect(await moussaHistory.run("8", MOUSSA_PIN)).toBe(`${today} +500 F Awa\n0 Menu`);

    expect((await inbox(T.app, AWA)).at(-1)).toBe("Melax: envoye 500 F a Moussa. Solde: 7 500 F. Recu no 1001");
    expect((await inbox(T.app, MOUSSA)).at(-1)).toBe("Melax: recu 500 F de Awa. Solde: 500 F. Recu no 1001");
    await T.app.outbox.flush();
    expect(T.sms.sent.filter((m) => m.body.includes("Recu no 1001")).map((m) => m.to).sort()).toEqual([AWA, MOUSSA].sort());

    const balanceScreen = dial(T.app, MOUSSA);
    await balanceScreen.open();
    expect(await balanceScreen.run("1", MOUSSA_PIN)).toBe("Solde: 500 F\n(1 250 sats)\n1 BTC = 40 000 000 F\n0 Menu");

    await expectConsistent();
    expect(await T.app.vault.verifyHoldingsWithMint()).toMatchObject({ notUnspent: 0 });
  });

  it("the dial string #2580*2*781112233*500# lands on the confirm screen, and the code is still asked", async () => {
    await twoAccounts(20_000);
    const s = dial(T.app, AWA, ["2", "781112233", "500", "1", AWA_PIN]);
    expect(await s.open()).toBe("Code secret:"); // the queued code was dropped, not used
    expect(await sats(MOUSSA)).toBe(0);
    expect(await s.type(AWA_PIN)).toMatch(/^Envoye: 500 F a Moussa\./);
    expect(await sats(MOUSSA)).toBe(1250);
    await expectConsistent();
  });

  it("an unknown number and one's own number are refused before any amount is asked", async () => {
    await twoAccounts(20_000);
    const s = dial(T.app, AWA);
    await s.open();
    await s.type("2");
    expect(await s.type("761239876")).toBe("Ce numero n'a pas de compte Melax.\nNumero ou code de paiement:");
    expect(await s.type("771234567")).toBe("C'est votre propre numero.\nNumero ou code de paiement:");
    expect(await s.type("12345")).toBe("Numero ou code invalide.\nNumero ou code de paiement:");
    expect(await s.type("78 111 22 33")).toBe("Montant en FCFA:");
    await movedNothing(20_000);
  });
});

describe("refusals move nothing", () => {
  it("not enough balance", async () => {
    await twoAccounts(1250); // 500 F
    const s = dial(T.app, AWA);
    await s.open();
    expect(await s.run("2", "781112233", "600")).toBe("Solde insuffisant.\nSolde: 500 F\nMontant en FCFA:");
    await movedNothing(1250);
    // the whole balance, to the last sat, does go
    expect(await s.type("500")).toContain("Envoyer 500 F (1 250 sats)");
    await s.type("1");
    expect(await s.type(AWA_PIN)).toBe("Envoye: 500 F a Moussa.\nRecu no 1001\nSolde: 0 F");
    expect(await sats(AWA)).toBe(0);
    await expectConsistent();
  });

  it("above the per-operation limit, and above the cap on a first payment to someone new", async () => {
    await twoAccounts(100_000); // 40 000 F
    const s = dial(T.app, AWA);
    await s.open();
    expect(await s.run("2", "781112233", "30000")).toBe("Maximum par operation: 25 000 F.\nMontant en FCFA:");
    expect(await s.type("15000")).toBe("Premier envoi a ce numero: maximum 10 000 F.\nMontant en FCFA:");
    await movedNothing(100_000);
    expect(await s.type("10000")).toContain("Envoyer 10 000 F (25 000 sats)");
    await expectConsistent();
  });

  describe("the daily limit", () => {
    // 1 sat = 40 F here, so the 50 000 F daily limit of a new account is 1 250 sats of real ecash.
    beforeEach(() => {
      T = start({ RATE_FIXED_XOF_PER_BTC: "4000000000" });
    });

    it("counts what was sent today, refuses the rest, and opens again the next day", async () => {
      await twoAccounts(2000); // 80 000 F
      expect((await sendFlow(AWA, MOUSSA, 10_000, AWA_PIN)).last).toMatch(/^Envoye: 10 000 F/);
      expect((await sendFlow(AWA, MOUSSA, 25_000, AWA_PIN)).last).toMatch(/^Envoye: 25 000 F/);
      const s = dial(T.app, AWA);
      await s.open();
      expect(await s.run("2", "781112233", "20000")).toBe("Limite du jour atteinte. Reste: 15 000 F.\nMontant en FCFA:");
      // Awa hung up on the amount prompt. Dialling again offers to pick it up; she says no.
      const limits = dial(T.app, AWA);
      expect(await limits.open()).toBe("Reprendre ou vous en etiez?\n1 Oui\n2 Non");
      expect(await limits.run("2", "9", "5")).toBe("Niveau 0\nPar operation: 25 000 F\nReste aujourd'hui: 15 000 F\nReste ce mois: 165 000 F\n0 Menu");
      expect(await sats(MOUSSA)).toBe(875);

      T.clock.advance(24 * 60 * MINUTE);
      expect((await sendFlow(AWA, MOUSSA, 20_000, AWA_PIN)).last).toMatch(/^Envoye: 20 000 F/);
      await expectConsistent();
    });

    it("two sessions that both passed the check cannot both spend the same headroom", async () => {
      await twoAccounts(2000);
      await sendFlow(AWA, MOUSSA, 10_000, AWA_PIN);
      await sendFlow(AWA, MOUSSA, 25_000, AWA_PIN); // 15 000 F left today
      const a = dial(T.app, AWA);
      const b = dial(T.app, AWA);
      await a.open();
      await b.open();
      expect(await a.run("2", "781112233", "10000", "1")).toBe("Code secret:");
      expect(await b.run("2", "781112233", "10000", "1")).toBe("Code secret:");
      const [ra, rb] = await Promise.all([a.type(AWA_PIN), b.type(AWA_PIN)]);
      const results = [ra, rb].sort();
      expect(results[0]).toMatch(/^Envoye: 10 000 F a Moussa\./);
      expect(results[1]).toBe("Limite du jour atteinte. Reste: 5 000 F.");
      expect(await sats(MOUSSA)).toBe(875 + 250);
      expect(await db.query("SELECT 1 FROM txlog WHERE spend")).toHaveLength(3);
      await expectConsistent();
    });
  });
});

describe("the secret code on a send", () => {
  it("five wrong codes lock for 15 minutes, warn by SMS, move nothing, and the right code works after the lock", async () => {
    await twoAccounts(20_000);
    const s = dial(T.app, AWA);
    await s.open();
    await s.run("2", "781112233", "500", "1");
    const answers = [];
    for (let i = 0; i < 5; i++) answers.push(await s.type("00000"));
    expect(answers).toEqual([
      "Code faux. Essais restants: 4.\nCode secret:",
      "Code faux. Essais restants: 3.\nCode secret:",
      "Code faux. Essais restants: 2.\nCode secret:",
      "Code faux. Essais restants: 1.\nCode secret:",
      "Code bloque pendant 15 min.",
    ]);
    expect(s.ended).toBe(true);
    expect((await inbox(T.app, AWA)).at(-1)).toBe("Melax: 5 codes faux. Code bloque 15 min. Si ce n'est pas vous, gardez votre telephone pres de vous.");
    await movedNothing(20_000);

    // the right code inside the lock is refused too
    T.clock.advance(10 * MINUTE);
    expect((await sendFlow(AWA, MOUSSA, 500, AWA_PIN)).last).toBe("Code bloque pendant 5 min.");
    await movedNothing(20_000);

    T.clock.advance(5 * MINUTE + 1);
    expect((await sendFlow(AWA, MOUSSA, 500, AWA_PIN)).last).toMatch(/^Envoye: 500 F a Moussa\./);
    expect(await sats(MOUSSA)).toBe(1250);
    await expectConsistent();
  });

  it("someone else's code does not work on my account", async () => {
    await twoAccounts(20_000);
    expect((await sendFlow(AWA, MOUSSA, 500, MOUSSA_PIN)).last).toBe("Code faux. Essais restants: 4.\nCode secret:");
    await movedNothing(20_000);
  });

  it("a frozen account can read its balance but not send", async () => {
    await twoAccounts(20_000);
    await db.query("UPDATE users SET frozen_until = $1 WHERE id = $2", [T.clock.now() + 24 * 60 * MINUTE, await idOf(AWA)]);
    expect((await sendFlow(AWA, MOUSSA, 500, AWA_PIN)).last).toBe("Envois bloques 24 h apres le changement de code. Votre argent est en securite.");
    await movedNothing(20_000);
    const s = dial(T.app, AWA);
    await s.open();
    expect(await s.run("1", AWA_PIN)).toContain("Solde: 8 000 F");
  });
});

describe("once per session", () => {
  it("the same session cannot send twice; a second session can", async () => {
    await twoAccounts(20_000);
    const first = await sendFlow(AWA, MOUSSA, 500, AWA_PIN);
    expect(first.last).toContain("Recu no 1001");

    // The network replays the last request of the finished session: the runtime refuses it.
    expect(await first.s.type(AWA_PIN)).toBe("Session expiree. Recomposez #2580#.");
    // And if the same effect reached the wallet again, it would report the first send, not make a second.
    const awa = (await T.app.users.findByPhone(AWA))!;
    const again = await T.app.wallet.send({ user: awa, toRef: await idOf(MOUSSA), fcfa: 500, sats: 1250, pin: AWA_PIN, idemKey: `ussd:${first.s.sessionId}:send` });
    expect(again).toEqual({ ok: true, receipt: 1001, balanceFcfa: 7500 });
    expect(await sats(MOUSSA)).toBe(1250);
    expect(await db.query("SELECT 1 FROM txlog")).toHaveLength(2);
    expect((await inbox(T.app, MOUSSA)).filter((t) => t.includes("recu 500 F"))).toHaveLength(1);

    const second = await sendFlow(AWA, MOUSSA, 500, AWA_PIN);
    expect(second.last).toBe("Envoye: 500 F a Moussa.\nRecu no 1002\nSolde: 7 000 F");
    expect(await sats(MOUSSA)).toBe(2500);
    await expectConsistent();
  });
});

describe("when the mint does not answer", () => {
  it("unreachable: the session ends with 'in progress', the funds stay locked, recovery releases them and an SMS says it failed", async () => {
    await twoAccounts(20_000);
    fault("/v1/swap", "down");
    const { last } = await sendFlow(AWA, MOUSSA, 500, AWA_PIN);
    expect(last).toBe("Operation en cours. Vous recevrez un SMS.");
    expect(await lockedSats(AWA)).toBe(1250);
    expect(await sats(AWA)).toBe(18_750);
    expect(await sats(MOUSSA)).toBe(0);
    // a second send while the first is unresolved is refused, not queued
    expect((await sendFlow(AWA, MOUSSA, 500, AWA_PIN)).last).toBe("Une operation est deja en cours. Reessayez dans une minute.");
    await expectConsistent();

    heal();
    T = start(); // a restart: nothing in memory
    expect(await T.app.vault.recover()).toMatchObject({ checked: 1, failed: 1 });
    expect(await sats(AWA)).toBe(20_000);
    expect(await lockedSats(AWA)).toBe(0);
    expect(await db.query("SELECT 1 FROM txlog")).toHaveLength(0);
    expect((await inbox(T.app, AWA)).at(-1)).toBe("Melax: le paiement de 500 F n'est pas passe. Rien n'a ete debite.");
    expect((await inbox(T.app, MOUSSA)).some((t) => t.includes("500 F"))).toBe(false);

    expect((await sendFlow(AWA, MOUSSA, 500, AWA_PIN)).last).toMatch(/^Envoye: 500 F a Moussa\./);
    await expectConsistent();
    expect(await T.app.vault.verifyHoldingsWithMint()).toMatchObject({ notUnspent: 0 });
  }, 240_000);

  it("reply lost after the mint did the swap: recovery completes it once, and the receipts arrive by SMS", async () => {
    await twoAccounts(20_000);
    fault("/v1/swap", "lost-reply");
    const { last } = await sendFlow(AWA, MOUSSA, 500, AWA_PIN);
    expect(last).toBe("Operation en cours. Vous recevrez un SMS.");
    expect(await sats(MOUSSA)).toBe(0);
    expect(await db.query("SELECT 1 FROM txlog")).toHaveLength(0);

    heal();
    T = start();
    expect(await T.app.vault.recover()).toMatchObject({ checked: 1, done: 1 });
    expect(await T.app.vault.recover()).toMatchObject({ checked: 0 });
    expect(await sats(AWA)).toBe(18_750);
    expect(await sats(MOUSSA)).toBe(1250);
    expect(await lockedSats(AWA)).toBe(0);
    expect(await db.query("SELECT 1 FROM txlog")).toHaveLength(2);
    expect((await inbox(T.app, AWA)).at(-1)).toBe("Melax: envoye 500 F a Moussa. Solde: 7 500 F. Recu no 1001");
    expect((await inbox(T.app, MOUSSA)).at(-1)).toBe("Melax: recu 500 F de Awa. Solde: 500 F. Recu no 1001");
    await expectConsistent();
    expect(await T.app.vault.verifyHoldingsWithMint()).toMatchObject({ notUnspent: 0 });
  }, 240_000);
});

describe("over HTTP", () => {
  let http: FastifyInstance;
  const sim = async (sessionId: string, phone: string, input: string, dialString?: string) =>
    (await http.inject({ method: "POST", url: "/ussd/sim", headers: { "content-type": "application/json" }, payload: JSON.stringify({ sessionId, phone, input, dial: dialString }) })).json() as { message: string; continue: boolean };
  const at = async (sessionId: string, phone: string, text: string) =>
    (
      await http.inject({
        method: "POST",
        url: `/ussd/at/${AT_SECRET}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ sessionId, serviceCode: "*384*2580#", phoneNumber: phone, networkCode: "60801", text }).toString(),
      })
    ).body;

  it("the simulator route and the Africa's Talking route walk the same send", async () => {
    http = buildHttp(T.app);
    await twoAccounts(20_000);
    await signUp(T.app, FATOU, FATOU_PIN, "Fatou");

    // Awa pays Moussa through the web simulator
    const viaSim = [(await sim("h1", AWA, "", "#2580#")).message];
    for (const input of ["2", "781112233", "500", "1", AWA_PIN]) viaSim.push((await sim("h1", AWA, input)).message);

    // Awa pays Fatou through the aggregator route: the text grows with every step
    const steps = ["2", "761239876", "500", "1", AWA_PIN];
    const viaAt = [await at("h2", AWA, "")];
    for (let i = 1; i <= steps.length; i++) viaAt.push(await at("h2", AWA, steps.slice(0, i).join("*")));

    const strip = (lines: string[]) => lines.map((l) => l.replace(/^(CON|END) /, ""));
    const names = (lines: string[]) => lines.map((l) => l.replace("Moussa (78*****33)", "X").replace("Fatou (76*****76)", "X").replace(/a (Moussa|Fatou)\./, "a X.").replace(/Recu no \d+\nSolde: [\d ]+ F/, "Recu"));
    expect(names(strip(viaAt))).toEqual(names(viaSim));
    expect(viaAt.at(-1)).toBe("END Envoye: 500 F a Fatou.\nRecu no 1002\nSolde: 7 000 F");
    expect(viaAt.slice(0, -1).every((l) => l.startsWith("CON "))).toBe(true);
    expect(viaSim.at(-1)).toBe("Envoye: 500 F a Moussa.\nRecu no 1001\nSolde: 7 500 F");

    expect(await sats(MOUSSA)).toBe(1250);
    expect(await sats(FATOU)).toBe(1250);
    expect(await sats(AWA)).toBe(17_500);
    await expectConsistent();
  });
});

describe("what the logs hold", () => {
  it("after every test above: no phone number, secret code, name, invoice, token or voucher code", () => {
    const log = logWords(allLogs);
    expect(allLogs.length).toBeGreaterThan(60);
    for (const event of ["user.registered", "wallet.send.done", "wallet.send.pending", "pin.locked"]) expect(log.text, event).toContain(`"event":"${event}"`);
    for (const fragment of ["771234567", "781112233", "761239876", "+221", "lnbcrt", "cashuA", "cashuB", AT_SECRET]) expect(log.text, fragment).not.toContain(fragment);
    for (const word of [AWA_PIN, MOUSSA_PIN, FATOU_PIN, "00000", "Awa", "Moussa", "Fatou"]) expect(log.words.has(word), word).toBe(false);
    expect(log.text).not.toMatch(/[A-HJKMNP-TV-Z2-9]{4}(-[A-HJKMNP-TV-Z2-9]{4}){3}/);
  });
});
