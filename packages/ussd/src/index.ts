// @melax/ussd: a small SDK for putting a USSD menu in front of any service.
// Contract:
//   - a menu is a pure state machine. `enter(state)` says what to show or which effect to run,
//     `onInput` and `onResult` say where to go next. No I/O inside, so every path can be replayed in a test;
//   - a Screen can only be built through con(), end() or menu(), which enforce 160 GSM-7 characters and
//     7 options. Providers accept nothing but a Screen, so an unchecked string cannot reach a phone;
//   - the runtime keeps the session, answers within a time budget (a slow effect gets "you will get an
//     SMS" while it finishes in the background), expires sessions after two minutes, refuses replayed or
//     borrowed session ids, and offers to pick up a dropped session for three minutes;
//   - providers translate one aggregator's HTTP shape to runtime.handle(): Africa's Talking, a generic
//     signed JSON shape, and the web simulator.
// Callers: apps/gateway (the Melax wallet menus); meant to be reusable by other Lightning apps.
import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError, type Clock, type Logger, normalizePhone, silentLogger, systemClock } from "@melax/core";
import { assertGsm7 } from "@melax/sms";

// ---------- screens ----------

export const MAX_CHARS = 160;
export const MAX_OPTIONS = 7;

declare const screenBrand: unique symbol;
/** Text that has passed the length and alphabet checks. Only con(), end() and menu() can make one. */
export interface Screen {
  readonly [screenBrand]: true;
  readonly text: string;
  /** True when this screen closes the session. */
  readonly end: boolean;
}

function make(text: string, isEnd: boolean): Screen {
  if (typeof text !== "string" || text.length === 0) throw new AppError("BAD_INPUT", "empty USSD screen");
  if (text.length > MAX_CHARS) throw new AppError("BAD_INPUT", `USSD screen is ${text.length} characters, the limit is ${MAX_CHARS}`, { text });
  assertGsm7(text);
  return { text, end: isEnd } as Screen;
}
/** A screen that waits for input. */
export const con = (text: string): Screen => make(text, false);
/** A screen that closes the session. */
export const end = (text: string): Screen => make(text, true);
/** A title and up to seven "key label" lines. */
export function menu(title: string, options: Array<[key: string, label: string]>): Screen {
  if (options.length > MAX_OPTIONS) throw new AppError("BAD_INPUT", `a USSD menu holds at most ${MAX_OPTIONS} options`);
  return con([title, ...options.map(([k, label]) => `${k} ${label}`)].join("\n"));
}

// ---------- machine ----------

export type Step<E> = { screen: Screen } | { effect: E };

export interface Machine<S, E, R> {
  /** First state of a session. `shortcut` holds the extra segments of a dial string like *code*4*12345#. */
  initial(ctx: { phone: string; shortcut: string[] }): S;
  /** Arriving in a state: show a screen, or run an effect and wait for its result. */
  enter(state: S): Step<E>;
  onInput(state: S, input: string): S;
  onResult(state: S, result: R): S;
  /** Where a dropped session may pick up from this state. Return an earlier state for secret prompts, null for "nowhere". */
  resumePoint?(state: S): S | null;
}

// ---------- sessions ----------

export interface SessionRecord<S> {
  sessionId: string;
  phone: string;
  state: S;
  startedAt: number;
  /** Set while the user is being asked whether to continue a dropped session. */
  offer: S | null;
}

export interface SessionStore<S> {
  get(sessionId: string): SessionRecord<S> | undefined;
  put(rec: SessionRecord<S>): void;
  end(sessionId: string): void;
  wasEnded(sessionId: string): boolean;
  setResumable(phone: string, state: S, at: number): void;
  getResumable(phone: string): { state: S; at: number } | undefined;
  clearResumable(phone: string): void;
}

/** Sessions in process memory. One gateway process is the unit of deployment for the pilot; state is small and short-lived. */
export class MemorySessions<S> implements SessionStore<S> {
  private readonly open = new Map<string, SessionRecord<S>>();
  private readonly ended = new Map<string, number>();
  private readonly resumable = new Map<string, { state: S; at: number }>();
  get(id: string) {
    return this.open.get(id);
  }
  put(rec: SessionRecord<S>) {
    this.open.set(rec.sessionId, rec);
    if (this.open.size > 50_000) this.open.delete(this.open.keys().next().value as string);
  }
  end(id: string) {
    this.open.delete(id);
    this.ended.set(id, Date.now());
    if (this.ended.size > 50_000) this.ended.delete(this.ended.keys().next().value as string);
  }
  wasEnded(id: string) {
    return this.ended.has(id);
  }
  setResumable(phone: string, state: S, at: number) {
    this.resumable.set(phone, { state, at });
  }
  getResumable(phone: string) {
    return this.resumable.get(phone);
  }
  clearResumable(phone: string) {
    this.resumable.delete(phone);
  }
}

// ---------- runtime ----------

