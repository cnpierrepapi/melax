import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppError } from "@melax/core";
import { AndroidSmsGateway, HttpSms, MemorySms, assertGsm7, gsm7Septets, isGsm7, parseAsgWebhook, parseCommand, parseHttpSmsWebhook, smsSegments, toGsm7 } from "../src/index.ts";

describe("GSM-7", () => {
  it("knows which French and Wolof letters fit and which do not", () => {
    for (const ok of ["Solde: 1 250 F", "Reçu".replace("ç", "c"), "é è à ù ì ò Ç É Ñ ñ ü ö ä", "@ £ $ ¥ _ ! # % & ( ) * + , - . / : ; < = > ?", "Ça va"]) expect(isGsm7(ok), ok).toBe(true);
    for (const bad of ["Dépôt", "reçu", "ê", "ô", "â", "î", "û", "ë", "œ", "ŋ", "ó", "—", "’", "≈", "😀", "\t"]) expect(isGsm7(bad), bad).toBe(false);
  });
  it("counts the extension characters as two septets", () => {
    expect(gsm7Septets("abc")).toBe(3);
    expect(gsm7Septets("[1]")).toBe(5);
    expect(gsm7Septets("€")).toBe(2);
  });
  it("splits at 160, then 153 per part", () => {
    expect(smsSegments("a".repeat(160))).toBe(1);
    expect(smsSegments("a".repeat(161))).toBe(2);
    expect(smsSegments("a".repeat(306))).toBe(2);
    expect(smsSegments("a".repeat(307))).toBe(3);
    expect(smsSegments("")).toBe(1);
  });
  it("assertGsm7 names the offending characters instead of silently switching alphabet", () => {
    expect(() => assertGsm7("Dépôt reçu")).toThrow(AppError);
    try {
      assertGsm7("Dépôt reçu");
    } catch (e) {
      expect((e as AppError).data.bad).toEqual(["ô", "ç"]);
    }
    expect(assertGsm7("Depot recu")).toBe("Depot recu");
  });
  it("toGsm7 makes user-supplied text safe: accents folded, the rest replaced", () => {
    expect(toGsm7("Dépôt reçu à l’hôtel — “merci” Fatou Ñaŋ")).toBe('Dépot recu à l\'hotel - "merci" Fatou Ñang');
    expect(toGsm7("👍 ok")).toBe("? ok");
    expect(isGsm7(toGsm7("ëœûîâêôçŋó  "))).toBe(true);
  });
});

describe("inbound commands", () => {
  it("reads the four commands in French, English and Wolof spellings, any case", () => {
    expect(parseCommand("solde")).toEqual({ cmd: "balance" });
    expect(parseCommand(" BALANCE ")).toEqual({ cmd: "balance" });
    expect(parseCommand("Aide")).toEqual({ cmd: "help" });
    expect(parseCommand("ndimbal")).toEqual({ cmd: "help" });
    expect(parseCommand("BON K7MP-2XQR-9TWB-4HNC")).toEqual({ cmd: "voucher", code: "K7MP-2XQR-9TWB-4HNC" });
    expect(parseCommand("bon k7mp 2xqr 9twb 4hnc")).toEqual({ cmd: "voucher", code: "k7mp 2xqr 9twb 4hnc" });
    expect(parseCommand("ARNAQUE Vous avez gagne 1 000 000 F, envoyez votre PIN")).toEqual({ cmd: "scam", text: "Vous avez gagne 1 000 000 F, envoyez votre PIN" });
    expect(parseCommand("ANNULER W123")).toEqual({ cmd: "cancel", ref: "W123" });
    expect(parseCommand("OUI R456")).toEqual({ cmd: "approve", ref: "R456" });
  });
  it("there is no command that moves money out", () => {
    for (const t of ["ENVOYER 5000 771234567", "SEND 100", "RETRAIT 5000", "PAYER 12345 500", "", "bonjour", "BON", "ARNAQUE"]) {
      expect(parseCommand(t).cmd, t).toBe("unknown");
    }
  });
});

