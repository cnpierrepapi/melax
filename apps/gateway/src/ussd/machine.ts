// The wallet menus as one pure machine for @melax/ussd. No I/O here: `enter` says which screen to show
// or which effect to run, `onInput` and `onResult` say where to go next. perform.ts runs the effects.
// Contract:
//   - state is plain data { at, lang, profile, v, q }. `at` names the step, `v` holds what was typed so
//     far, `q` holds pre-typed inputs from a dial string like #2580*2*771234567*500#;
//   - a secret code lives in `v` only between the prompt that read it and the result of the effect that
//     used it. No resume point and no resting state after that effect holds one;
//   - a queued input is never fed to a code prompt: the queue is dropped there, because dial strings
//     stay in call logs;
//   - every step that spends shows a confirm screen first and asks for the code last;
//   - all text comes from @melax/i18n. Text typed by a user passes through clip().
// Callers: app.ts (wired into UssdRuntime), test/machine.test.ts (golden transcripts).
import { isWeakPin } from "@melax/crypto";
import { LANGS, LANG_NAMES, type Lang, type MessageKey, clip, fcfa, sats, shortDate, t } from "@melax/i18n";
import { type Machine, type Screen, type Step, type TextKind, con, end, menu } from "@melax/ussd";
import { ALIAS_RE, NAME_RE } from "../rules.ts";

// ---------- effects and results ----------

export type Effect =
  | { t: "profile" }
  | { t: "register"; pin: string; name: string; lang: Lang }
  | { t: "balance"; pin: string }
  | { t: "resolve"; to: string }
  | { t: "quote"; toRef: string; fcfa: number }
  | { t: "send"; toRef: string; fcfa: number; sats: number; pin: string }
  | { t: "receiveInfo" }
  | { t: "receiveSms" }
  /** `pin` is required for page 0. Later pages are only asked for after page 0 was shown in the same session. */
  | { t: "history"; pin?: string; page: number }
  | { t: "pinChange"; pin: string; newPin: string }
  | { t: "setLang"; lang: Lang }
  | { t: "address" }
  | { t: "setAlias"; alias: string; pin: string }
  | { t: "limits" };

export type Err = "PIN_WRONG" | "PIN_LOCKED" | "INSUFFICIENT_FUNDS" | "LIMIT" | "BUSY" | "PAUSED" | "FROZEN" | "NOT_FOUND" | "BAD_INPUT" | "PENDING" | "REPORTED" | "GENERIC";
export type LimitReason = "PER_TX" | "PER_DAY" | "PER_MONTH" | "NEW_RECIPIENT" | "BAD_AMOUNT";

export interface HistItem {
  ts: number;
  /** Signed whole FCFA: negative when the money left. */
  fcfa: number;
  who: string;
}

/** One shape for every effect result: ok or not, an error code when not, and the data the next screen needs. */
export interface Res {
  ok: boolean;
  err?: Err;
  /** Narrows BAD_INPUT: "weak" (code), "self" (own number), "taken" (address name). */
  why?: string;
  registered?: boolean;
  lang?: Lang;
  name?: string;
  role?: string;
  fcfa?: number;
  sats?: number;
  rate?: number;
  balanceFcfa?: number;
  toRef?: string;
  masked?: string;
  reason?: LimitReason;
  allowedFcfa?: number;
  receipt?: number;
  left?: number;
  minutes?: number;
  hours?: number;
  address?: string;
  items?: HistItem[];
  more?: boolean;
  tier?: number;
  perTxFcfa?: number;
  dayLeftFcfa?: number;
  monthLeftFcfa?: number;
}

// ---------- state ----------

export type At =
  | "boot"
  | "end"
  | "onb.lang" | "onb.pin1" | "onb.pin2" | "onb.name" | "onb.run"
  | "home" | "home2"
  | "bal.pin" | "bal.run" | "bal.show"
  | "send.to" | "send.resolve" | "send.amount" | "send.quote" | "send.confirm" | "send.pin" | "send.run"
  | "recv.run" | "recv.show" | "recv.sms"
  | "hist.pin" | "hist.run" | "hist.show"
  | "acct" | "acct.pin"
  | "pinchg.old" | "pinchg.new" | "pinchg.new2" | "pinchg.run"
  | "lang.pick" | "lang.run"
  | "addr.run" | "addr.show" | "addr.ask" | "addr.pin" | "addr.set"
  | "lim.run" | "lim.show";

