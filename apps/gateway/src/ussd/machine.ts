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
import { LANGS, LANG_NAMES, type Lang, type MessageKey, clip, fcfa, methodName, sats, shortDate, t } from "@melax/i18n";
import { feeCapSat } from "@melax/lightning";
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
  | { t: "limits" }
  // agents (phase 6)
  | { t: "trade" }
  | { t: "offers"; kind: TradeKind; fcfa: number }
  | { t: "cashin"; agentId: string; fcfa: number; sats: number }
  | { t: "cashout"; agentId: string; fcfa: number; sats: number; pin: string }
  | { t: "tradeConfirm"; tradeId: string; pin: string }
  | { t: "dispute"; tradeId: string }
  | { t: "tradeCancel"; tradeId: string }
  | { t: "desk" }
  | { t: "deskNext"; kind: TradeKind }
  | { t: "deskAct"; act: DeskAct; tradeId: string; pin: string }
  | { t: "bond" }
  | { t: "bondAdd"; fcfa: number; pin: string }
  | { t: "bondOut"; pin: string }
  | { t: "offer" }
  | { t: "offerToggle" };

export type TradeKind = "cashin" | "cashout";
export type DeskAct = "confirm" | "sent" | "decline";

/** A trade as the menus show it. `number` is the other side's mobile-money number, only where that person needs it. */
export interface TradeInfo {
  id: string;
  ref: string;
  kind: TradeKind;
  state: string;
  fcfa: number;
  sats: number;
  lockSats: number;
  method: string;
  agent: string;
  name: string;
  masked: string;
  number: string;
}

export interface OfferInfo {
  agentId: string;
  name: string;
  method: string;
  sats: number;
}

export type Err =
  | "PIN_WRONG" | "PIN_LOCKED" | "INSUFFICIENT_FUNDS" | "LIMIT" | "BUSY" | "PAUSED" | "FROZEN" | "NOT_FOUND" | "BAD_INPUT" | "PENDING" | "REPORTED" | "GENERIC"
  | "RANGE" | "AGENT_OFF" | "SELF" | "OPEN_TRADE" | "BOND" | "STATE" | "UNAVAILABLE";
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
  trade?: TradeInfo | null;
  offers?: OfferInfo[];
  nIn?: number;
  nOut?: number;
  /** The bond, and the sats of open cash-ins that lean on it. */
  bondSats?: number;
  bondFcfa?: number;
  bondedSats?: number;
  offer?: { premiumBp: number; method: string; minFcfa: number; maxFcfa: number; active: boolean };
  active?: boolean;
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
  | "lim.run" | "lim.show"
  // cash-in (5) and cash-out (6): the user's side
  | "dep.check" | "dep.amount" | "dep.offers" | "dep.pick" | "dep.confirm" | "dep.run" | "dep.view"
  | "wd.check" | "wd.amount" | "wd.offers" | "wd.pick" | "wd.confirm" | "wd.pin" | "wd.run" | "wd.view" | "wd.cpin" | "wd.crun"
  | "trade.dispute" | "trade.cancel"
  // the agent desk
  | "desk.run" | "desk"
  | "desk.in.run" | "desk.in" | "desk.in.pin" | "desk.in.act"
  | "desk.out.run" | "desk.out" | "desk.out.pin" | "desk.out.act"
  | "bond.run" | "bond.show" | "bond.amount" | "bond.pin" | "bond.add" | "bondout.pin" | "bond.out"
  | "offer.run" | "offer.show" | "offer.toggle";

/** Steps whose input is a secret code. The dial-string queue is dropped at each, and none is ever a resume point. */
export const PIN_STEPS: ReadonlySet<At> = new Set<At>([
  "onb.pin1", "onb.pin2", "bal.pin", "send.pin", "hist.pin", "pinchg.old", "pinchg.new", "pinchg.new2", "addr.pin",
  "wd.pin", "wd.cpin", "desk.in.pin", "desk.out.pin", "bond.pin", "bondout.pin",
]);

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
  agentId?: string;
  method?: string;
  offers?: OfferInfo[];
  trade?: TradeInfo;
  act?: DeskAct;
  nIn?: number;
  nOut?: number;
  bondSats?: number;
  bondFcfa?: number;
  bondedSats?: number;
  offer?: Res["offer"];
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
    case "OPEN_TRADE":
      return t(lang, "err.open_trade");
    case "STATE":
      return t(lang, "trade.changed");
    // The agent list is drawn just before; any of these means the pick went stale in between.
    case "RANGE":
    case "AGENT_OFF":
    case "SELF":
    case "BOND":
      return t(lang, "agents.none");
    default:
      return t(lang, "err.generic");
  }
}

