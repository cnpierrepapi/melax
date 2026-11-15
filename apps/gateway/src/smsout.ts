// The SMS outbox. A message is queued inside the transaction that caused it, so a receipt exists
// exactly when its money movement does. A timer sends what is queued.
// Contract:
//   - the number and the text are sealed at rest (the text can hold a voucher code). After a real send
//     the text is deleted. In demo mode it is kept, so the web simulator can show the message;
//   - text that is not GSM-7 is refused when it is queued, not when it is sent;
//   - a failed send is tried again with longer waits, eight times, then marked failed;
//   - nothing here logs a number or a text.
// Callers: users.ts, wallet.ts, smsin.ts (queue), main.ts (flush on a timer), tests and the simulator (list).
import { AppError, type Clock, type Logger, MINUTE, SECOND, isAppError, normalizePhone, silentLogger, toSafeInt } from "@melax/core";
import { open, phoneLookupKey, seal } from "@melax/crypto";
import type { Db } from "@melax/ledger";
import { type SmsAdapter, assertGsm7 } from "@melax/sms";

export const MAX_ATTEMPTS = 8;
const backoffMs = (attempts: number): number => Math.min(5 * SECOND * 2 ** (attempts - 1), 10 * MINUTE);

export interface OutboxItem {
  id: number;
  kind: string;
  status: "queued" | "sent" | "failed";
  /** Null once the text has been deleted after a real send. */
  body: string | null;
  createdAt: number;
}

export interface OutboxDeps {
  db: Db;
  clock: Clock;
  log?: Logger;
  adapter: SmsAdapter;
  /** Keys derived from the server pepper: one for lookups by number, one for sealing. */
  phoneKey: Buffer;
  dataKey: Buffer;
  keepBodies: boolean;
}

export class SmsOutbox {
  private readonly d: OutboxDeps;
  private readonly log: Logger;
  private flushing = false;

  constructor(deps: OutboxDeps) {
    this.d = deps;
    this.log = deps.log ?? silentLogger;
  }

  /** Call with the transaction handle of the change this message reports. `to` is E.164. */
  async queue(tx: Db, m: { to: string; body: string; kind: string }): Promise<void> {
    assertGsm7(m.body);
    if (m.body.length === 0) throw new AppError("BAD_INPUT", "empty SMS");
    const to = normalizePhone(m.to);
    await tx.query("INSERT INTO sms_outbox (to_hmac, to_sealed, body_sealed, kind, status, created_at) VALUES ($1, $2, $3, $4, 'queued', $5)", [
      phoneLookupKey(to, this.d.phoneKey),
      seal(this.d.dataKey, Buffer.from(to, "utf8"), "sms:to"),
      seal(this.d.dataKey, Buffer.from(m.body, "utf8"), "sms:body"),
      m.kind,
      this.d.clock.now(),
    ]);
  }

  /** Send what is due. Safe to call from a timer: a second call while one is running does nothing. */
  async flush(limit = 25): Promise<{ sent: number; retry: number; failed: number }> {
    const out = { sent: 0, retry: 0, failed: 0 };
    if (this.flushing) return out;
    this.flushing = true;
    try {
      const due = await this.d.db.query<{ id: number; to_sealed: Buffer; body_sealed: Buffer | null; attempts: number }>(
        "SELECT id, to_sealed, body_sealed, attempts FROM sms_outbox WHERE status = 'queued' AND next_at <= $1 ORDER BY id LIMIT $2",
        [this.d.clock.now(), limit],
      );
      for (const row of due) {
        const id = toSafeInt(row.id);
        const attempts = toSafeInt(row.attempts) + 1;
        try {
          if (!row.body_sealed) throw new AppError("INTERNAL", "queued message has no text");
          const to = open(this.d.dataKey, Buffer.from(row.to_sealed), "sms:to").toString("utf8");
          const body = open(this.d.dataKey, Buffer.from(row.body_sealed), "sms:body").toString("utf8");
          await this.d.adapter.send(to, body);
          await this.d.db.query(`UPDATE sms_outbox SET status = 'sent', sent_at = $2, adapter = $3, attempts = $4, error = NULL${this.d.keepBodies ? "" : ", body_sealed = NULL"} WHERE id = $1`, [
            id,
            this.d.clock.now(),
            this.d.adapter.name,
            attempts,
          ]);
          out.sent++;
        } catch (e) {
          // Only the error code is kept: an adapter's message can quote the number or the text.
          const code = isAppError(e) ? e.code : "INTERNAL";
          const giveUp = attempts >= MAX_ATTEMPTS;
          await this.d.db.query("UPDATE sms_outbox SET status = $2, attempts = $3, next_at = $4, error = $5, adapter = $6 WHERE id = $1", [
            id,
            giveUp ? "failed" : "queued",
            attempts,
            this.d.clock.now() + backoffMs(attempts),
            code,
            this.d.adapter.name,
          ]);
          if (giveUp) out.failed++;
          else out.retry++;
          this.log.warn(giveUp ? "sms.failed" : "sms.retry", { sms: id, attempts, errCode: code });
        }
      }
      return out;
    } finally {
      this.flushing = false;
    }
  }

  /** One number's messages, oldest first. For the web simulator in demo mode and for tests. */
  async list(phone: string, limit = 50): Promise<OutboxItem[]> {
    const rows = await this.d.db.query<{ id: number; kind: string; status: OutboxItem["status"]; body_sealed: Buffer | null; created_at: number }>(
      "SELECT id, kind, status, body_sealed, created_at FROM (SELECT * FROM sms_outbox WHERE to_hmac = $1 ORDER BY id DESC LIMIT $2) recent ORDER BY id",
      [phoneLookupKey(normalizePhone(phone), this.d.phoneKey), limit],
    );
    return rows.map((r) => ({
      id: toSafeInt(r.id),
      kind: r.kind,
      status: r.status,
      body: r.body_sealed ? open(this.d.dataKey, Buffer.from(r.body_sealed), "sms:body").toString("utf8") : null,
      createdAt: toSafeInt(r.created_at),
    }));
  }
}
