// The demo surface on an in-process database: the /sim routes the web simulator reads, the top-up
// route's refusals, the static pages, and the seed. The mint and the Lightning nodes are never reached
// here: any use of them fails the test. Top-ups with real sats are in demo.itest.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "@melax/core";
import type { MintClient } from "@melax/cashu";
import { type Db, post, truncateAll } from "@melax/ledger";
import type { Capabilities, InvoiceStatus, LightningBackend } from "@melax/lightning";
import { loadConfig } from "../src/config.ts";
import { DEMO_PEOPLE, DEMO_PIN, FUND_CAP_FCFA, regtestWorld, seedDemo } from "../src/demo.ts";
import { buildHttp } from "../src/http.ts";
import { loadStatic } from "../src/static.ts";
import { type TestApp, inbox, newDb, signUp, testApp, untouchable } from "./helpers.ts";

const AWA = "+221771234567";
const MOUSSA = "+221781112233";
const PIN = "48291";
const LIVE = { MELAX_DEMO: "0", SMS_ADAPTER: "asg", ASG_URL: "http://x", ASG_USER: "u", ASG_PASSWORD: "p" };

/** Enough of a mint for /sim/state to name it. Anything else is a test failure. */
const namedMint = new Proxy({} as MintClient, {
  get(_t, prop) {
    if (prop === "name") return "Test mint";
    if (prop === "keysetId") return "00a1b2c3d4e5f607";
    throw new Error(`this unit test touched the mint (${String(prop)})`);
  },
});

let db: Db;
let T: TestApp;
let http: FastifyInstance;
let webDir: string;

