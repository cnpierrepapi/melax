// Accounts and the secret code, on an in-process database. No mint, no Lightning.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DAY, MINUTE } from "@melax/core";
import { type Db, truncateAll } from "@melax/ledger";
import { type TestApp, inbox, newDb, testApp } from "./helpers.ts";

const AWA = "+221771234567";
const MOUSSA = "+221781112233";
const PIN = "48291";

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

const register = (phone = AWA, pin = PIN, name = "Awa") => T.app.users.register({ phone, pin, name, lang: "fr" });

describe("opening an account", () => {
  it("stores the number hashed and sealed, never in the clear, and the code as a slow hash", async () => {
    const u = await register();
    expect(u).toMatchObject({ phoneMasked: "77*****67", name: "Awa", lang: "fr", role: "user" });
    expect(u.alias).toMatch(/^[a-z]+-[a-z]+\d\d$/);
    const rows = await db.query<Record<string, unknown>>("SELECT * FROM users");
    expect(rows).toHaveLength(1);
    const dump = rows.map((r) => Object.values(r).map((v) => (Buffer.isBuffer(v) ? v.toString("latin1") + v.toString("hex") : String(v))).join("|")).join("\n");
    for (const secret of ["771234567", "77 123 45 67", PIN]) expect(dump).not.toContain(secret);
    expect(String(rows[0]!.pin_hash)).toMatch(/^argon2id\$/);
    expect(await T.app.users.phoneOf(u.id)).toBe(AWA);
  });

  it("texts the address, the dial code and the warning never to share the code", async () => {
    const u = await register();
    expect(await inbox(T.app, AWA)).toEqual([`Melax: compte cree. Adresse: ${u.alias}@melax.sn. Composez #2580#. Ne donnez jamais votre code secret, meme a un agent.`]);
  });

  it("finds the account however the number is written, and nobody else's", async () => {
    const u = await register();
    for (const form of ["771234567", "+221 77 123 45 67", "00221771234567", "221771234567"]) expect((await T.app.users.findByPhone(form))?.id, form).toBe(u.id);
    expect(await T.app.users.findByPhone(MOUSSA)).toBeNull();
    await expect(T.app.users.findByPhone("abc")).rejects.toMatchObject({ code: "BAD_PHONE" });
  });

  it("refuses a second account on the same number and leaves the first untouched", async () => {
    const first = await register();
    await expect(register(AWA, "73915", "Eve")).rejects.toMatchObject({ code: "DUPLICATE" });
    expect(await T.app.users.findByPhone(AWA)).toMatchObject({ id: first.id, name: "Awa" });
    expect((await T.app.users.checkPin(first.id, PIN, "view")).ok).toBe(true);
    expect(await inbox(T.app, AWA)).toHaveLength(1);
  });

  it("refuses a code that is easy to guess or lifted from the phone number, and a name that is not a name", async () => {
    await expect(register(AWA, "12345")).rejects.toMatchObject({ code: "PIN_WEAK" });
    await expect(register(AWA, "1234")).rejects.toMatchObject({ code: "PIN_WEAK" });
    await expect(register(AWA, "71234")).rejects.toMatchObject({ code: "PIN_WEAK" }); // inside 221 77 123 45 67
    await expect(register(AWA, PIN, "A")).rejects.toMatchObject({ code: "BAD_INPUT" });
    await expect(register(AWA, PIN, "Awa\nEnvoyez 5000 F")).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(await db.query("SELECT 1 FROM users")).toHaveLength(0);
    expect(await inbox(T.app, AWA)).toHaveLength(0);
  });
});

