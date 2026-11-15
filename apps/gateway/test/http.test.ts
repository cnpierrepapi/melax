// The HTTP surface on an in-process database: which routes exist, who may call them, and what a
// caller learns from a refusal. The mint and the Lightning node are never reached here; flows that move
// money over HTTP are in wallet.itest.ts.
import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Db, truncateAll } from "@melax/ledger";
import { buildHttp } from "../src/http.ts";
import { type TestApp, inbox, logWords, newDb, signUp, testApp } from "./helpers.ts";

const AWA = "+221771234567";
const PIN = "48291";
const AT_SECRET = "at-" + "s".repeat(30);
const HTTP_SECRET = "generic-" + "h".repeat(24);
const ASG_KEY = "asg-signing-key-0001";
const HTTPSMS_KEY = "httpsms-signing-key-01";
const AT_IP = "196.201.214.200";
const ALL = { AT_SECRET, AT_ALLOW_IPS: AT_IP, AT_SERVICE_CODE: "*384*2580#", USSD_HTTP_SECRET: HTTP_SECRET, ASG_SIGNING_KEY: ASG_KEY, HTTPSMS_SIGNING_KEY: HTTPSMS_KEY };

let db: Db;
let T: TestApp;
let http: FastifyInstance;

beforeAll(async () => {
  db = await newDb();
});
beforeEach(async () => {
  await truncateAll(db);
  T = testApp(db, { env: ALL });
  http = buildHttp(T.app);
});
afterAll(async () => {
  await db?.close();
});

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const at = (text: string, sessionId = "ATUid_1", opts: { secret?: string; ip?: string; phone?: string } = {}) =>
  http.inject({
    method: "POST",
    url: `/ussd/at/${opts.secret ?? AT_SECRET}`,
    remoteAddress: opts.ip ?? AT_IP,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: form({ sessionId, serviceCode: "*384*2580#", phoneNumber: opts.phone ?? AWA, networkCode: "60801", text }),
  });
const sim = (body: Record<string, unknown>, server = http) => server.inject({ method: "POST", url: "/ussd/sim", headers: { "content-type": "application/json" }, payload: JSON.stringify(body) });

// android-sms-gateway webhook, shape from its documentation (see packages/sms/test/sms.test.ts).
function asg(text: string, from = AWA, messageId = "m-" + Math.random().toString(36).slice(2), opts: { key?: string; ts?: number } = {}) {
  const body = JSON.stringify({ deviceId: "d", event: "sms:received", id: "e1", payload: { messageId, message: text, phoneNumber: from, simNumber: 1, receivedAt: "2026-11-15T10:00:00.000+00:00" }, webhookId: "w" });
  const ts = String(opts.ts ?? Math.floor(T.clock.now() / 1000));
  const signature = createHmac("sha256", opts.key ?? ASG_KEY).update(body + ts).digest("hex");
  return http.inject({ method: "POST", url: "/sms/asg", headers: { "content-type": "application/json", "x-signature": signature, "x-timestamp": ts }, payload: body });
}

describe("health and unknown paths", () => {
  it("answers on /healthz and says nothing useful anywhere else", async () => {
    expect((await http.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ ok: true });
    const miss = await http.inject({ method: "GET", url: "/admin" });
    expect(miss.statusCode).toBe(404);
    expect(miss.json()).toEqual({ error: "not_found" });
  });

  it("refuses a body over 16 KB", async () => {
    const big = await sim({ sessionId: "s", phone: AWA, input: "x".repeat(20_000) });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toEqual({ error: "too_large" });
  });

  it("a malformed request gets a short word back, not a stack or an echo", async () => {
    const bad = await http.inject({ method: "POST", url: "/ussd/sim", headers: { "content-type": "application/json" }, payload: "{not json <script>" });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toBe('{"error":"bad_request"}');
    const noPhone = await sim({ sessionId: "s", phone: "abc", input: "" });
    expect(noPhone.statusCode).toBe(400);
    expect(noPhone.body).toBe('{"error":"bad_request"}');
  });
});