beforeAll(async () => {
  db = await newDb();
  webDir = mkdtempSync(join(tmpdir(), "melax-web-"));
  mkdirSync(join(webDir, "assets"));
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Melax</title><p>landing</p>");
  writeFileSync(join(webDir, "demo.html"), "<!doctype html><title>Melax demo</title><p>demo</p>");
  writeFileSync(join(webDir, "assets", "demo-abc123.js"), "console.log('demo');".repeat(40));
  writeFileSync(join(webDir, "assets", "style-abc123.css"), "body{margin:0}");
  writeFileSync(join(webDir, "assets", "mark.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(webDir, ".env"), "SECRET=1");
  writeFileSync(join(webDir, "notes.exe"), "MZ");
});
beforeEach(async () => {
  await truncateAll(db);
  T = testApp(db, { mint: namedMint, world: untouchable<LightningBackend>("the world node") });
  http = buildHttp(T.app, { web: loadStatic(webDir) });
});
afterAll(async () => {
  await db?.close();
  rmSync(webDir, { recursive: true, force: true });
});

const get = (url: string, server = http, headers: Record<string, string> = {}) => server.inject({ method: "GET", url, headers });
const fund = (body: unknown, server = http) => server.inject({ method: "POST", url: "/sim/fund", headers: { "content-type": "application/json" }, payload: typeof body === "string" ? body : JSON.stringify(body) });
const idOf = async (phone: string) => (await T.app.users.findByPhone(phone))!.id;

describe("outside demo mode", () => {
  it("none of the demo routes or pages exist", async () => {
    const live = buildHttp(testApp(db, { env: LIVE, world: untouchable<LightningBackend>("the world node") }).app, { web: loadStatic(webDir) });
    for (const url of ["/sim/sms?phone=771234567", "/sim/people", "/sim/state", "/", "/demo", "/assets/style-abc123.css"]) {
      const r = await get(url, live);
      expect(r.statusCode, url).toBe(404);
      expect(r.json(), url).toEqual({ error: "not_found" });
    }
    expect((await fund({ phone: AWA, fcfa: 1000 }, live)).statusCode).toBe(404);
  });
});

describe("/sim/sms", () => {
  it("returns one number's messages, oldest first, and nobody else's", async () => {
    await signUp(T.app, AWA, PIN, "Awa");
    await signUp(T.app, MOUSSA, PIN, "Moussa");
    await db.tx((tx) => T.app.outbox.queue(tx, { to: AWA, body: "Melax: recu 500 F de Moussa.", kind: "received" }));
    const r = await get("/sim/sms?phone=771234567");
    expect(r.statusCode).toBe(200);
    const body = r.json() as { messages: Array<{ id: number; kind: string; text: string; at: number }> };
    expect(body.messages.map((m) => m.kind)).toEqual(["welcome", "received"]);
    expect(body.messages[1]).toMatchObject({ text: "Melax: recu 500 F de Moussa." });
    expect(Object.keys(body.messages[0]!).sort()).toEqual(["at", "id", "kind", "text"]);
    const other = (await get("/sim/sms?phone=%2B221781112233")).json() as { messages: Array<{ kind: string }> };
    expect(other.messages.map((m) => m.kind)).toEqual(["welcome"]);
    expect(((await get("/sim/sms?phone=761239876")).json() as { messages: unknown[] }).messages).toEqual([]);
  });

  it("refuses a number that is not one", async () => {
    for (const url of ["/sim/sms", "/sim/sms?phone=abc", "/sim/sms?phone=12"]) {
      const r = await get(url);
      expect(r.statusCode, url).toBe(400);
      expect(r.json()).toEqual({ error: "bad_request" });
    }
  });
});

describe("the seed and /sim/people", () => {
  it("before the seed the list is empty; after it, six first names with their numbers and the shared code", async () => {
    const before = (await get("/sim/people")).json() as { people: unknown[] };
    expect(before.people).toEqual([]);

    T = testApp(db, { mint: namedMint }); // no world node: the seed opens the accounts and stops there
    http = buildHttp(T.app);
    expect(await seedDemo(T.app)).toEqual({ seeded: true, funded: false });
    const r = (await get("/sim/people")).json() as { code: string; ussd: string; topUp: { on: boolean; capFcfa: number }; people: Array<{ name: string; phone: string; lang: string }> };
    expect(r.code).toBe(DEMO_PIN);
    expect(r.ussd).toBe("#2580#");
    expect(r.topUp).toEqual({ on: false, capFcfa: FUND_CAP_FCFA });
    // the two agents at the end of DEMO_PEOPLE are seeded by seedAgents, which needs the world node
    expect(r.people.map((p) => p.name)).toEqual(DEMO_PEOPLE.filter((p) => !p.agent).map((p) => p.name));
    expect(r.people).toHaveLength(6);
    for (const p of r.people) expect(p.phone).toMatch(/^7[05678]\d{7}$/);
  });

  it("run twice it leaves the same six accounts, and it does nothing on a database that already has a user", async () => {
    T = testApp(db, { mint: namedMint });
    await seedDemo(T.app);
    const ids = (await db.query<{ id: string }>("SELECT id FROM users ORDER BY id")).map((r) => r.id);
    expect(ids).toHaveLength(6);
    expect(await seedDemo(T.app)).toEqual({ seeded: false, funded: false });
    expect((await db.query<{ id: string }>("SELECT id FROM users ORDER BY id")).map((r) => r.id)).toEqual(ids);

    await truncateAll(db);
    await signUp(T.app, AWA, PIN, "Awa");
    expect(await seedDemo(T.app)).toEqual({ seeded: false, funded: false });
    expect(await db.query("SELECT 1 FROM users")).toHaveLength(1);
  });

  it("the shared code opens a seeded account, and it is not a code the wallet would call weak", async () => {
    T = testApp(db, { mint: namedMint });
    await seedDemo(T.app);
    const awa = (await T.app.users.findByPhone(DEMO_PEOPLE[0]!.phone))!;
    expect(await T.app.users.checkPin(awa.id, DEMO_PIN, "view")).toEqual({ ok: true });
    expect((await inbox(T.app, DEMO_PEOPLE[0]!.phone))[0]).toMatch(/^Melax: compte cree\./);
  });
});

describe("/sim/state", () => {
  it("shows the last ledger entries with first names, the totals, the mint and the rate, and nothing private", async () => {
    await signUp(T.app, AWA, PIN, "Awa");
    await signUp(T.app, MOUSSA, PIN, "Moussa");
    const awa = await idOf(AWA);
    const moussa = await idOf(MOUSSA);
    await post(db, T.clock, { kind: "ln.received", idemKey: "recv:" + "ab".repeat(32), postings: [{ account: "ext:lightning", delta: -2500 }, { account: "float:node", delta: 2500 }] });
    await post(db, T.clock, { kind: "vault.mint", idemKey: "op_1:settle", meta: { op: "op_1" }, postings: [{ account: "float:node", delta: -2500 }, { account: `user:${awa}:spendable`, delta: 2500 }] });
    await post(db, T.clock, { kind: "vault.transfer", idemKey: "op_2:settle", meta: { op: "op_2" }, postings: [{ account: `user:${awa}:spendable`, delta: -1250 }, { account: `user:${moussa}:spendable`, delta: 1250 }] });

    const r = await get("/sim/state");
    expect(r.statusCode).toBe(200);
    const s = r.json() as {
      entries: Array<{ seq: number; at: number; kind: string; hash: string; lines: Array<{ account: string; sats: number }> }>;
      totals: { ledgerSat: number; ecashSat: number; match: boolean };
      mint: { name: string; keyset: string };
      rate: { xofPerBtc: number; source: string };
    };
    expect(Object.keys(s).sort()).toEqual(["entries", "mint", "rate", "totals"]);
    expect(s.entries.map((e) => e.kind)).toEqual(["vault.transfer", "vault.mint", "ln.received"]); // newest first
    expect(Object.keys(s.entries[0]!).sort()).toEqual(["at", "hash", "kind", "lines", "seq"]);
    expect(s.entries[0]!.lines).toEqual([
      { account: "Awa:spendable", sats: -1250 },
      { account: "Moussa:spendable", sats: 1250 },
    ]);
    expect(s.entries[0]!.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(s.totals).toEqual({ ledgerSat: 0, ecashSat: 0, match: true }); // no ecash is held in this unit test
    expect(s.mint).toEqual({ name: "Test mint", keyset: "00a1b2c3d4e5f607" });
    expect(s.rate).toEqual({ xofPerBtc: 40_000_000, source: "fixed" });

    for (const fragment of ["771234567", "781112233", "+221", awa, moussa, "idem", "recv:", "op_1", "sealed", "pin", "hmac", "salt", "secret"]) expect(r.body, fragment).not.toContain(fragment);
  });

  it("returns at most twenty entries", async () => {
    for (let i = 0; i < 25; i++) await post(db, T.clock, { kind: "ln.received", idemKey: `recv:${i}`, postings: [{ account: "ext:lightning", delta: -10 }, { account: "float:node", delta: 10 }] });
    const s = (await get("/sim/state")).json() as { entries: Array<{ seq: number }> };
    expect(s.entries).toHaveLength(20);
    expect(s.entries[0]!.seq).toBe(25);
  });
});

describe("/sim/fund", () => {
  it("is not mounted when no world node is configured", async () => {
    const noWorld = buildHttp(testApp(db, { mint: namedMint }).app);
    await signUp(T.app, AWA, PIN, "Awa");
    expect((await fund({ phone: AWA, fcfa: 1000 }, noWorld)).statusCode).toBe(404);
    expect(((await get("/sim/people", noWorld)).json() as { topUp: { on: boolean } }).topUp.on).toBe(false);
    expect(((await get("/sim/people")).json() as { topUp: { on: boolean } }).topUp.on).toBe(true);
  });

  it("refuses an amount above the cap, below the floor, or that is not a whole number, before touching any node", async () => {
    await signUp(T.app, AWA, PIN, "Awa");
    for (const fcfa of [FUND_CAP_FCFA + 1, 1_000_000, 0, -500, 99, 1000.5, "1000", null, undefined, Number.NaN]) {
      const r = await fund({ phone: AWA, fcfa });
      expect(r.statusCode, String(fcfa)).toBe(400);
      expect(r.json()).toEqual({ error: "bad_request" });
    }
    expect((await fund("{not json")).statusCode).toBe(400);
    expect(await db.query("SELECT 1 FROM journal")).toHaveLength(0);
  });

  it("refuses a malformed number and a number with no account", async () => {
    expect((await fund({ phone: "abc", fcfa: 1000 })).statusCode).toBe(400);
    expect((await fund({ fcfa: 1000 })).statusCode).toBe(400);
    const stranger = await fund({ phone: "761239876", fcfa: 1000 });
    expect(stranger.statusCode).toBe(404);
    expect(stranger.json()).toEqual({ error: "not_found" });
    expect(await db.query("SELECT 1 FROM journal")).toHaveLength(0);
  });
});

describe("a deposit is only credited for an invoice the gateway's own node says is settled", () => {
  const nodeSaying = (status: InvoiceStatus | null) =>
    new Proxy({} as LightningBackend, {
      get(_t, prop) {
        if (prop === "lookupInvoice") return async () => status;
        throw new Error(`this unit test touched the Lightning node (${String(prop)})`);
      },
    });
  const hash = "cd".repeat(32);

  it("unknown, open, held and cancelled invoices credit nothing", async () => {
    for (const status of [null, { paymentHash: hash, state: "open", amountSat: 2500 }, { paymentHash: hash, state: "accepted", amountSat: 2500 }, { paymentHash: hash, state: "cancelled", amountSat: 2500 }] as Array<InvoiceStatus | null>) {
      const t = testApp(db, { ln: nodeSaying(status) });
      await truncateAll(db);
      await signUp(t.app, AWA, PIN, "Awa");
      const awa = (await t.app.users.findByPhone(AWA))!;
      expect(await t.app.wallet.deposit({ userId: awa.id, paymentHash: hash }), status?.state ?? "unknown").toEqual({ ok: false, err: "NOT_PAID" });
      expect(await db.query("SELECT 1 FROM journal")).toHaveLength(0);
      expect(await db.query("SELECT 1 FROM ops")).toHaveLength(0);
    }
  });

  it("a user that does not exist, or a hash that is not one, is refused before the node is asked", async () => {
    const t = testApp(db);
    expect(await t.app.wallet.deposit({ userId: "u_nobody", paymentHash: hash })).toEqual({ ok: false, err: "NOT_FOUND" });
    await signUp(t.app, AWA, PIN, "Awa");
    const awa = (await t.app.users.findByPhone(AWA))!;
    expect(await t.app.wallet.deposit({ userId: awa.id, paymentHash: "not-a-hash" })).toEqual({ ok: false, err: "NOT_PAID" });
  });
});

describe("the world node is only used on regtest", () => {
  const log = createLogger({ sink: () => undefined });
  const node = (network: string): LightningBackend =>
    new Proxy({} as LightningBackend, {
      get(_t, prop) {
        if (prop === "capabilities") return async (): Promise<Capabilities> => ({ backend: "lnd", holdInvoices: true, network, pubkey: "02" + "ab".repeat(32), alias: network });
        if (prop === "close") return async () => undefined;
        if (prop === "then") return undefined; // an async function returning this object looks for a `then`
        throw new Error(`touched ${String(prop)}`);
      },
    });
  const worldEnv = { DEMO_WORLD_LND_REST_URL: "https://lnd-world:8080", DEMO_WORLD_LND_MACAROON_PATH: "/keys/world/admin.macaroon", DEMO_WORLD_LND_TLS_CERT_PATH: "/keys/world/tls.cert" };
  const cfg = (env: Record<string, string>) => loadConfig({ MELAX_PEPPER: "ab".repeat(32), MELAX_DEMO: "1", ...env });

  it("no credentials, no world node", async () => {
    expect(await regtestWorld({ config: cfg({}), ln: node("regtest"), log, open: () => node("regtest") })).toBeUndefined();
  });

  it("both nodes on regtest: the world node is handed over", async () => {
    const world = node("regtest");
    expect(await regtestWorld({ config: cfg(worldEnv), ln: node("regtest"), log, open: () => world })).toBe(world);
  });

  it("the gateway's node, or the world node, on any other network: no top-up", async () => {
    for (const [gw, world] of [["bitcoin", "regtest"], ["testnet", "regtest"], ["signet", "regtest"], ["regtest", "bitcoin"], ["unknown", "regtest"]] as const) {
      expect(await regtestWorld({ config: cfg(worldEnv), ln: node(gw), log, open: () => node(world) }), `${gw}/${world}`).toBeUndefined();
    }
  });

  it("credentials that cannot be read do not stop the server", async () => {
    expect(
      await regtestWorld({
        config: cfg(worldEnv),
        ln: node("regtest"),
        log,
        open: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toBeUndefined();
  });
});

describe("the pages", () => {
  it("serves the landing page at / and the simulator at /demo, with headers that keep scripts to our own", async () => {
    const home = await get("/");
    expect(home.statusCode).toBe(200);
    expect(home.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(home.body).toContain("landing");
    expect(home.headers["cache-control"]).toBe("no-cache");
    expect(home.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(home.headers["content-security-policy"])).toContain("default-src 'self'");
    expect(String(home.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
    const demo = await get("/demo");
    expect(demo.statusCode).toBe(200);
    expect(demo.body).toContain("<p>demo</p>");
    expect((await get("/demo?lang=wo")).statusCode).toBe(200);
  });

  it("serves assets with their type, cached for long because their names carry a hash", async () => {
    const css = await get("/assets/style-abc123.css");
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(css.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect((await get("/assets/demo-abc123.js")).headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect((await get("/assets/mark.svg")).headers["content-type"]).toBe("image/svg+xml");
  });

  it("sends gzip to a browser that asks for it, and the same bytes either way", async () => {
    const plain = await get("/assets/demo-abc123.js");
    expect(plain.headers["content-encoding"]).toBeUndefined();
    const zipped = await get("/assets/demo-abc123.js", http, { "accept-encoding": "gzip, br" });
    expect(zipped.headers["content-encoding"]).toBe("gzip");
    expect(zipped.headers.vary).toBe("accept-encoding");
    expect(zipped.rawPayload.length).toBeLessThan(plain.rawPayload.length);
    expect(gunzipSync(zipped.rawPayload).toString("utf8")).toBe(plain.body);
  });

  it("answers 404 for anything that is not a file it loaded: dots, encoded dots, absolute paths, hidden files", async () => {
    const urls = [
      "/../package.json",
      "/assets/../../package.json",
      "/%2e%2e/%2e%2e/package.json",
      "/assets/%2e%2e%2f%2e%2e%2fpackage.json",
      "/assets/..%2f..%2fpackage.json",
      "/..%5c..%5cpackage.json",
      "//etc/passwd",
      "/C:/Windows/win.ini",
      "/assets/C:%5cWindows%5cwin.ini",
      "/.env",
      "/notes.exe",
      "/assets",
      "/assets/",
      "/index.htm",
      "/demo/",
    ];
    for (const url of urls) {
      const r = await get(url);
      expect(r.statusCode, url).toBe(404);
      expect(r.body, url).toBe('{"error":"not_found"}');
    }
  });

  it("a folder that does not exist gives no pages and no error", async () => {
    const none = loadStatic(join(webDir, "nowhere"));
    expect(none.size).toBe(0);
    const bare = buildHttp(T.app, { web: none });
    expect((await get("/", bare)).statusCode).toBe(404);
    expect((await get("/sim/people", bare)).statusCode).toBe(200);
  });
});
