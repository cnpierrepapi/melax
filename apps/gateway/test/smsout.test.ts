// The SMS outbox: queued inside the caller's transaction, sent later, sealed at rest.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppError, MINUTE } from "@melax/core";
import { type Db, truncateAll } from "@melax/ledger";
import { type TestApp, newDb, testApp } from "./helpers.ts";

const AWA = "+221771234567";
const MOUSSA = "+221781112233";

let db: Db;
let T: TestApp;

beforeAll(async () => {
  db = await newDb();
});
beforeEach(async () => {
  await truncateAll(db);
  T = testApp(db);
});
afterAll(async () => {
  await db?.close();
});

const queue = (to: string, body: string, app = T.app) => app.db.tx((tx) => app.outbox.queue(tx, { to, body, kind: "test" }));

describe("queueing", () => {
  it("keeps the number and the text sealed: a dump of the table shows neither", async () => {
    await queue(AWA, "Melax: bon de 5 000 F. Code: K7MP-2XQR-9TWB-4HNC.");
    const rows = await db.query<Record<string, unknown>>("SELECT * FROM sms_outbox");
    expect(rows).toHaveLength(1);
    const dump = Object.values(rows[0]!).map((v) => (Buffer.isBuffer(v) ? v.toString("latin1") + v.toString("hex") : String(v))).join("|");
    for (const secret of ["771234567", "K7MP", "5 000 F"]) expect(dump).not.toContain(secret);
    expect(rows[0]).toMatchObject({ status: "queued", kind: "test" });
  });

  it("refuses text that is not GSM-7 and stores nothing", async () => {
    await expect(queue(AWA, "Dépôt reçu")).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(await db.query("SELECT 1 FROM sms_outbox")).toHaveLength(0);
  });

  it("a message queued in a transaction that rolls back is never sent", async () => {
    await expect(
      db.tx(async (tx) => {
        await T.app.outbox.queue(tx, { to: AWA, body: "Melax: recu 500 F", kind: "test" });
        throw new AppError("INTERNAL", "the money part failed");
      }),
    ).rejects.toThrow();
    expect(await T.app.outbox.flush()).toMatchObject({ sent: 0 });
    expect(T.sms.sent).toEqual([]);
  });

  it("lists one number's messages only, oldest first", async () => {
    await queue(AWA, "un");
    await queue(MOUSSA, "deux");
    await queue(AWA, "trois");
    expect((await T.app.outbox.list(AWA)).map((m) => m.body)).toEqual(["un", "trois"]);
    expect((await T.app.outbox.list("771234567")).map((m) => m.body)).toEqual(["un", "trois"]);
  });
});

describe("sending", () => {
  it("hands each message to the adapter once, in order", async () => {
    await queue(AWA, "un");
    await queue(MOUSSA, "deux");
    expect(await T.app.outbox.flush()).toEqual({ sent: 2, retry: 0, failed: 0 });
    expect(T.sms.sent).toEqual([{ to: AWA, body: "un" }, { to: MOUSSA, body: "deux" }]);
    expect(await T.app.outbox.flush()).toEqual({ sent: 0, retry: 0, failed: 0 });
    expect(T.sms.sent).toHaveLength(2);
  });

  it("outside demo mode the text is deleted once it has been sent", async () => {
    const live = testApp(db, { env: { MELAX_DEMO: "0", SMS_ADAPTER: "asg", ASG_URL: "http://192.168.1.10:8080", ASG_USER: "u", ASG_PASSWORD: "p" } });
    await queue(AWA, "Melax: code K7MP-2XQR-9TWB-4HNC", live.app);
    await live.app.outbox.flush();
    expect(live.sms.sent).toHaveLength(1);
    expect(await db.query("SELECT 1 FROM sms_outbox WHERE status = 'sent' AND body_sealed IS NULL")).toHaveLength(1);
    expect((await live.app.outbox.list(AWA))[0]).toMatchObject({ status: "sent", body: null });
  });

  it("in demo mode the text is kept so the simulator can show it", async () => {
    await queue(AWA, "un");
    await T.app.outbox.flush();
    expect((await T.app.outbox.list(AWA))[0]).toMatchObject({ status: "sent", body: "un" });
  });

  it("a gateway that is down is tried again later, with longer waits, then given up on", async () => {
    let up = false;
    const realSend = T.sms.send.bind(T.sms);
    let calls = 0;
    T.sms.send = async (to, body) => {
      calls++;
      if (!up) throw new AppError("UPSTREAM", "sms gateway unreachable: connect ECONNREFUSED 192.168.1.10:8080");
      return realSend(to, body);
    };
    await queue(AWA, "un");
    expect(await T.app.outbox.flush()).toEqual({ sent: 0, retry: 1, failed: 0 });
    expect(await T.app.outbox.flush()).toEqual({ sent: 0, retry: 0, failed: 0 }); // too soon: not tried again
    expect(calls).toBe(1);
    T.clock.advance(MINUTE);
    up = true;
    expect(await T.app.outbox.flush()).toEqual({ sent: 1, retry: 0, failed: 0 });
    expect(T.sms.sent).toEqual([{ to: AWA, body: "un" }]);

    up = false;
    await queue(MOUSSA, "deux");
    let failed = 0;
    for (let i = 0; i < 12 && failed === 0; i++) {
      failed = (await T.app.outbox.flush()).failed;
      T.clock.advance(15 * MINUTE);
    }
    expect(failed).toBe(1);
    const row = (await db.query<{ status: string; attempts: number; error: string }>("SELECT status, attempts, error FROM sms_outbox WHERE status = 'failed'"))[0]!;
    expect(row).toMatchObject({ status: "failed", attempts: 8, error: "UPSTREAM" });
    T.clock.advance(60 * MINUTE);
    expect(await T.app.outbox.flush()).toEqual({ sent: 0, retry: 0, failed: 0 });
  });

  it("writes no number and no text to the log, even when sending fails", async () => {
    T.sms.send = async () => {
      throw new AppError("UPSTREAM", "could not deliver to +221771234567: Melax: recu 500 F de Moussa");
    };
    await queue(AWA, "Melax: recu 500 F de Moussa");
    await T.app.outbox.flush();
    const log = T.logs.join("\n");
    expect(T.logs.length).toBeGreaterThan(0);
    for (const secret of ["771234567", "recu 500 F", "Moussa"]) expect(log).not.toContain(secret);
  });
});