/**
 * One agent on the pick screen: name, method, and the sats of this trade. Three fit on one screen with the
 * longest name, "Orange Money" and nine-digit sats only if the name is cut at 9 characters.
 */
function offerLine(o: OfferInfo): string {
  return `${clip(o.name, 9)} (${methodName(o.method)}) ${sats(o.sats)}`;
}

/** Where a user's open trade is shown. Each state has one screen; only the ones that wait for the user take input. */
function tradeScreen(s: S, tr: TradeInfo): S {
  if (tr.kind === "cashin" && tr.state === "held") return go(s, "dep.view", { trade: tr });
  if (tr.kind === "cashin" && tr.state === "open") return say(s, "dep.wait", { ref: tr.ref });
  if (tr.kind === "cashout" && (tr.state === "locked" || tr.state === "sent")) return go(s, "wd.view", { trade: tr });
  if (tr.state === "disputed" || tr.state === "released") return say(s, "trade.disputed", { ref: tr.ref });
  return say(s, "trade.busy", { ref: tr.ref });
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
      case "home2": {
        // The agent desk is in the menu of agents only.
        const desk: Array<[string, string]> = s.profile?.role === "agent" ? [["4", t(L, "m.agent")]] : [];
        return { screen: menu(t(L, "home.title"), [...desk, ["7", t(L, "m.vouchers")], ["8", t(L, "m.history")], ["9", t(L, "m.account")], ["0", t(L, "m.back")]]) };
      }

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

      // cash-in and cash-out, the user's side
      case "dep.check":
      case "wd.check":
        return { effect: { t: "trade" } };
      case "dep.amount":
      case "wd.amount":
        return { screen: con(v.note ?? t(L, "amount.ask")) };
      case "dep.offers":
      case "wd.offers":
        return { effect: { t: "offers", kind: s.at === "dep.offers" ? "cashin" : "cashout", fcfa: v.fcfa ?? 0 } };
      case "dep.pick":
      case "wd.pick":
        return { screen: menu(t(L, "agents.pick"), [...(v.offers ?? []).map((o, i) => [String(i + 1), offerLine(o)] as [string, string]), ["0", t(L, "m.back")]]) };
      case "dep.confirm":
        return { screen: con(t(L, "dep.confirm", { fcfa: fcfa(v.fcfa ?? 0), agent: clip(v.name ?? "", 16), method: methodName(v.method ?? ""), sats: sats(v.sats ?? 0) })) };
      case "dep.run":
        return { effect: { t: "cashin", agentId: v.agentId ?? "", fcfa: v.fcfa ?? 0, sats: v.sats ?? 0 } };
      case "dep.view": {
        const tr = v.trade!;
        return { screen: con(t(L, "dep.open", { ref: tr.ref, fcfa: fcfa(tr.fcfa), method: methodName(tr.method), number: tr.number, agent: clip(tr.agent, 16) })) };
      }
      case "wd.confirm": {
        // What locks is the sats plus the most the pay-out's Lightning fee may take. What the fee does not use comes back.
        const lock = (v.sats ?? 0) + feeCapSat(v.sats ?? 0);
        return { screen: con(t(L, "wd.confirm", { fcfa: fcfa(v.fcfa ?? 0), agent: clip(v.name ?? "", 16), method: methodName(v.method ?? ""), sats: sats(lock) })) };
      }
      case "wd.pin":
      case "wd.cpin":
        return { screen: pinPrompt(s) };
      case "wd.run":
        return { effect: { t: "cashout", agentId: v.agentId ?? "", fcfa: v.fcfa ?? 0, sats: v.sats ?? 0, pin: v.pin ?? "" } };
      case "wd.view": {
        const tr = v.trade!;
        return { screen: con(t(L, "wd.pending", { ref: tr.ref, fcfa: fcfa(tr.fcfa), agent: clip(tr.agent, 16) })) };
      }
      case "wd.crun":
        return { effect: { t: "tradeConfirm", tradeId: v.trade?.id ?? "", pin: v.pin ?? "" } };
      case "trade.dispute":
        return { effect: { t: "dispute", tradeId: v.trade?.id ?? "" } };
      case "trade.cancel":
        return { effect: { t: "tradeCancel", tradeId: v.trade?.id ?? "" } };

      // the agent desk
      case "desk.run":
        return { effect: { t: "desk" } };
      case "desk":
        return {
          screen: menu(t(L, "m.agent"), [
            ["1", t(L, "agent.deposits", { n: v.nIn ?? 0 })],
            ["2", t(L, "agent.withdrawals", { n: v.nOut ?? 0 })],
            ["3", t(L, "agent.bond")],
            ["4", t(L, "agent.offer")],
            ["0", t(L, "m.back")],
          ]),
        };
      case "desk.in.run":
        return { effect: { t: "deskNext", kind: "cashin" } };
      case "desk.out.run":
        return { effect: { t: "deskNext", kind: "cashout" } };
      case "desk.in": {
        const tr = v.trade!;
        return { screen: con(t(L, "agent.dep.ask", { ref: tr.ref, fcfa: fcfa(tr.fcfa), masked: tr.masked, method: methodName(tr.method) })) };
      }
      case "desk.out": {
        const tr = v.trade!;
        return { screen: con(t(L, "agent.wd.ask", { ref: tr.ref, fcfa: fcfa(tr.fcfa), method: methodName(tr.method), number: tr.number, name: clip(tr.name, 16) })) };
      }
      case "desk.in.pin":
      case "desk.out.pin":
      case "bond.pin":
      case "bondout.pin":
        return { screen: pinPrompt(s) };
      case "desk.in.act":
        return { effect: { t: "deskAct", act: "confirm", tradeId: v.trade?.id ?? "", pin: v.pin ?? "" } };
      case "desk.out.act":
        return { effect: { t: "deskAct", act: v.act ?? "sent", tradeId: v.trade?.id ?? "", pin: v.pin ?? "" } };
      case "bond.run":
        return { effect: { t: "bond" } };
      case "bond.show":
        return { screen: con(t(L, "agent.bond.show", { sats: sats(v.bondSats ?? 0), fcfa: fcfa(v.bondFcfa ?? 0), open: sats(v.bondedSats ?? 0) })) };
      case "bond.amount":
        return { screen: con(v.note ?? t(L, "agent.bond.ask")) };
      case "bond.add":
        return { effect: { t: "bondAdd", fcfa: v.fcfa ?? 0, pin: v.pin ?? "" } };
      case "bond.out":
        return { effect: { t: "bondOut", pin: v.pin ?? "" } };
      case "offer.run":
        return { effect: { t: "offer" } };
      case "offer.show": {
        const o = v.offer!;
        const dot = (o.premiumBp / 100).toFixed(o.premiumBp % 100 === 0 ? 0 : o.premiumBp % 10 === 0 ? 1 : 2);
        const premium = L === "en" ? dot : dot.replace(".", ","); // 1,5 % in French and Wolof
        return {
          screen: con(t(L, "agent.offer.show", { premium, methods: methodName(o.method), min: fcfa(o.minFcfa), max: fcfa(o.maxFcfa), state: t(L, o.active ? "agent.on" : "agent.off") })),
        };
      }
      case "offer.toggle":
        return { effect: { t: "offerToggle" } };
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
        if (first && input === "4") return say(s, "soon"); // pay a shop: phase 7
        if (first && input === "5") return go(s, "dep.check");
        if (first && input === "6") return go(s, "wd.check");
        if (!first && input === "4" && s.profile?.role === "agent") return go(s, "desk.run");
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

      // cash-in and cash-out, the user's side
      case "dep.amount":
      case "wd.amount": {
        const digits = input.replace(/\s/g, "");
        const amount = /^\d{1,7}$/.test(digits) ? Number(digits) : 0;
        if (amount <= 0) return go(s, s.at, { note: t(L, "amount.bad") });
        return go(s, s.at === "dep.amount" ? "dep.offers" : "wd.offers", { fcfa: amount });
      }
      case "dep.pick":
      case "wd.pick": {
        if (input === "0") return home();
        const o = (v.offers ?? [])[Number(input) - 1];
        if (!/^\d$/.test(input) || !o) return s;
        return go(s, s.at === "dep.pick" ? "dep.confirm" : "wd.confirm", { fcfa: v.fcfa, agentId: o.agentId, name: o.name, method: o.method, sats: o.sats });
      }
      case "dep.confirm":
        if (input === "1") return go(s, "dep.run", v);
        if (input === "2") return say(s, "cancelled");
        return s;
      case "wd.confirm":
        if (input === "1") return go(s, "wd.pin", v);
        if (input === "2") return say(s, "cancelled");
        return s;
      case "wd.pin":
        return go(s, "wd.run", { agentId: v.agentId, name: v.name, method: v.method, fcfa: v.fcfa, sats: v.sats, pin: input });
      case "dep.view":
        if (input === "1") return go(s, "trade.dispute", { trade: v.trade });
        if (input === "2") return go(s, "trade.cancel", { trade: v.trade });
        if (input === "0") return home();
        return s;
      case "wd.view":
        if (input === "1") return go(s, "wd.cpin", { trade: v.trade });
        if (input === "2") return say(s, "wd.wait");
        if (input === "3") return go(s, "trade.dispute", { trade: v.trade });
        return s;
      case "wd.cpin":
        return go(s, "wd.crun", { trade: v.trade, pin: input });

      // the agent desk
      case "desk":
        if (input === "1") return go(s, "desk.in.run");
        if (input === "2") return go(s, "desk.out.run");
        if (input === "3") return go(s, "bond.run");
        if (input === "4") return go(s, "offer.run");
        if (input === "0") return home();
        return s;
      case "desk.in":
        if (input === "1") return go(s, "desk.in.pin", { trade: v.trade });
        if (input === "2") return say(s, "agent.dep.no", { ref: v.trade?.ref ?? "" });
        return s;
      case "desk.in.pin":
        return go(s, "desk.in.act", { trade: v.trade, pin: input });
      case "desk.out":
        if (input === "1") return go(s, "desk.out.pin", { trade: v.trade, act: "sent" });
        if (input === "2") return go(s, "desk.out.pin", { trade: v.trade, act: "decline" });
        return s;
      case "desk.out.pin":
        return go(s, "desk.out.act", { trade: v.trade, act: v.act, pin: input });
      case "bond.show":
        if (input === "1") return go(s, "bond.amount");
        if (input === "2") return go(s, "bondout.pin");
        return home();
      case "bond.amount": {
        const digits = input.replace(/\s/g, "");
        const amount = /^\d{1,7}$/.test(digits) ? Number(digits) : 0;
        if (amount <= 0) return go(s, "bond.amount", { note: t(L, "amount.bad") });
        return go(s, "bond.pin", { fcfa: amount });
      }
      case "bond.pin":
        return go(s, "bond.add", { fcfa: v.fcfa, pin: input });
      case "bondout.pin":
        return go(s, "bond.out", { pin: input });
      case "offer.show":
        return input === "1" ? go(s, "offer.toggle") : home();

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

      // cash-in and cash-out, the user's side
      case "dep.check":
      case "wd.check":
        if (!r.ok) return failed();
        // One open trade per user: whichever entry was pressed, an open trade is shown first.
        if (r.trade) return tradeScreen(s, r.trade);
        return go(s, s.at === "dep.check" ? "dep.amount" : "wd.amount");
      case "dep.offers":
      case "wd.offers":
        if (!r.ok) return failed();
        if ((r.offers ?? []).length === 0) return say(s, "agents.none");
        return go(s, s.at === "dep.offers" ? "dep.pick" : "wd.pick", { fcfa: v.fcfa, offers: (r.offers ?? []).slice(0, 3) });
      case "dep.run": {
        if (!r.ok || !r.trade) return failed();
        const tr = r.trade;
        if (tr.state !== "held") return say(s, "dep.wait", { ref: tr.ref });
        return say(s, "dep.done", { fcfa: fcfa(tr.fcfa), method: methodName(tr.method), number: tr.number, agent: clip(tr.agent, 16), ref: tr.ref });
      }
      case "wd.run": {
        if (r.err === "PIN_WRONG") return go(s, "wd.pin", { agentId: v.agentId, name: v.name, method: v.method, fcfa: v.fcfa, sats: v.sats, left: r.left ?? 0 });
        if (!r.ok || !r.trade) return failed();
        const tr = r.trade;
        if (tr.state !== "locked") return say(s, "trade.busy", { ref: tr.ref });
        return say(s, "wd.done", { ref: tr.ref, agent: clip(tr.agent, 16), fcfa: fcfa(tr.fcfa), method: methodName(tr.method) });
      }
      case "wd.crun":
        if (r.err === "PIN_WRONG") return go(s, "wd.cpin", { trade: v.trade, left: r.left ?? 0 });
        if (!r.ok || !r.trade) return failed();
        return r.trade.state === "done" ? say(s, "wd.confirmed", { ref: r.trade.ref }) : say(s, "trade.busy", { ref: r.trade.ref });
      case "trade.dispute":
        return r.ok && r.trade ? say(s, "dispute.opened", { ref: r.trade.ref }) : failed();
      case "trade.cancel":
        return r.ok && r.trade ? say(s, "cancelled") : failed();

      // the agent desk
      case "desk.run":
        return r.ok ? go(s, "desk", { nIn: r.nIn ?? 0, nOut: r.nOut ?? 0 }) : failed();
      case "desk.in.run":
      case "desk.out.run":
        if (!r.ok) return failed();
        if (!r.trade) return say(s, "agent.none");
        return go(s, s.at === "desk.in.run" ? "desk.in" : "desk.out", { trade: r.trade });
      case "desk.in.act":
        if (r.err === "PIN_WRONG") return go(s, "desk.in.pin", { trade: v.trade, left: r.left ?? 0 });
        if (!r.ok || !r.trade) return failed();
        return r.trade.state === "done" ? say(s, "agent.dep.done", { ref: r.trade.ref, sats: sats(r.trade.sats) }) : say(s, "trade.busy", { ref: r.trade.ref });
      case "desk.out.act":
        if (r.err === "PIN_WRONG") return go(s, "desk.out.pin", { trade: v.trade, act: v.act, left: r.left ?? 0 });
        if (!r.ok || !r.trade) return failed();
        return v.act === "decline" ? say(s, "agent.wd.refused", { ref: r.trade.ref }) : say(s, "agent.wd.done");
      case "bond.run":
        return r.ok ? go(s, "bond.show", { bondSats: r.bondSats, bondFcfa: r.bondFcfa, bondedSats: r.bondedSats }) : failed();
      case "bond.add":
        if (r.err === "PIN_WRONG") return go(s, "bond.pin", { fcfa: v.fcfa, left: r.left ?? 0 });
        return r.ok ? say(s, "agent.bond.added", { sats: sats(r.sats ?? 0) }) : failed();
      case "bond.out":
        if (r.err === "PIN_WRONG") return go(s, "bondout.pin", { left: r.left ?? 0 });
        if (r.err === "OPEN_TRADE") return say(s, "agent.bond.locked");
        return r.ok ? say(s, "agent.bond.out", { sats: sats(r.sats ?? 0) }) : failed();
      case "offer.run":
        return r.ok && r.offer ? go(s, "offer.show", { offer: r.offer }) : failed();
      case "offer.toggle":
        return r.ok ? say(s, r.active ? "agent.on" : "agent.off") : failed();

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
      // A trade's confirm screen again. Screens that show a trade already open are not kept: the trade
      // may have moved on since, and a fresh dial of 5 or 6 shows where it is now.
      case "dep.confirm":
        return at("dep.confirm", { fcfa: s.v.fcfa, agentId: s.v.agentId, name: s.v.name, method: s.v.method, sats: s.v.sats });
      case "wd.confirm":
      case "wd.pin":
        return at("wd.confirm", { fcfa: s.v.fcfa, agentId: s.v.agentId, name: s.v.name, method: s.v.method, sats: s.v.sats });
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
    // Only a money step that is still running leads to an SMS. Promising one for a slow lookup would be a lie.
    if (kind === "busy" && (state?.at === "send.run" || state?.at === "dep.run" || state?.at === "wd.run" || state?.at === "wd.crun" || state?.at === "desk.in.act")) return t(lang, "pending");
    return t(lang, "err.generic");
  };
}
