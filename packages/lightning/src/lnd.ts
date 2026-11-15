// LND over its REST API. Used by the local regtest stack and any deployment that runs its own node.
// Contract: implements LightningBackend (see types.ts). Hold invoices are native (invoicesrpc).
// Trust: the macaroon and TLS certificate are read from files mounted into the gateway container;
// the certificate is pinned as the only CA, so nothing else on the network can pose as the node.
// Callers: apps/gateway composition root, infra/regtest-init, the contract test suite.
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { AppError } from "@melax/core";
import { preimageMatches } from "./invoice.ts";
import type { Balance, Capabilities, Invoice, InvoiceState, InvoiceStatus, LightningBackend, PayOutcome } from "./types.ts";

export interface LndConfig {
  /** e.g. https://lnd-gw:8080 */
  baseUrl: string;
  macaroonHex: string;
  /** PEM of the node's self-signed certificate. Required for https. */
  tlsCertPem?: string;
}

const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");
// URL-safe alphabet WITH padding: LND's REST gateway rejects unpadded values in path parameters.
const b64url = (hex: string) => Buffer.from(hex, "hex").toString("base64").replaceAll("+", "-").replaceAll("/", "_");
const hexOfB64 = (s: string) => Buffer.from(s, "base64").toString("hex");

function mapState(s: string): InvoiceState {
  if (s === "SETTLED") return "settled";
  if (s === "ACCEPTED") return "accepted";
  if (s === "CANCELED") return "cancelled";
  return "open";
}

type LndInvoice = { r_hash: string; state: string; value: string; settle_date?: string; payment_request?: string };
type LndPayment = { payment_hash: string; status: string; payment_preimage?: string; fee_sat?: string; failure_reason?: string };

function payOutcome(p: LndPayment): PayOutcome {
  if (p.status === "SUCCEEDED" && p.payment_preimage && preimageMatches(p.payment_preimage, p.payment_hash)) {
    return { status: "succeeded", preimage: p.payment_preimage, feeSat: Number(p.fee_sat ?? 0) };
  }
  if (p.status === "FAILED") return { status: "failed", reason: p.failure_reason ?? "FAILED" };
  return { status: "pending" };
}

export class LndBackend implements LightningBackend {
  private readonly url: URL;
  private readonly agent: https.Agent | http.Agent;
  private readonly streams = new Set<{ destroy(): void }>();
  private readonly listeners = new Set<(s: InvoiceStatus) => void>();
  private mainStream = false;
  private closed = false;
  private readonly cfg: LndConfig;

  constructor(cfg: LndConfig) {
    this.cfg = cfg;
    this.url = new URL(cfg.baseUrl);
    this.agent = this.url.protocol === "https:" ? new https.Agent({ ca: cfg.tlsCertPem, keepAlive: true }) : new http.Agent({ keepAlive: true });
    if (this.url.protocol === "https:" && !cfg.tlsCertPem) throw new AppError("BAD_INPUT", "LND over https needs the node's tls.cert");
  }

  static fromFiles(opts: { baseUrl: string; macaroonPath: string; tlsCertPath: string }): LndBackend {
    return new LndBackend({ baseUrl: opts.baseUrl, macaroonHex: readFileSync(opts.macaroonPath).toString("hex"), tlsCertPem: readFileSync(opts.tlsCertPath, "utf8") });
  }

