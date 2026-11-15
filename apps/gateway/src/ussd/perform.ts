// Runs the effects the menu machine asks for, by calling the services, and answers in the one result
// shape the machine understands: { ok: true, ...data } or { ok: false, err, ...data }.
// Contract:
//   - the caller of an effect is whoever owns the session's phone number. Nothing in an effect names
//     the sender, so one user can never act for another;
//   - the idempotency key of a money effect is ussd:<sessionId>:<effect name>: one session can complete
//     each kind of money effect once;
//   - errors the user can act on become a result. Anything else is thrown, and the runtime closes the
//     session with the generic message. An effect is never logged: it can carry a secret code.
// Callers: app.ts (given to UssdRuntime).
import { type Logger, isAppError, satsToFcfa, silentLogger } from "@melax/core";
import type { User, Users } from "../users.ts";
import type { Wallet } from "../wallet.ts";
import type { SmsOutbox } from "../smsout.ts";
import type { Agents } from "../escrow/agents.ts";
import type { Escrow, TradeResult, TradeView } from "../escrow/engine.ts";
import type { Rates } from "../rates.ts";
import type { Db } from "@melax/ledger";
import { t } from "@melax/i18n";
import type { Effect, Res, TradeInfo } from "./machine.ts";

export interface PerformDeps {
  db: Db;
  users: Users;
  wallet: Wallet;
  escrow: Escrow;
  agents: Agents;
  rates: Rates;
  outbox: SmsOutbox;
  log?: Logger;
}