/** Steps whose input is a secret code. The dial-string queue is dropped at each, and none is ever a resume point. */
export const PIN_STEPS: ReadonlySet<At> = new Set<At>(["onb.pin1", "onb.pin2", "bal.pin", "send.pin", "hist.pin", "pinchg.old", "pinchg.new", "pinchg.new2", "addr.pin"]);

interface V {
  /** Secret codes. Present only between the prompt and the effect that uses them. */
  pin?: string;
  pin1?: string;
  newPin?: string;
  /** Tries left after a wrong code. */
  left?: number;
  /** A message to put above the prompt of the current step. */
  note?: string;
  /** Text of a closing screen. */
  text?: string;
  to?: string;
  toRef?: string;
  name?: string;
  masked?: string;
  fcfa?: number;
  sats?: number;
  rate?: number;
  address?: string;
  alias?: string;
  page?: number;
  items?: HistItem[];
  more?: boolean;
  tier?: number;
  perTx?: number;
  dayLeft?: number;
  monthLeft?: number;
  pick?: Lang;
}

export interface S {
  at: At;
  lang: Lang;
  profile: { name: string; role: string } | null;
  v: V;
  q: string[];
}

const MAX_QUEUE = 8;
const HISTORY_LINES = 4;
const PHONE_RE = /^\+?\d{7,15}$/;

const go = (s: S, at: At, v: V = {}): S => ({ ...s, at, v });
const fin = (s: S, text: string): S => ({ ...s, at: "end", v: { text }, q: [] });
const say = (s: S, key: MessageKey, vars: Record<string, string | number> = {}): S => fin(s, t(s.lang, key, vars));

const LIMIT_KEYS: Record<LimitReason, MessageKey> = { PER_TX: "err.limit.tx", PER_DAY: "err.limit.day", PER_MONTH: "err.limit.month", NEW_RECIPIENT: "err.limit.new", BAD_AMOUNT: "amount.bad" };

/** The sentence for a refusal. Used both as a closing screen and as a note above a prompt. */
function refusal(lang: Lang, r: Res): string {
  switch (r.err) {
    case "PIN_LOCKED":
      return t(lang, "pin.locked", { minutes: r.minutes ?? 15 });
    case "FROZEN":
      return t(lang, "err.frozen", { hours: r.hours ?? 24 });
    case "INSUFFICIENT_FUNDS":
      return t(lang, "err.insufficient", { balance: fcfa(r.balanceFcfa ?? 0) });
    case "LIMIT": {
      const key = LIMIT_KEYS[r.reason ?? "PER_TX"];
      return key === "amount.bad" ? t(lang, "err.generic") : t(lang, key, { allowed: fcfa(r.allowedFcfa ?? 0) });
    }
    case "BUSY":
      return t(lang, "err.busy");
    case "PAUSED":
      return t(lang, "err.paused");
    case "PENDING":
      return t(lang, "pending");
    case "REPORTED":
      return t(lang, "err.reported");
    default:
      return t(lang, "err.generic");
  }
}

function pinPrompt(s: S, ask: MessageKey = "pin.ask"): Screen {
  return con(s.v.left !== undefined ? t(s.lang, "pin.wrong", { left: s.v.left }) : s.v.note ?? t(s.lang, ask));
}

function langMenu(title: string): Screen {
  return menu(title, LANGS.map((l, i) => [String(i + 1), LANG_NAMES[l]] as [string, string]));
}
const pickLang = (input: string): Lang | undefined => LANGS[Number(input) - 1];

// ---------- the machine ----------