describe("the web simulator route", () => {
  it("opens an account and reads a balance of zero, dial string included", async () => {
    const first = await sim({ sessionId: "w1", phone: "771234567", input: "", dial: "#2580#" });
    expect(first.json()).toEqual({ message: "Melax\n1 Francais\n2 Wolof\n3 English", continue: true });
    for (const input of ["1", PIN, PIN]) await sim({ sessionId: "w1", phone: "771234567", input });
    const done = (await sim({ sessionId: "w1", phone: "771234567", input: "Awa" })).json() as { message: string; continue: boolean };
    expect(done.message).toMatch(/^Compte cree\.\nVotre adresse: [a-z]+-[a-z]+\d\d@melax\.sn\nComposez #2580# pour l'utiliser\.$/);
    expect(done.continue).toBe(false);

    const bal = await sim({ sessionId: "w2", phone: AWA, input: "", dial: "#2580*1#" });
    expect(bal.json()).toEqual({ message: "Code secret:", continue: true });
    expect((await sim({ sessionId: "w2", phone: AWA, input: PIN })).json()).toEqual({ message: "Solde: 0 F\n(0 sats)\n1 BTC = 40 000 000 F\n0 Menu", continue: true });
  });

  it("does not exist outside demo mode", async () => {
    const live = buildHttp(testApp(db, { env: { MELAX_DEMO: "0", SMS_ADAPTER: "asg", ASG_URL: "http://x", ASG_USER: "u", ASG_PASSWORD: "p" } }).app);
    expect((await sim({ sessionId: "w3", phone: AWA, input: "" }, live)).statusCode).toBe(404);
    for (const url of ["/ussd/at/" + AT_SECRET, "/ussd/http", "/sms/asg", "/sms/httpsms"]) {
      expect((await live.inject({ method: "POST", url, payload: "x" })).statusCode, url).toBe(404);
    }
  });
});

describe("the Africa's Talking route", () => {
  it("speaks CON and END over the cumulative text", async () => {
    const r1 = await at("");
    expect(r1.headers["content-type"]).toMatch(/^text\/plain/);
    expect(r1.body).toBe("CON Melax\n1 Francais\n2 Wolof\n3 English");
    expect((await at("1")).body).toMatch(/^CON Bienvenue sur Melax/);
    expect((await at(`1*${PIN}`)).body).toBe("CON Retapez le code secret:");
    expect((await at(`1*${PIN}*${PIN}`)).body).toMatch(/^CON Votre prenom/);
    expect((await at(`1*${PIN}*${PIN}*Awa`)).body).toMatch(/^END Compte cree\./);
    expect(await T.app.users.findByPhone(AWA)).toMatchObject({ name: "Awa", lang: "fr" });
  });

  it("a wrong secret looks exactly like a path that does not exist", async () => {
    const wrong = await at("", "x1", { secret: "at-" + "t".repeat(30) });
    const missing = await http.inject({ method: "POST", url: "/ussd/nothing", payload: "x" });
    expect(wrong.statusCode).toBe(404);
    expect(wrong.body).toBe(missing.body);
    expect(await T.app.users.findByPhone(AWA)).toBeNull();
  });

  it("the right secret from an address that is not on the list is refused", async () => {
    const r = await at("", "x2", { ip: "203.0.113.9" });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "forbidden" });
  });

  it("refuses another service code and a number that is not one", async () => {
    const other = await http.inject({ method: "POST", url: `/ussd/at/${AT_SECRET}`, remoteAddress: AT_IP, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: form({ sessionId: "x3", serviceCode: "*999#", phoneNumber: AWA, text: "" }) });
    expect(other.statusCode).toBe(403);
    expect((await at("", "x4", { phone: "abc" })).statusCode).toBe(400);
  });
});

describe("the signed JSON route", () => {
  const signed = (body: string, ts: string, secret = HTTP_SECRET) =>
    http.inject({ method: "POST", url: "/ussd/http", headers: { "content-type": "application/json", "x-signature": createHmac("sha256", secret).update(ts + "." + body).digest("hex"), "x-timestamp": ts }, payload: body });

  it("answers a signed request and refuses an unsigned, mis-signed or stale one", async () => {
    const ts = String(Math.floor(T.clock.now() / 1000));
    const body = JSON.stringify({ sessionId: "g1", msisdn: "221771234567", input: "", newSession: true });
    expect((await signed(body, ts)).json()).toEqual({ message: "Melax\n1 Francais\n2 Wolof\n3 English", continue: true });
    expect((await signed(body, ts, "another-secret-of-24-chars!!")).statusCode).toBe(403);
    expect((await http.inject({ method: "POST", url: "/ussd/http", headers: { "content-type": "application/json" }, payload: body })).statusCode).toBe(403);
    const old = String(Math.floor(T.clock.now() / 1000) - 400);
    expect((await signed(body, old)).statusCode).toBe(403);
  });
});