  /** One JSON request. Rejects with UPSTREAM (and LND's message) on a non-2xx answer. */
  request<T = Record<string, unknown>>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const lib = this.url.protocol === "https:" ? https : http;
      const req = lib.request(
        {
          host: this.url.hostname,
          port: this.url.port,
          path,
          method,
          agent: this.agent,
          headers: { "Grpc-Metadata-macaroon": this.cfg.macaroonHex, ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: Record<string, unknown>;
            try {
              json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
            } catch {
              return reject(new AppError("UPSTREAM", `lnd ${method} ${path.split("?")[0]} returned non-JSON (${res.statusCode})`));
            }
            if ((res.statusCode ?? 500) >= 300) {
              return reject(new AppError("UPSTREAM", String(json.message ?? json.error ?? `lnd http ${res.statusCode}`), { status: res.statusCode, lndCode: json.code }));
            }
            resolve(json as T);
          });
        },
      );
      req.on("timeout", () => req.destroy(new AppError("UPSTREAM", "lnd request timed out")));
      req.on("error", (e) => reject(e instanceof AppError ? e : new AppError("UPSTREAM", "lnd unreachable: " + e.message)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * A server-streaming call. Each line is {"result": ...} or {"error": ...}.
   * `onItem` may return true to stop early. Resolves when the stream ends; rejects if LND reports an error.
   */
  private stream<T>(method: string, path: string, body: unknown, onItem: (item: T) => boolean | void, track = false): Promise<void> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const lib = this.url.protocol === "https:" ? https : http;
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        this.streams.delete(req);
        if (err) reject(err);
        else resolve();
      };
      const req = lib.request(
        {
          host: this.url.hostname,
          port: this.url.port,
          path,
          method,
          agent: new (this.url.protocol === "https:" ? https.Agent : http.Agent)({ ca: this.cfg.tlsCertPem } as https.AgentOptions),
          headers: { "Grpc-Metadata-macaroon": this.cfg.macaroonHex, ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) },
        },
        (res) => {
          let buf = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            buf += chunk;
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              try {
                const msg = JSON.parse(line) as { result?: T; error?: { message?: string; code?: number } };
                if (msg.error) {
                  req.destroy();
                  return finish(new AppError("UPSTREAM", String(msg.error.message ?? "lnd stream error"), { lndCode: msg.error.code }));
                }
                if (msg.result !== undefined && onItem(msg.result) === true) {
                  req.destroy();
                  return finish();
                }
              } catch {
                /* partial line; wait for more */
              }
            }
          });
          res.on("end", () => {
            const rest = buf.trim();
            if (rest) {
              try {
                const msg = JSON.parse(rest) as { result?: T; error?: { message?: string; code?: number }; message?: string; code?: number };
                if (msg.error || (res.statusCode ?? 200) >= 300) return finish(new AppError("UPSTREAM", String(msg.error?.message ?? msg.message ?? "lnd stream error"), { lndCode: msg.error?.code ?? msg.code }));
                if (msg.result !== undefined) onItem(msg.result);
              } catch {
                /* ignore trailing garbage */
              }
            }
            finish();
          });
          res.on("error", (e) => finish(new AppError("UPSTREAM", "lnd stream broke: " + e.message)));
        },
      );
      req.on("error", (e) => finish(done ? undefined : new AppError("UPSTREAM", "lnd unreachable: " + e.message)));
      if (track) this.streams.add(req);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async capabilities(): Promise<Capabilities> {
    const info = await this.request<{ identity_pubkey: string; alias: string; chains?: Array<{ network: string }> }>("GET", "/v1/getinfo");
    const net = info.chains?.[0]?.network ?? "unknown";
    return { backend: "lnd", holdInvoices: true, network: net === "mainnet" ? "bitcoin" : net, pubkey: info.identity_pubkey, alias: info.alias };
  }

  async makeInvoice(req: { amountSat: number; memo?: string; descriptionHash?: string; expirySec?: number }): Promise<Invoice> {
    const expiry = req.expirySec ?? 3600;
    const r = await this.request<{ r_hash: string; payment_request: string }>("POST", "/v1/invoices", {
      value: String(req.amountSat),
      memo: req.descriptionHash ? undefined : req.memo,
      description_hash: req.descriptionHash ? b64(req.descriptionHash) : undefined,
      expiry: String(expiry),
    });
    return { paymentHash: hexOfB64(r.r_hash), bolt11: r.payment_request, amountSat: req.amountSat, expiresAt: Date.now() + expiry * 1000 };
  }

  async makeHoldInvoice(req: { amountSat: number; paymentHash: string; memo?: string; expirySec?: number }): Promise<Invoice> {
    const expiry = req.expirySec ?? 3600;
    const r = await this.request<{ payment_request: string }>("POST", "/v2/invoices/hodl", { hash: b64(req.paymentHash), value: String(req.amountSat), memo: req.memo, expiry: String(expiry) });
    if (this.listeners.size > 0) this.watchOne(req.paymentHash);
    return { paymentHash: req.paymentHash, bolt11: r.payment_request, amountSat: req.amountSat, expiresAt: Date.now() + expiry * 1000 };
  }

  async settle(preimageHex: string): Promise<void> {
    await this.request("POST", "/v2/invoices/settle", { preimage: b64(preimageHex) });
  }

  async cancel(paymentHash: string): Promise<boolean> {
    await this.request("POST", "/v2/invoices/cancel", { payment_hash: b64(paymentHash) });
    return true;
  }

  async pay(req: { bolt11: string; maxFeeSat: number; timeoutSec?: number }): Promise<PayOutcome> {
    let last: LndPayment | undefined;
    try {
      await this.stream<LndPayment>(
        "POST",
        "/v2/router/send",
        { payment_request: req.bolt11, timeout_seconds: req.timeoutSec ?? 60, fee_limit_sat: String(req.maxFeeSat), no_inflight_updates: true },
        (p) => {
          last = p;
        },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      // Definite refusals happen before anything is sent.
      if (/invoice expired|invalid|incorrect|checksum|unable to route|self-payments not allowed|amount must|not enough|insufficient/i.test(msg) && !/already/i.test(msg)) {
        return { status: "failed", reason: msg };
      }
      return { status: "pending" }; // includes "already paid / in flight": the caller looks the hash up
    }
    return last ? payOutcome(last) : { status: "pending" };
  }

  async lookupInvoice(paymentHash: string): Promise<InvoiceStatus | null> {
    try {
      const inv = await this.request<LndInvoice>("GET", `/v1/invoice/${paymentHash}`);
      return this.toStatus(inv);
    } catch (e) {
      if (e instanceof AppError && (e.data.status === 404 || /unable to locate|no existing invoices|not found/i.test(e.message))) return null;
      throw e;
    }
  }

  private toStatus(inv: LndInvoice): InvoiceStatus {
    const state = mapState(inv.state);
    const settledAt = state === "settled" && inv.settle_date && inv.settle_date !== "0" ? Number(inv.settle_date) * 1000 : undefined;
    return { paymentHash: hexOfB64(inv.r_hash), state, amountSat: Number(inv.value), settledAt };
  }

  async lookupPayment(paymentHash: string): Promise<PayOutcome | null> {
    let first: LndPayment | undefined;
    try {
      await this.stream<LndPayment>("GET", `/v2/router/track/${b64url(paymentHash)}?no_inflight_updates=false`, undefined, (p) => {
        first = p;
        return true;
      });
    } catch (e) {
      if (e instanceof AppError && /isn't initiated|not initiated|not found|no such payment/i.test(e.message)) return null;
      throw e;
    }
    return first ? payOutcome(first) : null;
  }

  subscribeInvoices(onUpdate: (s: InvoiceStatus) => void): () => void {
    this.listeners.add(onUpdate);
    if (!this.mainStream) {
      this.mainStream = true;
      void this.runMainStream();
    }
    return () => this.listeners.delete(onUpdate);
  }

  private emit(s: InvoiceStatus): void {
    for (const l of this.listeners) {
      try {
        l(s);
      } catch {
        /* a listener must not break the stream */
      }
    }
  }

  /** All-invoices stream: fires on add and on settle. Reconnects with backoff until close(). */
  private async runMainStream(): Promise<void> {
    let delay = 500;
    while (!this.closed) {
      try {
        await this.stream<LndInvoice>("GET", "/v1/invoices/subscribe", undefined, (inv) => {
          delay = 500;
          const s = this.toStatus(inv);
          if (s.state !== "open") this.emit(s);
        }, true);
      } catch {
        /* fall through to the retry */
      }
      if (this.closed) break;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15_000);
    }
  }

  /** Per-invoice stream: the only way LND reports a hold invoice becoming "accepted". */
  private watchOne(paymentHash: string): void {
    void this.stream<LndInvoice>("GET", `/v2/invoices/subscribe/${b64url(paymentHash)}`, undefined, (inv) => {
      const s = this.toStatus(inv);
      if (s.state !== "open") this.emit(s);
      return s.state === "settled" || s.state === "cancelled";
    }, true).catch(() => undefined);
  }

  async balance(): Promise<Balance> {
    type Amt = { sat?: string };
    const b = await this.request<{ local_balance?: Amt; remote_balance?: Amt; unsettled_local_balance?: Amt; unsettled_remote_balance?: Amt }>("GET", "/v1/balance/channels");
    return {
      spendableSat: Number(b.local_balance?.sat ?? 0),
      receivableSat: Number(b.remote_balance?.sat ?? 0),
      pendingSat: Number(b.unsettled_local_balance?.sat ?? 0) + Number(b.unsettled_remote_balance?.sat ?? 0),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    for (const s of this.streams) s.destroy();
    this.streams.clear();
    this.agent.destroy();
  }
}
