// The gateway's HTTP surface: where USSD aggregators and SMS phone gateways call in.
// Contract:
//   - every body is read as raw text, at most 16 KB: signatures are checked over the exact bytes received;
//   - a route exists only when its secret is configured. /ussd/sim, the /sim routes of demo.ts and the
//     web pages are mounted in demo mode only, and they are the only routes with no authentication;
//   - Africa's Talking does not sign: its route is /ussd/at/<secret> and only allow-listed addresses may
//     call it. A wrong secret gets the same 404 as a path that does not exist;
//   - an error answer carries a short word, never a message, a stack or an echo of the request;
//   - the request log holds the route pattern, the status and the time taken. No path, no body, no address.
// Callers: main.ts (listen), tests (inject).
import Fastify, { type FastifyInstance } from "fastify";
import { AppError, isAppError } from "@melax/core";
import { constantTimeEqual } from "@melax/crypto";
import { parseAsgWebhook, parseHttpSmsWebhook } from "@melax/sms";
import { africasTalking, genericHttp, simulator } from "@melax/ussd";
import type { App } from "./app.ts";
import { mountDemo } from "./demo.ts";
import { type StaticFiles, mountStatic } from "./static.ts";

const header = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export function buildHttp(app: App, opts: { web?: StaticFiles } = {}): FastifyInstance {
  const { config, log, clock } = app;
  const http = Fastify({ logger: false, bodyLimit: 16 * 1024, trustProxy: config.trustProxy });

  http.removeAllContentTypeParsers();
  http.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));
  const raw = (body: unknown): string => (typeof body === "string" ? body : "");

  http.addHook("onResponse", async (req, reply) => {
    log.info("http", { route: req.routeOptions.url ?? "unmatched", method: req.method, status: reply.statusCode, ms: Math.round(reply.elapsedTime) });
  });

  http.setNotFoundHandler(async (_req, reply) => reply.code(404).send({ error: "not_found" }));

  http.setErrorHandler(async (err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode;
    if (isAppError(err, "FORBIDDEN")) return reply.code(403).send({ error: "forbidden" });
    if (isAppError(err, "BAD_INPUT") || isAppError(err, "BAD_PHONE") || isAppError(err, "BAD_AMOUNT") || err instanceof SyntaxError) return reply.code(400).send({ error: "bad_request" });
    if (typeof status === "number" && status >= 400 && status < 500) return reply.code(status).send({ error: status === 413 ? "too_large" : "bad_request" });
    log.error("http.error", { route: req.routeOptions.url ?? "unmatched", err });
    return reply.code(500).send({ error: "internal" });
  });

  http.get("/healthz", async () => {
    await app.db.query("SELECT 1");
    return { ok: true };
  });

  // ---------- USSD ----------

  if (config.demo) {
    const sim = simulator(app.runtime);
    http.post("/ussd/sim", async (req) => {
      const j = JSON.parse(raw(req.body)) as { sessionId?: unknown; phone?: unknown; input?: unknown; dial?: unknown };
      return sim.handle({ sessionId: String(j.sessionId ?? ""), phone: String(j.phone ?? ""), input: String(j.input ?? ""), dial: typeof j.dial === "string" && j.dial ? j.dial : undefined });
    });
    // What the web simulator reads, the top-up button, and the pages themselves.
    mountDemo(http, app);
    if (opts.web) mountStatic(http, opts.web);
  }

  if (config.at) {
    const at = config.at;
    const provider = africasTalking(app.runtime, { serviceCode: at.serviceCode });
    http.post<{ Params: { secret: string } }>("/ussd/at/:secret", async (req, reply) => {
      if (!constantTimeEqual(req.params.secret, at.secret)) return reply.code(404).send({ error: "not_found" });
      if (at.allowIps.length > 0 && !at.allowIps.includes(req.ip)) throw new AppError("FORBIDDEN", "caller is not on the allow-list");
      const text = await provider.handle(raw(req.body));
      return reply.type("text/plain; charset=utf-8").send(text);
    });
  }

  if (config.ussdHttpSecret) {
    const provider = genericHttp(app.runtime, { secret: config.ussdHttpSecret, clock });
    http.post("/ussd/http", async (req) => provider.handle(raw(req.body), { signature: header(req.headers["x-signature"]), timestamp: header(req.headers["x-timestamp"]) }));
  }

  // ---------- the arbiter ----------

  if (config.operatorSecret) {
    const secret = config.operatorSecret;
    // A wrong or missing secret gets the answer a path that does not exist gets.
    http.post("/ops/escrow/decide", async (req, reply) => {
      const auth = header(req.headers.authorization) ?? "";
      if (!auth.startsWith("Bearer ") || !constantTimeEqual(auth.slice(7), secret)) return reply.code(404).send({ error: "not_found" });
      const j = JSON.parse(raw(req.body)) as { tradeId?: unknown; winner?: unknown; arbiter?: unknown; note?: unknown } | null;
      const r = await app.escrow.decide({ tradeId: String(j?.tradeId ?? ""), winner: j?.winner as "user" | "agent", arbiter: String(j?.arbiter ?? ""), note: typeof j?.note === "string" ? j.note : "" });
      if (r.ok) return { ok: true, state: r.trade.state };
      if (r.err === "BAD_INPUT") return reply.code(400).send({ error: "bad_request" });
      if (r.err === "NOT_FOUND") return reply.code(404).send({ error: "not_found" });
      if (r.err === "STATE") return reply.code(409).send({ error: "conflict" });
      return reply.code(503).send({ error: "unavailable" });
    });
  }

  // ---------- SMS webhooks ----------

  if (config.smsIn.asgSigningKey) {
    const signingKey = config.smsIn.asgSigningKey;
    http.post("/sms/asg", async (req) => {
      const msg = parseAsgWebhook({ rawBody: raw(req.body), signature: header(req.headers["x-signature"]), timestamp: header(req.headers["x-timestamp"]), signingKey, nowMs: clock.now() });
      if (msg) await app.inbound.handle(msg);
      return { ok: true };
    });
  }

  if (config.smsIn.httpSmsSigningKey) {
    const signingKey = config.smsIn.httpSmsSigningKey;
    http.post("/sms/httpsms", async (req) => {
      const msg = parseHttpSmsWebhook({ rawBody: raw(req.body), authorization: header(req.headers.authorization), signingKey, nowMs: clock.now() });
      if (msg) await app.inbound.handle(msg);
      return { ok: true };
    });
  }

  return http;
}