export function createWalletMachine(cfg: { code: string }): Machine<S, Effect, Res> {
  function enterRaw(s: S): Step<Effect> {
    const L = s.lang;
    const v = s.v;
    switch (s.at) {
      case "boot":
        return { effect: { t: "profile" } };
      case "end":
        return { screen: end(v.text ?? t(L, "err.generic")) };

      // onboarding
      case "onb.lang":
        return { screen: langMenu(t(L, "home.title")) };
      case "onb.pin1":
        return { screen: con(v.note ?? t(L, "onb.welcome")) };
      case "onb.pin2":
        return { screen: con(t(L, "onb.pin2")) };
      case "onb.name":
        return { screen: con(v.note ?? t(L, "onb.name")) };
      case "onb.run":
        return { effect: { t: "register", pin: v.pin1 ?? "", name: v.name ?? "", lang: L } };

      // home
      case "home":
        return {
          screen: menu(t(L, "home.title"), [["1", t(L, "m.balance")], ["2", t(L, "m.send")], ["3", t(L, "m.receive")], ["4", t(L, "m.pay")], ["5", t(L, "m.deposit")], ["6", t(L, "m.withdraw")], ["0", t(L, "m.more")]]),
        };
      case "home2":
        return { screen: menu(t(L, "home.title"), [["7", t(L, "m.vouchers")], ["8", t(L, "m.history")], ["9", t(L, "m.account")], ["0", t(L, "m.back")]]) };

      // balance
      case "bal.pin":
        return { screen: pinPrompt(s) };
      case "bal.run":
        return { effect: { t: "balance", pin: v.pin ?? "" } };
      case "bal.show":
        return { screen: con(t(L, "bal.show", { fcfa: fcfa(v.fcfa ?? 0), sats: sats(v.sats ?? 0), rate: fcfa(v.rate ?? 0) })) };

      // send
      case "send.to":
        return { screen: con(v.note ?? t(L, "send.to")) };
      case "send.resolve":
        return { effect: { t: "resolve", to: v.to ?? "" } };
      case "send.amount":
        return { screen: con(v.note ?? t(L, "amount.ask")) };
      case "send.quote":
        return { effect: { t: "quote", toRef: v.toRef ?? "", fcfa: v.fcfa ?? 0 } };
      case "send.confirm":
        return { screen: con(t(L, "send.confirm", { fcfa: fcfa(v.fcfa ?? 0), sats: sats(v.sats ?? 0), name: clip(v.name ?? "", 16), masked: v.masked ?? "" })) };
      case "send.pin":
        return { screen: pinPrompt(s) };
      case "send.run":
        return { effect: { t: "send", toRef: v.toRef ?? "", fcfa: v.fcfa ?? 0, sats: v.sats ?? 0, pin: v.pin ?? "" } };

      // receive
      case "recv.run":
        return { effect: { t: "receiveInfo" } };
      case "recv.show":
        return { screen: con(t(L, "recv.show", { address: v.address ?? "" })) };
      case "recv.sms":
        return { effect: { t: "receiveSms" } };

      // history
      case "hist.pin":
        return { screen: pinPrompt(s) };
      case "hist.run":
        return { effect: v.pin !== undefined ? { t: "history", pin: v.pin, page: 0 } : { t: "history", page: v.page ?? 0 } };
      case "hist.show": {
        const lines = (v.items ?? []).slice(0, HISTORY_LINES).map((i) => `${shortDate(i.ts)} ${i.fcfa < 0 ? "-" : "+"}${fcfa(Math.abs(i.fcfa))} ${clip(i.who, 14)}`);
        if (v.more) lines.push(`1 ${t(L, "m.more")}`);
        lines.push(`0 ${t(L, "m.menu")}`);
        return { screen: con(lines.join("\n")) };
      }

      // account
      case "acct":
        return {
          screen: menu(t(L, "m.account"), [["1", t(L, "acct.pin")], ["2", t(L, "acct.lang")], ["3", t(L, "acct.address")], ["4", t(L, "acct.guardians")], ["5", t(L, "acct.limits")], ["6", t(L, "acct.smartphone")], ["0", t(L, "m.back")]]),
        };
      case "acct.pin":
        return { screen: menu(t(L, "acct.pin"), [["1", t(L, "pinchg.change")], ["2", t(L, "pinchg.forgot")], ["0", t(L, "m.back")]]) };
      case "pinchg.old":
        return { screen: pinPrompt(s, "pinchg.old") };
      case "pinchg.new":
        return { screen: con(v.note ?? t(L, "pinchg.new")) };
      case "pinchg.new2":
        return { screen: con(t(L, "pinchg.new2")) };
      case "pinchg.run":
        return { effect: { t: "pinChange", pin: v.pin ?? "", newPin: v.newPin ?? "" } };
      case "lang.pick":
        return { screen: langMenu(t(L, "acct.lang")) };
      case "lang.run":
        return { effect: { t: "setLang", lang: v.pick ?? L } };
      case "addr.run":
        return { effect: { t: "address" } };
      case "addr.show":
        return { screen: con(t(L, "addr.show", { address: v.address ?? "" })) };
      case "addr.ask":
        return { screen: con(v.note ?? t(L, "addr.ask")) };
      case "addr.pin":
        return { screen: pinPrompt(s) };
      case "addr.set":
        return { effect: { t: "setAlias", alias: v.alias ?? "", pin: v.pin ?? "" } };
      case "lim.run":
        return { effect: { t: "limits" } };
      case "lim.show":
        return {
          screen: con(t(L, "lim.show", { tier: v.tier ?? 0, tx: fcfa(v.perTx ?? 0), day: fcfa(v.dayLeft ?? 0), month: fcfa(v.monthLeft ?? 0) })),
        };
    }
  }

  function inputRaw(s: S, raw: string): S {
    const L = s.lang;
    const v = s.v;
    const input = raw.trim();
    const home = (): S => go(s, "home");
    switch (s.at) {
      // onboarding
      case "onb.lang": {
        const lang = pickLang(input);
        return lang ? { ...go(s, "onb.pin1"), lang } : s;
      }
      case "onb.pin1":
        // The digits-of-your-own-number rule needs the phone number, so the server checks that one at registration.
        return isWeakPin(input) ? go(s, "onb.pin1", { note: t(L, "onb.weak") }) : go(s, "onb.pin2", { pin1: input });
      case "onb.pin2":
        return input === v.pin1 ? go(s, "onb.name", { pin1: v.pin1 }) : go(s, "onb.pin1", { note: t(L, "onb.mismatch") });
      case "onb.name": {
        const name = input.replace(/\s+/g, " ");
        if (!NAME_RE.test(name)) return go(s, "onb.name", { pin1: v.pin1, note: t(L, "onb.badname") });
        return go(s, "onb.run", { pin1: v.pin1, name: clip(name, 16) });
      }

      // home
      case "home":
      case "home2": {
        if (input === "0") return go(s, s.at === "home" ? "home2" : "home");
        const first = s.at === "home";
        if (first && input === "1") return go(s, "bal.pin");
        if (first && input === "2") return go(s, "send.to");
        if (first && input === "3") return go(s, "recv.run");
        if (first && (input === "4" || input === "5" || input === "6")) return say(s, "soon");
        if (input === "7") return say(s, "soon");
        if (input === "8") return go(s, "hist.pin");
        if (input === "9") return go(s, "acct");
        return s;
      }

      // balance
      case "bal.pin":
        return go(s, "bal.run", { pin: input });
      case "bal.show":
        return home();

      // send
      case "send.to": {
        const to = input.replace(/[\s.\-()]/g, "");
        if (/^\d{6}$/.test(to)) return say(s, "soon"); // pay codes: phase 8
        if (!PHONE_RE.test(to)) return go(s, "send.to", { note: t(L, "send.badto") });
        return go(s, "send.resolve", { to });
      }
      case "send.amount": {
        const digits = input.replace(/\s/g, "");
        const amount = /^\d{1,7}$/.test(digits) ? Number(digits) : 0;
        const keep = { toRef: v.toRef, name: v.name, masked: v.masked };
        if (amount <= 0) return go(s, "send.amount", { ...keep, note: t(L, "amount.bad") });
        return go(s, "send.quote", { ...keep, fcfa: amount });
      }
      case "send.confirm":
        if (input === "1") return go(s, "send.pin", v);
        if (input === "2") return say(s, "cancelled");
        return s;
      case "send.pin":
        return go(s, "send.run", { toRef: v.toRef, name: v.name, masked: v.masked, fcfa: v.fcfa, sats: v.sats, pin: input });

      // receive
      case "recv.show":
        return input === "1" ? go(s, "recv.sms") : home();

      // history
      case "hist.pin":
        return go(s, "hist.run", { pin: input });
      case "hist.show":
        return input === "1" && v.more ? go(s, "hist.run", { page: (v.page ?? 0) + 1 }) : home();

      // account
      case "acct":
        if (input === "1") return go(s, "acct.pin");
        if (input === "2") return go(s, "lang.pick");
        if (input === "3") return go(s, "addr.run");
        if (input === "4" || input === "6") return say(s, "soon"); // guardians and the move to a smartphone: phases 9 and 8
        if (input === "5") return go(s, "lim.run");
        if (input === "0") return home();
        return s;
      case "acct.pin":
        if (input === "1") return go(s, "pinchg.old");
        if (input === "2") return say(s, "soon"); // reset through guardians: phase 9
        if (input === "0") return go(s, "acct");
        return s;
      case "pinchg.old":
        return go(s, "pinchg.new", { pin: input });
      case "pinchg.new":
        return isWeakPin(input) ? go(s, "pinchg.new", { pin: v.pin, note: t(L, "onb.weak") }) : go(s, "pinchg.new2", { pin: v.pin, newPin: input });
      case "pinchg.new2":
        return input === v.newPin ? go(s, "pinchg.run", { pin: v.pin, newPin: v.newPin }) : go(s, "pinchg.new", { pin: v.pin, note: t(L, "onb.mismatch") });
      case "lang.pick": {
        const lang = pickLang(input);
        return lang ? go(s, "lang.run", { pick: lang }) : s;
      }
      case "addr.show":
        return input === "1" ? go(s, "addr.ask") : home();
      case "addr.ask": {
        const alias = input.toLowerCase();
        return ALIAS_RE.test(alias) ? go(s, "addr.pin", { alias }) : go(s, "addr.ask", { note: t(L, "addr.bad") });
      }
      case "addr.pin":
        return go(s, "addr.set", { alias: v.alias, pin: input });
      case "lim.show":
        return home();

      default:
        return s; // effect steps and the closing screen take no input
    }
  }

  function resultRaw(s: S, r: Res): S {
    const L = s.lang;
    const v = s.v;
    const failed = (): S => fin(s, refusal(L, r));
    switch (s.at) {
      case "boot":
        if (!r.ok) return failed();
        if (!r.registered) return { ...go(s, "onb.lang"), q: [] };
        return { ...go(s, "home"), lang: r.lang ?? L, profile: { name: r.name ?? "", role: r.role ?? "user" } };

      case "onb.run":
        if (r.ok) return say(s, "onb.done", { address: r.address ?? "", code: cfg.code });
        if (r.err === "BAD_INPUT" && r.why === "weak") return go(s, "onb.pin1", { note: t(L, "onb.weak") });
        return failed();

      case "bal.run":
        if (r.ok) return go(s, "bal.show", { fcfa: r.fcfa, sats: r.sats, rate: r.rate });
        if (r.err === "PIN_WRONG") return go(s, "bal.pin", { left: r.left ?? 0 });
        return failed();

      case "send.resolve":
        if (r.ok) return go(s, "send.amount", { toRef: r.toRef, name: r.name, masked: r.masked });
        if (r.err === "BAD_INPUT") return go(s, "send.to", { note: t(L, r.why === "self" ? "send.self" : "send.badto") });
        if (r.err === "NOT_FOUND") return go(s, "send.to", { note: t(L, "send.notfound") });
        return failed();

      case "send.quote": {
        const keep = { toRef: v.toRef, name: v.name, masked: v.masked };
        if (r.ok) return go(s, "send.confirm", { ...keep, fcfa: v.fcfa, sats: r.sats });
        // The amount can be fixed by typing another one: say why, and ask again.
        if (r.err === "LIMIT" || r.err === "INSUFFICIENT_FUNDS") return go(s, "send.amount", { ...keep, note: `${refusal(L, r)}\n${t(L, "amount.ask")}` });
        return failed();
      }

      case "send.run":
        if (r.ok) return say(s, "send.done", { fcfa: fcfa(v.fcfa ?? 0), name: clip(v.name ?? "", 16), receipt: r.receipt ?? 0, balance: fcfa(r.balanceFcfa ?? 0) });
        if (r.err === "PIN_WRONG") return go(s, "send.pin", { toRef: v.toRef, name: v.name, masked: v.masked, fcfa: v.fcfa, sats: v.sats, left: r.left ?? 0 });
        return failed();

      case "recv.run":
        return r.ok ? go(s, "recv.show", { address: r.address }) : failed();
      case "recv.sms":
        return r.ok ? say(s, "recv.sent") : failed();

      case "hist.run":
        if (r.ok) {
          const items = r.items ?? [];
          if (items.length === 0 && (v.page ?? 0) === 0) return say(s, "hist.empty");
          return go(s, "hist.show", { items: items.slice(0, HISTORY_LINES), more: r.more === true, page: v.page ?? 0 });
        }
        if (r.err === "PIN_WRONG") return go(s, "hist.pin", { left: r.left ?? 0 });
        return failed();

      case "pinchg.run":
        if (r.ok) return say(s, "pinchg.done");
        if (r.err === "PIN_WRONG") return go(s, "pinchg.old", { left: r.left ?? 0 });
        if (r.err === "BAD_INPUT" && r.why === "weak") return go(s, "pinchg.old", { note: `${t(L, "onb.weak").split("\n")[0]}\n${t(L, "pinchg.old")}` });
        return failed();

      case "lang.run": {
        if (!r.ok) return failed();
        const lang = r.lang ?? v.pick ?? L;
        return fin({ ...s, lang }, t(lang, "lang.done"));
      }

      case "addr.run":
        return r.ok ? go(s, "addr.show", { address: r.address }) : failed();
      case "addr.set":
        if (r.ok) return say(s, "addr.done", { address: r.address ?? "" });
        if (r.err === "PIN_WRONG") return go(s, "addr.pin", { alias: v.alias, left: r.left ?? 0 });
        if (r.err === "BAD_INPUT") return go(s, "addr.ask", { note: t(L, "addr.bad") });
        return failed();

      case "lim.run":
        return r.ok ? go(s, "lim.show", { tier: r.tier, perTx: r.perTxFcfa, dayLeft: r.dayLeftFcfa, monthLeft: r.monthLeftFcfa }) : failed();

      default:
        return fin(s, t(L, "err.generic"));
    }
  }

  /**
   * Feed queued dial-string inputs for as long as the machine rests on an input screen.
   * Stops at an effect (its result comes back through onResult, which drains again), drops the queue
   * at a code prompt and at a closing screen, and drops it when an input did not move the menu.
   */
  function drain(start: S): S {
    let s = start;
    for (let i = 0; i <= MAX_QUEUE && s.q.length > 0; i++) {
      if (PIN_STEPS.has(s.at)) return { ...s, q: [] };
      const step = enterRaw(s);
      if ("effect" in step) return s;
      if (step.screen.end) return { ...s, q: [] };
      const [head, ...rest] = s.q;
      const next = inputRaw({ ...s, q: rest }, head ?? "");
      if (next.at === s.at) return { ...next, q: [] };
      s = next;
    }
    return s.q.length > 0 && !("effect" in enterRaw(s)) ? { ...s, q: [] } : s;
  }

  function resumePoint(s: S): S | null {
    const at = (to: At, v: V = {}): S => ({ at: to, lang: s.lang, profile: s.profile, v, q: [] });
    switch (s.at) {
      case "send.to":
        return at("send.to");
      case "send.amount":
        return at("send.amount", { toRef: s.v.toRef, name: s.v.name, masked: s.v.masked });
      case "send.confirm":
      case "send.pin":
        return at("send.confirm", { toRef: s.v.toRef, name: s.v.name, masked: s.v.masked, fcfa: s.v.fcfa, sats: s.v.sats });
      case "recv.show":
        return at("recv.show", { address: s.v.address });
      case "acct":
      case "acct.pin":
      case "pinchg.old":
      case "pinchg.new":
      case "pinchg.new2":
      case "lang.pick":
      case "addr.show":
      case "addr.ask":
      case "addr.pin":
        return at("acct");
      default:
        // Onboarding and the first menu are where a fresh dial starts anyway. A balance, a history page or
        // the limits already on screen are not shown again without the code.
        return null;
    }
  }

  return {
    initial: (ctx) => ({ at: "boot", lang: "fr", profile: null, v: {}, q: ctx.shortcut.slice(0, MAX_QUEUE) }),
    enter: enterRaw,
    onInput: (s, input) => drain(inputRaw(s, input)),
    onResult: (s, r) => drain(resultRaw(s, r)),
    resumePoint,
  };
}

/** What the runtime says on its own: session expired, service error, the offer to continue, and a step that ran out of time. */
export function runtimeTexts(code: string): (kind: TextKind, state: S | null) => string {
  return (kind, state) => {
    const lang = state?.lang ?? "fr";
    if (kind === "expired") return t(lang, "expired", { code });
    if (kind === "resume") return t(lang, "resume");
    // Only a send that is still running leads to an SMS. Promising one for a slow lookup would be a lie.
    if (kind === "busy" && state?.at === "send.run") return t(lang, "pending");
    return t(lang, "err.generic");
  };
}