export type TextKind = "busy" | "expired" | "error" | "resume";
export type Texts<S> = Record<TextKind, string> | ((kind: TextKind, state: S | null) => string);

export interface RuntimeOptions<S, E, R> {
  machine: Machine<S, E, R>;
  /** Runs an effect. May take long; the runtime answers the phone without waiting past the step budget. */
  perform: (effect: E, session: { sessionId: string; phone: string }) => Promise<R>;
  sessions: SessionStore<S>;
  texts: Texts<S>;
  clock?: Clock;
  log?: Logger;
  /** How long one step may take before the user is told to expect an SMS. Networks cut a silent session at about 20 s. */
  stepBudgetMs?: number;
  totalBudgetMs?: number;
  resumeWindowMs?: number;
}

export interface UssdRequest {
  sessionId: string;
  /** E.164, as supplied by the network. */
  phone: string;
  /** What the user typed at the last prompt. Empty on the first hit. */
  input: string;
  /** Extra dial-string segments on the first hit. */
  shortcut: string[];
}

export class UssdRuntime<S, E, R> {
  private readonly o: Required<Omit<RuntimeOptions<S, E, R>, "texts">> & { texts: Texts<S> };
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(opts: RuntimeOptions<S, E, R>) {
    this.o = { clock: systemClock, log: silentLogger, stepBudgetMs: 12_000, totalBudgetMs: 120_000, resumeWindowMs: 180_000, ...opts };
  }

  private text(kind: TextKind, state: S | null): string {
    return typeof this.o.texts === "function" ? this.o.texts(kind, state) : this.o.texts[kind];
  }

  /** One request from the network in, one screen out. Requests for the same session run one after the other. */
  handle(req: UssdRequest): Promise<Screen> {
    const prev = this.queues.get(req.sessionId) ?? Promise.resolve();
    const next = prev.then(() => this.handleNow(req)).catch((e) => {
      this.o.log.error("ussd.unhandled", { err: e });
      return end(this.text("error", null));
    });
    this.queues.set(req.sessionId, next);
    void next.finally(() => {
      if (this.queues.get(req.sessionId) === next) this.queues.delete(req.sessionId);
    });
    return next;
  }

  private async handleNow(req: UssdRequest): Promise<Screen> {
    const { machine, sessions, clock } = this.o;
    const now = clock.now();
    if (sessions.wasEnded(req.sessionId)) return end(this.text("expired", null));
    let rec = sessions.get(req.sessionId);

    if (rec) {
      if (rec.phone !== req.phone) {
        this.o.log.warn("ussd.session_phone_mismatch", { sessionId: req.sessionId });
        return end(this.text("error", null));
      }
      if (now - rec.startedAt > this.o.totalBudgetMs) {
        sessions.end(rec.sessionId);
        return end(this.text("expired", rec.state));
      }
      if (rec.offer !== null) {
        const resumeTo = rec.offer;
        rec.offer = null;
        sessions.clearResumable(req.phone);
        return this.run(rec, req.input.trim() === "1" ? resumeTo : machine.initial({ phone: req.phone, shortcut: [] }));
      }
      return this.run(rec, machine.onInput(rec.state, req.input.trim()));
    }

    const initial = machine.initial({ phone: req.phone, shortcut: req.shortcut });
    rec = { sessionId: req.sessionId, phone: req.phone, state: initial, startedAt: now, offer: null };
    if (req.shortcut.length === 0) {
      const res = sessions.getResumable(req.phone);
      if (res && now - res.at <= this.o.resumeWindowMs) {
        rec.offer = res.state;
        sessions.put(rec);
        return con(this.text("resume", res.state));
      }
      sessions.clearResumable(req.phone);
    }
    return this.run(rec, initial);
  }

  private async run(rec: SessionRecord<S>, start: S): Promise<Screen> {
    const { machine, sessions, clock } = this.o;
    let state = start;
    try {
      for (let hop = 0; hop < 16; hop++) {
        const step = machine.enter(state);
        if ("screen" in step) {
          rec.state = state;
          if (step.screen.end) {
            sessions.end(rec.sessionId);
            sessions.clearResumable(rec.phone);
          } else {
            sessions.put(rec);
            // "Nowhere" also forgets an older resume point: a user who walked back to a screen that
            // is not worth resuming must not be offered the screen before it.
            const rp = machine.resumePoint ? machine.resumePoint(state) : null;
            if (rp !== null) sessions.setResumable(rec.phone, rp, clock.now());
            else sessions.clearResumable(rec.phone);
          }
          return step.screen;
        }
        const work = this.o.perform(step.effect, { sessionId: rec.sessionId, phone: rec.phone });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<"late">((resolve) => {
          timer = setTimeout(() => resolve("late"), this.o.stepBudgetMs);
        });
        const first = await Promise.race([work.then((value) => ({ value })), late]);
        clearTimeout(timer);
        if (first === "late") {
          // The effect keeps running; its outcome reaches the user by SMS. The session cannot wait for it.
          work.catch((e) => this.o.log.error("ussd.detached_effect_failed", { err: e }));
          sessions.end(rec.sessionId);
          sessions.clearResumable(rec.phone);
          return end(this.text("busy", state));
        }
        state = machine.onResult(state, first.value);
      }
      throw new AppError("INTERNAL", "USSD machine did not settle on a screen");
    } catch (e) {
      this.o.log.error("ussd.step_failed", { err: e });
      sessions.end(rec.sessionId);
      sessions.clearResumable(rec.phone);
      return end(this.text("error", state));
    }
  }
}

