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
import { type Logger, isAppError, silentLogger } from "@melax/core";
import type { Users } from "../users.ts";
import type { Wallet } from "../wallet.ts";
import type { SmsOutbox } from "../smsout.ts";
import type { Db } from "@melax/ledger";
import { t } from "@melax/i18n";
import type { Effect, Res } from "./machine.ts";

export interface PerformDeps {
  db: Db;
  users: Users;
  wallet: Wallet;
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
    }
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
