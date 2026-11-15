// Text messages coming in, after the webhook route has checked their signature.
// Contract:
//   - no command moves money out. A sender number can be spoofed, so the most a forged SMS gets is a
//     balance texted to the real owner of that number;
//   - a number with no account gets no answer at all: otherwise anyone could make this server text
//     any phone by forging a sender;
//   - one message id is handled once, and one account gets at most five answers in ten minutes.
// Commands that belong to later phases (BON, ARNAQUE, ANNULER, OUI) answer with the help text for now.
// Callers: http.ts (/sms/asg, /sms/httpsms).
import { type Clock, type Logger, MINUTE, isAppError, normalizePhone, silentLogger } from "@melax/core";
import { fcfa, sats, t } from "@melax/i18n";
import type { Db } from "@melax/ledger";
import { type InboundSms, parseCommand } from "@melax/sms";
import type { SmsOutbox } from "./smsout.ts";
import type { Users } from "./users.ts";
import type { Wallet } from "./wallet.ts";

const WINDOW_MS = 10 * MINUTE;
const MAX_REPLIES = 5;

export interface SmsInDeps {
  db: Db;
  clock: Clock;
  log?: Logger;
  users: Users;
  wallet: Wallet;
  outbox: SmsOutbox;
  code: string;
}

export class SmsInbound {
  private readonly d: SmsInDeps;
  private readonly log: Logger;
  private readonly seen = new Set<string>();
  private readonly replies = new Map<string, number[]>();

  constructor(deps: SmsInDeps) {
    this.d = deps;
    this.log = deps.log ?? silentLogger;
  }

  /** Returns what was done, for tests and logs: "replied", or the reason nothing was sent. */
  async handle(msg: InboundSms): Promise<"replied" | "duplicate" | "bad_sender" | "unknown_sender" | "rate_limited"> {
    if (msg.id) {
      if (this.seen.has(msg.id)) return "duplicate";
      this.seen.add(msg.id);
      if (this.seen.size > 20_000) this.seen.delete(this.seen.values().next().value as string);
    }
    let phone: string;
    try {
      phone = normalizePhone(msg.from);
    } catch (e) {
      if (isAppError(e, "BAD_PHONE")) return "bad_sender";
      throw e;
    }
    const user = await this.d.users.findByPhone(phone);
    if (!user) return "unknown_sender";

    const now = this.d.clock.now();
    const recent = (this.replies.get(user.id) ?? []).filter((at) => now - at < WINDOW_MS);
    if (recent.length >= MAX_REPLIES) {
      this.log.warn("sms.in.rate_limited", { user: user.id });
      return "rate_limited";
    }
    this.replies.set(user.id, [...recent, now]);
    if (this.replies.size > 20_000) this.replies.delete(this.replies.keys().next().value as string);

    const command = parseCommand(msg.text);
    let body: string;
    let kind: string;
    if (command.cmd === "balance") {
      const b = await this.d.wallet.balance(user);
      body = t(user.lang, "sms.balance", { fcfa: fcfa(b.fcfa), sats: sats(b.sats) });
      kind = "balance";
    } else {
      body = t(user.lang, "sms.help", { code: this.d.code });
      kind = "help";
    }
    await this.d.db.tx((tx) => this.d.outbox.queue(tx, { to: phone, body, kind }));
    this.log.info("sms.in", { user: user.id, command: command.cmd });
    return "replied";
  }
}