// ---------- providers ----------

type AnyRuntime = { handle(req: UssdRequest): Promise<Screen> };

/**
 * Africa's Talking callback: form fields sessionId, serviceCode, phoneNumber, networkCode, text.
 * `text` is everything typed so far joined by "*", so the provider remembers how much it has consumed.
 * Reply is plain text starting with CON (session continues) or END.
 * Africa's Talking does not sign callbacks: put this behind a secret path and an IP allow-list (the gateway does both).
 */
export function africasTalking(rt: AnyRuntime, opts: { serviceCode?: string } = {}) {
  const consumed = new Map<string, number>();
  return {
    async handle(formBody: string): Promise<string> {
      const f = new URLSearchParams(formBody);
      const sessionId = f.get("sessionId") ?? "";
      const text = f.get("text") ?? "";
      if (!sessionId || sessionId.length > 200) throw new AppError("BAD_INPUT", "missing sessionId");
      if (opts.serviceCode && f.get("serviceCode") !== opts.serviceCode) throw new AppError("FORBIDDEN", "unexpected service code");
      const phone = normalizePhone(f.get("phoneNumber") ?? "");
      const parts = text === "" ? [] : text.split("*");
      const seen = consumed.get(sessionId);
      let screen: Screen;
      if (seen === undefined) {
        screen = await rt.handle({ sessionId, phone, input: "", shortcut: parts });
      } else {
        screen = await rt.handle({ sessionId, phone, input: parts.slice(seen).join("*"), shortcut: [] });
      }
      if (screen.end) consumed.delete(sessionId);
      else consumed.set(sessionId, parts.length);
      if (consumed.size > 50_000) consumed.delete(consumed.keys().next().value as string);
      return `${screen.end ? "END" : "CON"} ${screen.text}`;
    },
  };
}

/**
 * A plain JSON shape for a local aggregator: { sessionId, msisdn, input, newSession } in,
 * { message, continue } out. Authenticated with X-Signature = hex HMAC-SHA256(secret, timestamp + "." + body)
 * and a timestamp no more than five minutes away.
 */
export function genericHttp(rt: AnyRuntime, opts: { secret: string; clock?: Clock }) {
  const clock = opts.clock ?? systemClock;
  return {
    async handle(rawBody: string, auth: { signature: string | undefined; timestamp: string | undefined }): Promise<{ message: string; continue: boolean }> {
      const ts = Number(auth.timestamp);
      if (!auth.signature || !auth.timestamp || !Number.isFinite(ts) || Math.abs(clock.now() / 1000 - ts) > 300) throw new AppError("FORBIDDEN", "unsigned or stale request");
      const want = createHmac("sha256", opts.secret).update(auth.timestamp + "." + rawBody).digest();
      const got = Buffer.from(auth.signature, "hex");
      if (got.length !== want.length || !timingSafeEqual(got, want)) throw new AppError("FORBIDDEN", "bad signature");
      const j = JSON.parse(rawBody) as { sessionId?: string; msisdn?: string; input?: string; newSession?: boolean };
      if (!j.sessionId || typeof j.sessionId !== "string" || j.sessionId.length > 200) throw new AppError("BAD_INPUT", "missing sessionId");
      const phone = normalizePhone(String(j.msisdn ?? ""));
      const input = String(j.input ?? "");
      const screen = await rt.handle({ sessionId: j.sessionId, phone, input: j.newSession ? "" : input, shortcut: j.newSession && input ? input.split("*") : [] });
      return { message: screen.text, continue: !screen.end };
    },
  };
}

/** The web phone simulator. No authentication: the gateway only mounts it in demo mode. */
export function simulator(rt: AnyRuntime) {
  return {
    async handle(req: { sessionId: string; phone: string; input: string; dial?: string }): Promise<{ message: string; continue: boolean }> {
      if (!req.sessionId || req.sessionId.length > 200) throw new AppError("BAD_INPUT", "missing sessionId");
      const phone = normalizePhone(req.phone);
      // dial: "#2580#" or "#2580*4*12345#" -> shortcut ["4", "12345"]
      const shortcut = req.dial ? req.dial.replace(/^[*#]+|#+$/g, "").split("*").slice(1).filter(Boolean) : [];
      const screen = await rt.handle({ sessionId: req.sessionId, phone, input: req.dial ? "" : req.input, shortcut });
      return { message: screen.text, continue: !screen.end };
    },
  };
}