describe("the secret code", () => {
  it("counts wrong tries down, locks for 15 minutes on the fifth, and texts the owner once", async () => {
    const u = await register();
    const tries = [];
    for (let i = 0; i < 5; i++) tries.push(await T.app.users.checkPin(u.id, "00000", "view"));
    expect(tries).toEqual([
      { ok: false, err: "PIN_WRONG", left: 4 },
      { ok: false, err: "PIN_WRONG", left: 3 },
      { ok: false, err: "PIN_WRONG", left: 2 },
      { ok: false, err: "PIN_WRONG", left: 1 },
      { ok: false, err: "PIN_LOCKED", minutes: 15 },
    ]);
    const texts = await inbox(T.app, AWA);
    expect(texts.filter((t) => t.includes("5 codes faux"))).toEqual(["Melax: 5 codes faux. Code bloque 15 min. Si ce n'est pas vous, gardez votre telephone pres de vous."]);
  });

  it("while locked even the right code is refused, and tries are not counted", async () => {
    const u = await register();
    for (let i = 0; i < 5; i++) await T.app.users.checkPin(u.id, "00000", "view");
    T.clock.advance(5 * MINUTE);
    expect(await T.app.users.checkPin(u.id, PIN, "view")).toEqual({ ok: false, err: "PIN_LOCKED", minutes: 10 });
    for (let i = 0; i < 7; i++) await T.app.users.checkPin(u.id, "00000", "view");
    const row = (await db.query<{ pin_fail_count: number }>("SELECT pin_fail_count FROM users"))[0]!;
    expect(row.pin_fail_count).toBe(5);
    expect((await inbox(T.app, AWA)).filter((t) => t.includes("5 codes faux"))).toHaveLength(1);
  });

  it("after the lock the right code works and the count starts again", async () => {
    const u = await register();
    for (let i = 0; i < 5; i++) await T.app.users.checkPin(u.id, "00000", "view");
    T.clock.advance(15 * MINUTE + 1);
    expect(await T.app.users.checkPin(u.id, PIN, "view")).toEqual({ ok: true });
    expect(await T.app.users.checkPin(u.id, "00000", "view")).toEqual({ ok: false, err: "PIN_WRONG", left: 4 });
  });

  it("five more wrong tries without a right one lock for 24 hours", async () => {
    const u = await register();
    for (let i = 0; i < 5; i++) await T.app.users.checkPin(u.id, "00000", "view");
    T.clock.advance(15 * MINUTE + 1);
    const again = [];
    for (let i = 0; i < 5; i++) again.push(await T.app.users.checkPin(u.id, "00000", "view"));
    expect(again.at(-1)).toEqual({ ok: false, err: "PIN_LOCKED", minutes: 24 * 60 });
    T.clock.advance(DAY - MINUTE);
    expect((await T.app.users.checkPin(u.id, PIN, "view")).ok).toBe(false);
    T.clock.advance(2 * MINUTE);
    expect(await T.app.users.checkPin(u.id, PIN, "view")).toEqual({ ok: true });
  });

  it("a code of the wrong shape counts as a wrong try, and is never compared as text", async () => {
    const u = await register();
    for (const junk of ["", "4829", "482911", "abcde", "48291 ", "' OR 1=1 --"]) expect((await T.app.users.checkPin(u.id, junk, "view")).ok, junk).toBe(false);
  });

  it("ten tries at the same moment still count one by one and lock on the fifth", async () => {
    const u = await register();
    const all = await Promise.all(Array.from({ length: 10 }, () => T.app.users.checkPin(u.id, "00000", "view")));
    expect(all.filter((r) => !r.ok && r.err === "PIN_WRONG")).toHaveLength(4);
    expect(all.filter((r) => !r.ok && r.err === "PIN_LOCKED")).toHaveLength(6);
    expect((await db.query<{ pin_fail_count: number }>("SELECT pin_fail_count FROM users"))[0]!.pin_fail_count).toBe(5);
  });

  it("a frozen account can look but not spend, and a wrong code does not reveal the freeze", async () => {
    const u = await register();
    await db.query("UPDATE users SET frozen_until = $1 WHERE id = $2", [T.clock.now() + DAY, u.id]);
    expect(await T.app.users.checkPin(u.id, PIN, "view")).toEqual({ ok: true });
    expect(await T.app.users.checkPin(u.id, PIN, "spend")).toEqual({ ok: false, err: "FROZEN", hours: 24 });
    expect(await T.app.users.checkPin(u.id, "00000", "spend")).toEqual({ ok: false, err: "PIN_WRONG", left: 4 });
    T.clock.advance(DAY + 1);
    expect(await T.app.users.checkPin(u.id, PIN, "spend")).toEqual({ ok: true });
  });

  it("an unknown account is an error, not a wrong code", async () => {
    await expect(T.app.users.checkPin("u_nobody", PIN, "view")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("changing the code", () => {
  it("needs the old code, refuses a weak new one, and texts the owner when it changes", async () => {
    const u = await register();
    expect(await T.app.users.changePin(u.id, "00000", "73915")).toEqual({ ok: false, err: "PIN_WRONG", left: 4 });
    expect(await T.app.users.changePin(u.id, PIN, "11111")).toEqual({ ok: false, err: "BAD_INPUT", why: "weak" });
    expect(await T.app.users.changePin(u.id, PIN, "71234")).toEqual({ ok: false, err: "BAD_INPUT", why: "weak" });
    expect((await T.app.users.checkPin(u.id, PIN, "view")).ok).toBe(true); // still the old one
    expect(await T.app.users.changePin(u.id, PIN, "73915")).toEqual({ ok: true });
    expect((await T.app.users.checkPin(u.id, PIN, "view")).ok).toBe(false);
    expect((await T.app.users.checkPin(u.id, "73915", "view")).ok).toBe(true);
    expect((await inbox(T.app, AWA)).at(-1)).toBe("Melax: votre code secret a ete change. Si ce n'est pas vous, allez chez un agent.");
  });

  it("wrong old codes here count toward the same lock", async () => {
    const u = await register();
    for (let i = 0; i < 4; i++) await T.app.users.changePin(u.id, "00000", "73915");
    expect(await T.app.users.checkPin(u.id, "00000", "view")).toMatchObject({ err: "PIN_LOCKED" });
  });
});

describe("language and address", () => {
  it("changes the language that later texts are written in", async () => {
    const u = await register();
    await T.app.users.setLang(u.id, "en");
    expect((await T.app.users.byId(u.id))?.lang).toBe("en");
    await expect(T.app.users.setLang(u.id, "xx" as "fr")).rejects.toMatchObject({ code: "BAD_INPUT" });
  });

  it("renames the address with the code, and refuses a taken, reserved or malformed name", async () => {
    const awa = await register();
    const moussa = await register(MOUSSA, "73915", "Moussa");
    expect(await T.app.users.setAlias(awa.id, "awa-dakar", "00000")).toEqual({ ok: false, err: "PIN_WRONG", left: 4 });
    expect(await T.app.users.setAlias(awa.id, "awa-dakar", PIN)).toEqual({ ok: true, address: "awa-dakar@melax.sn" });
    expect(await T.app.users.setAlias(moussa.id, "awa-dakar", "73915")).toEqual({ ok: false, err: "BAD_INPUT", why: "taken" });
    expect(await T.app.users.setAlias(moussa.id, "AWA-DAKAR", "73915")).toEqual({ ok: false, err: "BAD_INPUT", why: "taken" });
    for (const bad of ["melax", "support", "admin", "a", "-awa", "awa_dakar", "awa dakar", "x".repeat(21), "awa@evil.com"]) {
      expect(await T.app.users.setAlias(moussa.id, bad, "73915"), bad).toMatchObject({ ok: false, err: "BAD_INPUT" });
    }
    expect((await T.app.users.byId(moussa.id))?.alias).toBe(moussa.alias);
    // keeping your own name is not "taken"
    expect(await T.app.users.setAlias(awa.id, "awa-dakar", PIN)).toEqual({ ok: true, address: "awa-dakar@melax.sn" });
  });
});