describe("android-sms-gateway adapter (shapes from the project's README and docs)", () => {
  const key = "signing-key";
  const sign = (body: string, ts: string) => createHmac("sha256", key).update(body + ts).digest("hex");

  it("sends the documented request", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const gw = new AndroidSmsGateway({ baseUrl: "http://192.168.1.10:8080", username: "u", password: "p", fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ id: "msg-1", state: "Pending" }), { status: 202 });
    } });
    const r = await gw.send("+221771234567", "Solde: 500 F");
    expect(r.id).toBe("msg-1");
    expect(calls[0]!.url).toBe("http://192.168.1.10:8080/message");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Basic " + Buffer.from("u:p").toString("base64"));
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ textMessage: { text: "Solde: 500 F" }, phoneNumbers: ["+221771234567"] });
  });
  it("refuses text outside GSM-7 before it leaves, and reports gateway errors", async () => {
    const gw = new AndroidSmsGateway({ baseUrl: "http://x", username: "u", password: "p", fetch: async () => new Response("nope", { status: 500 }) });
    await expect(gw.send("+221771234567", "Dépôt")).rejects.toMatchObject({ code: "BAD_INPUT" });
    await expect(gw.send("+221771234567", "Depot")).rejects.toMatchObject({ code: "UPSTREAM" });
  });
  it("accepts a signed webhook in either documented payload shape", () => {
    const now = 1_760_000_000;
    for (const payload of [
      { messageId: "m1", message: "SOLDE", phoneNumber: "+221771234567", simNumber: 1, receivedAt: "2026-11-14T10:00:00.000+00:00" },
      { messageId: "m2", message: "SOLDE", sender: "+221771234567", recipient: null, simNumber: 1, receivedAt: "2026-11-14T10:00:00.000+00:00" },
    ]) {
      const body = JSON.stringify({ deviceId: "d", event: "sms:received", id: "e1", payload, webhookId: "w" });
      const ts = String(now);
      expect(parseAsgWebhook({ rawBody: body, signature: sign(body, ts), timestamp: ts, signingKey: key, nowMs: now * 1000 })).toEqual({ id: payload.messageId, from: "+221771234567", text: "SOLDE" });
    }
  });
  it("refuses a bad signature, a stale timestamp, a replayed body with a new timestamp, and other events", () => {
    const now = 1_760_000_000;
    const body = JSON.stringify({ event: "sms:received", payload: { messageId: "m1", message: "SOLDE", phoneNumber: "+221771234567" } });
    const ts = String(now);
    const base = { rawBody: body, signature: sign(body, ts), timestamp: ts, signingKey: key, nowMs: now * 1000 };
    expect(() => parseAsgWebhook({ ...base, signature: "00".repeat(32) })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() => parseAsgWebhook({ ...base, signature: "" })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() => parseAsgWebhook({ ...base, nowMs: (now + 301) * 1000 })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() => parseAsgWebhook({ ...base, timestamp: String(now + 10) })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() => parseAsgWebhook({ ...base, rawBody: body.replace("SOLDE", "BON X") })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    const other = JSON.stringify({ event: "sms:sent", payload: {} });
    expect(parseAsgWebhook({ ...base, rawBody: other, signature: sign(other, ts) })).toBeNull();
  });
});

describe("httpSMS adapter (shapes from docs.httpsms.com)", () => {
  const key = "webhook-signing-key";
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const jwt = (claims: Record<string, unknown>, alg = "HS256", k = key) => {
    const head = `${b64({ alg, typ: "JWT" })}.${b64(claims)}`;
    return `${head}.${createHmac("sha256", k).update(head).digest("base64url")}`;
  };
  const event = {
    data: { contact: "+18005550100", content: "This is a test incoming message", message_id: "0b0123bb-ef2e-468f-908a-c026d51636aa", owner: "+18005550199", sim: "SIM1", timestamp: "2023-06-29T03:21:19.814Z", user_id: "XtABz6zdeFMoBLoltz6SREDvRSh2" },
    datacontenttype: "application/json",
    id: "f4aed1d3-ab4f-42b9-b9dd-9fc7182f7197",
    source: "/v1/messages/receive",
    specversion: "1.0",
    time: "2023-06-29T03:21:19.524331882Z",
    type: "message.phone.received",
  };

  it("sends the documented request", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const h = new HttpSms({ apiKey: "k", from: "+221781112233", fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ data: { id: "abc" }, status: "success" }), { status: 200 });
    } });
    expect((await h.send("+221771234567", "Bonjour")).id).toBe("abc");
    expect(calls[0]!.url).toBe("https://api.httpsms.com/v1/messages/send");
    expect((calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe("k");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ content: "Bonjour", from: "+221781112233", to: "+221771234567" });
  });
  it("accepts a webhook whose bearer token is signed with our key", () => {
    const nowMs = 1_760_000_000_000;
    const auth = "Bearer " + jwt({ exp: nowMs / 1000 + 60 });
    expect(parseHttpSmsWebhook({ rawBody: JSON.stringify(event), authorization: auth, signingKey: key, nowMs })).toEqual({ id: event.data.message_id, from: "+18005550100", text: "This is a test incoming message" });
  });
  it("refuses a wrong key, an unsigned token, an expired token, a missing header", () => {
    const nowMs = 1_760_000_000_000;
    const body = JSON.stringify(event);
    const exp = nowMs / 1000 + 60;
    expect(() => parseHttpSmsWebhook({ rawBody: body, authorization: "Bearer " + jwt({ exp }, "HS256", "other"), signingKey: key, nowMs })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    const none = `${b64({ alg: "none" })}.${b64({ exp })}.`;
    expect(() => parseHttpSmsWebhook({ rawBody: body, authorization: "Bearer " + none, signingKey: key, nowMs })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() => parseHttpSmsWebhook({ rawBody: body, authorization: "Bearer " + jwt({ exp: nowMs / 1000 - 1 }), signingKey: key, nowMs })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() => parseHttpSmsWebhook({ rawBody: body, authorization: undefined, signingKey: key, nowMs })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    const sent = JSON.stringify({ ...event, type: "message.phone.sent" });
    expect(parseHttpSmsWebhook({ rawBody: sent, authorization: "Bearer " + jwt({ exp }), signingKey: key, nowMs })).toBeNull();
  });
});

describe("memory adapter", () => {
  it("keeps what was sent, for tests and the web simulator", async () => {
    const m = new MemorySms();
    await m.send("+221771234567", "un");
    await m.send("+221771234567", "deux");
    expect(m.sent.map((s) => s.body)).toEqual(["un", "deux"]);
    await expect(m.send("+221771234567", "ê")).rejects.toMatchObject({ code: "BAD_INPUT" });
  });
});