describe("incoming SMS", () => {
  it("SOLDE from a registered number is answered with the balance, to that number", async () => {
    await signUp(T.app, AWA, PIN, "Awa");
    const r = await asg("solde");
    expect(r.statusCode).toBe(200);
    expect((await inbox(T.app, AWA)).at(-1)).toBe("Melax: solde 0 F (0 sats).");
  });

  it("a bad signature or a stale timestamp is refused and nothing is sent", async () => {
    await signUp(T.app, AWA, PIN, "Awa");
    const before = (await inbox(T.app, AWA)).length;
    expect((await asg("SOLDE", AWA, "m1", { key: "some-other-signing-key" })).statusCode).toBe(403);
    expect((await asg("SOLDE", AWA, "m2", { ts: Math.floor(T.clock.now() / 1000) - 400 })).statusCode).toBe(403);
    expect(await inbox(T.app, AWA)).toHaveLength(before);
  });

  it("a number with no account gets no answer, so the server cannot be used to text strangers", async () => {
    expect((await asg("SOLDE", "+221781112233")).statusCode).toBe(200);
    expect((await asg("AIDE", "not-a-number")).statusCode).toBe(200);
    expect(await db.query("SELECT 1 FROM sms_outbox")).toHaveLength(0);
  });

  it("no text message can send money: anything that is not a known command gets the help text", async () => {
    await signUp(T.app, AWA, PIN, "Awa");
    for (const text of ["ENVOYER 5000 781112233", "SEND 5000 781112233 48291", "PAY 12345 500", "RETRAIT 5000", "2*781112233*5000*1*48291"]) await asg(text);
    const texts = (await inbox(T.app, AWA)).slice(1);
    expect(texts).toHaveLength(5);
    for (const text of texts) expect(text).toBe("Melax: composez #2580#. Par SMS: SOLDE, BON <code>, ARNAQUE <message>. Ne donnez jamais votre code secret.");
    expect(await db.query("SELECT 1 FROM ops")).toHaveLength(0);
    expect(await db.query("SELECT 1 FROM journal")).toHaveLength(0);
  });

  it("the same message delivered twice is answered once, and a flood stops at five answers", async () => {
    await signUp(T.app, AWA, PIN, "Awa");
    await asg("SOLDE", AWA, "dup-1");
    await asg("SOLDE", AWA, "dup-1");
    expect((await inbox(T.app, AWA)).filter((t) => t.startsWith("Melax: solde"))).toHaveLength(1);
    for (let i = 0; i < 12; i++) await asg("SOLDE", AWA, "flood-" + i);
    expect((await inbox(T.app, AWA)).filter((t) => t.startsWith("Melax: solde"))).toHaveLength(5);
    T.clock.advance(11 * 60_000);
    await asg("SOLDE", AWA, "later");
    expect((await inbox(T.app, AWA)).filter((t) => t.startsWith("Melax: solde"))).toHaveLength(6);
  });

  it("httpSMS: a webhook signed with our key is handled, another key is refused", async () => {
    await signUp(T.app, AWA, PIN, "Awa");
    // CloudEvent shape from docs.httpsms.com (see packages/sms/test/sms.test.ts).
    const event = JSON.stringify({ data: { contact: AWA, content: "AIDE", message_id: "0b0123bb-ef2e-468f-908a-c026d51636aa", owner: "+221780000000", sim: "SIM1", timestamp: "2026-11-15T10:00:00.000Z", user_id: "u" }, datacontenttype: "application/json", id: "f4aed1d3", source: "/v1/messages/receive", specversion: "1.0", time: "2026-11-15T10:00:00.000Z", type: "message.phone.received" });
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const jwt = (key: string) => {
      const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ exp: Math.floor(T.clock.now() / 1000) + 60 })}`;
      return `${head}.${createHmac("sha256", key).update(head).digest("base64url")}`;
    };
    const post = (key: string) => http.inject({ method: "POST", url: "/sms/httpsms", headers: { "content-type": "application/json", authorization: "Bearer " + jwt(key) }, payload: event });
    expect((await post("not-our-signing-key-at-all")).statusCode).toBe(403);
    expect((await post(HTTPSMS_KEY)).statusCode).toBe(200);
    expect((await inbox(T.app, AWA)).at(-1)).toMatch(/^Melax: composez #2580#/);
  });
});

describe("the request log", () => {
  it("holds the route pattern and the status, and no secret path, number, code or name", async () => {
    await at("");
    for (const text of ["1", `1*${PIN}`, `1*${PIN}*${PIN}`, `1*${PIN}*${PIN}*Awa`]) await at(text);
    await asg("SOLDE");
    const log = logWords(T.logs);
    expect(log.text).toContain('"route":"/ussd/at/:secret"');
    for (const secret of [AT_SECRET, "771234567", "+221", ASG_KEY]) expect(log.text, secret).not.toContain(secret);
    for (const word of [PIN, "Awa"]) expect(log.words.has(word), word).toBe(false);
  });
});