export function createPerform(d: PerformDeps): (effect: Effect, session: { sessionId: string; phone: string }) => Promise<Res> {
  const log = d.log ?? silentLogger;

  async function run(e: Effect, session: { sessionId: string; phone: string }): Promise<Res> {
    if (e.t === "profile") {
      const u = await d.users.findByPhone(session.phone);
      return u ? { ok: true, registered: true, lang: u.lang, name: u.name, role: u.role } : { ok: true, registered: false };
    }
    if (e.t === "register") {
      const u = await d.users.register({ phone: session.phone, pin: e.pin, name: e.name, lang: e.lang });
      return { ok: true, address: d.users.addressOf(u) };
    }

    const user = await d.users.findByPhone(session.phone);
    if (!user) return { ok: false, err: "NOT_FOUND" };

    switch (e.t) {
      case "balance": {
        const pin = await d.users.checkPin(user.id, e.pin, "view");
        if (!pin.ok) return pin;
        return { ok: true, ...(await d.wallet.balance(user)) };
      }
      case "resolve":
        return d.wallet.resolve(user, e.to);
      case "quote":
        return d.wallet.quote(user, e.toRef, e.fcfa);
      case "send":
        return d.wallet.send({ user, toRef: e.toRef, fcfa: e.fcfa, sats: e.sats, pin: e.pin, idemKey: `ussd:${session.sessionId}:send` });
      case "receiveInfo":
      case "address":
        return { ok: true, address: d.users.addressOf(user) };
      case "receiveSms": {
        const phone = await d.users.phoneOf(user.id);
        await d.db.tx((tx) => d.outbox.queue(tx, { to: phone, kind: "address", body: t(user.lang, "sms.address", { address: d.users.addressOf(user) }) }));
        return { ok: true };
      }
      case "history": {
        // The first page needs the code. The machine only asks for a later page after showing the first in the same session.
        if (e.page === 0 || e.pin !== undefined) {
          const pin = await d.users.checkPin(user.id, e.pin ?? "", "view");
          if (!pin.ok) return pin;
        }
        return { ok: true, ...(await d.wallet.history(user, e.page)) };
      }
      case "pinChange":
        return d.users.changePin(user.id, e.pin, e.newPin);
      case "setLang":
        await d.users.setLang(user.id, e.lang);
        return { ok: true, lang: e.lang };
      case "setAlias":
        return d.users.setAlias(user.id, e.alias, e.pin);
      case "limits":
        return { ok: true, ...(await d.wallet.limitsView(user)) };

      // ----- agents: the user's side -----
      case "trade": {
        const tr = await d.escrow.openTradeOf(user);
        return { ok: true, trade: tr ? await info(tr, user, "user") : null };
      }
      case "offers":
        return { ok: true, offers: await d.escrow.offers(e.kind, user, e.fcfa) };
      case "cashin":
        return traded(await d.escrow.startCashin({ user, agentId: e.agentId, fcfa: e.fcfa, sats: e.sats, idemKey: `ussd:${session.sessionId}:cashin` }), user, "user");
      case "cashout":
        return traded(await d.escrow.startCashout({ user, agentId: e.agentId, fcfa: e.fcfa, sats: e.sats, pin: e.pin, idemKey: `ussd:${session.sessionId}:cashout` }), user, "user");
      case "tradeConfirm":
        return traded(await d.escrow.userConfirm({ user, tradeId: e.tradeId, pin: e.pin }), user, "user");
      case "dispute":
        return traded(await d.escrow.dispute({ user, tradeId: e.tradeId }), user, "user");
      case "tradeCancel":
        return traded(await d.escrow.cancel({ user, tradeId: e.tradeId }), user, "user");

      // ----- agents: the desk. Every effect here starts by checking the caller is an agent. -----
      case "desk":
      case "deskNext":
      case "deskAct":
      case "bond":
      case "bondAdd":
      case "bondOut":
      case "offer":
      case "offerToggle": {
        const agent = await d.agents.get(user.id);
        if (!agent) return { ok: false, err: "NOT_FOUND" };
        if (e.t === "desk") {
          const n = await d.escrow.deskCounts(user);
          return { ok: true, nIn: n.cashin, nOut: n.cashout };
        }
        if (e.t === "deskNext") {
          const tr = await d.escrow.nextFor(user, e.kind);
          return { ok: true, trade: tr ? await info(tr, user, "agent") : null };
        }
        if (e.t === "deskAct") {
          const a = { agent: user, tradeId: e.tradeId, pin: e.pin };
          const r = e.act === "confirm" ? await d.escrow.agentConfirm(a) : e.act === "sent" ? await d.escrow.agentSent(a) : await d.escrow.agentDecline(a);
          return traded(r, user, "agent");
        }
        if (e.t === "bond") {
          const rate = (await d.rates.get()).xofPerBtc;
          const bondSats = await d.agents.bondSats(user.id);
          return { ok: true, bondSats, bondFcfa: satsToFcfa(bondSats, rate), bondedSats: await d.agents.bondedSats(user.id) };
        }
        if (e.t === "bondAdd") {
          const r = await d.escrow.bondAdd({ agent: user, fcfa: e.fcfa, pin: e.pin, idemKey: `ussd:${session.sessionId}:bondAdd` });
          return r.ok ? { ok: true, sats: r.sats } : r;
        }
        if (e.t === "bondOut") {
          const r = await d.escrow.bondOut({ agent: user, pin: e.pin, idemKey: `ussd:${session.sessionId}:bondOut` });
          return r.ok ? { ok: true, sats: r.sats } : r;
        }
        if (e.t === "offer") return { ok: true, offer: { premiumBp: agent.premiumBp, method: agent.method, minFcfa: agent.minFcfa, maxFcfa: agent.maxFcfa, active: agent.active } };
        await d.agents.setActive(user.id, !agent.active);
        return { ok: true, active: !agent.active };
      }
    }
  }

  /** A trade for a screen. The other side's number is filled in only for the person who must send francs to it. */
  async function info(tr: TradeView, who: User, role: "user" | "agent"): Promise<TradeInfo> {
    let number = "";
    if (role === "user" && tr.kind === "cashin") number = (await d.escrow.agentNumberFor(who, tr.id)) ?? "";
    if (role === "agent" && tr.kind === "cashout") number = (await d.escrow.userNumberFor(who, tr.id)) ?? "";
    return { id: tr.id, ref: tr.ref, kind: tr.kind, state: tr.state, fcfa: tr.fcfa, sats: tr.sats, lockSats: tr.lockSats, method: tr.method, agent: tr.agentName, name: tr.userName, masked: tr.userMasked, number };
  }

  async function traded(r: TradeResult, who: User, role: "user" | "agent"): Promise<Res> {
    if (!r.ok) return r as Res;
    return { ok: true, trade: await info(r.trade, who, role) };
  }

  return async (effect, session) => {
    try {
      return await run(effect, session);
    } catch (err) {
      // What the user can do something about becomes a screen. The rest ends the session.
      if (isAppError(err, "PIN_WEAK")) return { ok: false, err: "BAD_INPUT", why: "weak" };
      if (isAppError(err, "BAD_INPUT") || isAppError(err, "BAD_PHONE") || isAppError(err, "BAD_AMOUNT")) return { ok: false, err: "BAD_INPUT" };
      if (isAppError(err, "BUSY")) return { ok: false, err: "BUSY" };
      log.error("ussd.effect_failed", { effect: effect.t, err });
      return { ok: false, err: "GENERIC" };
    }
  };
}
