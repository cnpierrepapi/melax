import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppError, FakeClock } from "@melax/core";
import { type Machine, MAX_CHARS, MemorySessions, UssdRuntime, africasTalking, con, end, genericHttp, menu } from "../src/index.ts";

describe("screens", () => {
  it("a screen holds at most 160 GSM-7 characters", () => {
    expect(con("a".repeat(MAX_CHARS)).text).toHaveLength(160);
    expect(() => con("a".repeat(161))).toThrow(AppError);
    expect(() => end("Dépôt reçu")).toThrow(AppError); // ô and ç are not GSM-7
    expect(() => con("")).toThrow(AppError);
  });
  it("a menu holds at most 7 options and renders one per line", () => {
    const m = menu("Melax", [["1", "Solde"], ["2", "Envoyer"], ["0", "Suite"]]);
    expect(m.text).toBe("Melax\n1 Solde\n2 Envoyer\n0 Suite");
    expect(m.end).toBe(false);
    const eight = Array.from({ length: 8 }, (_, i) => [String(i), "x"] as [string, string]);
    expect(() => menu("T", eight)).toThrow(AppError);
  });
});

// A tiny machine: asks a name, looks it up (an effect), greets, then ends.
type S = { at: "ask" } | { at: "looking"; name: string } | { at: "found"; greeting: string } | { at: "bye" } | { at: "pin" } | { at: "shortcut"; path: string[] };
type E = { t: "lookup"; name: string };
type R = { greeting: string };
const machine: Machine<S, E, R> = {
  initial: (ctx) => (ctx.shortcut.length ? { at: "shortcut", path: ctx.shortcut } : { at: "ask" }),
  enter: (s) => {
    if (s.at === "ask") return { screen: con("Name?") };
    if (s.at === "looking") return { effect: { t: "lookup", name: s.name } };
    if (s.at === "found") return { screen: menu(s.greeting, [["1", "Again"], ["2", "PIN"], ["0", "Bye"]]) };
    if (s.at === "pin") return { screen: con("PIN:") };
    if (s.at === "shortcut") return { screen: end("shortcut " + s.path.join("/")) };
    return { screen: end("Bye") };
  },
  onInput: (s, input) => {
    if (s.at === "ask") return { at: "looking", name: input };
    if (s.at === "found") return input === "1" ? { at: "ask" } : input === "2" ? { at: "pin" } : { at: "bye" };
    return { at: "bye" };
  },
  onResult: (_s, r) => ({ at: "found", greeting: r.greeting }),
  resumePoint: (s) => (s.at === "pin" ? { at: "ask" } : s.at === "ask" || s.at === "found" ? s : null),
};

function runtime(opts: { perform?: (e: E) => Promise<R>; clock?: FakeClock; stepBudgetMs?: number } = {}) {
  const clock = opts.clock ?? new FakeClock();
  const rt = new UssdRuntime<S, E, R>({
    machine,
    perform: opts.perform ?? (async (e) => ({ greeting: "Hi " + e.name })),
    sessions: new MemorySessions<S>(),
    clock,
    stepBudgetMs: opts.stepBudgetMs ?? 1000,
    texts: { busy: "Working. You will get an SMS.", expired: "Session expired.", error: "Service unavailable.", resume: "Continue where you stopped?\n1 Yes\n2 No" },
  });
  return { rt, clock };
}
const P = "+221771234567";

describe("runtime", () => {
  it("walks input -> effect -> screen, and closes on an END screen", async () => {
    const { rt } = runtime();
    expect((await rt.handle({ sessionId: "s1", phone: P, input: "", shortcut: [] })).text).toBe("Name?");
    const hi = await rt.handle({ sessionId: "s1", phone: P, input: "Awa", shortcut: [] });
    expect(hi.text).toBe("Hi Awa\n1 Again\n2 PIN\n0 Bye");
    const bye = await rt.handle({ sessionId: "s1", phone: P, input: "0", shortcut: [] });
    expect(bye).toMatchObject({ text: "Bye", end: true });
  });

  it("a dial string with extra segments starts deep in the tree", async () => {
    const { rt } = runtime();
    const r = await rt.handle({ sessionId: "s2", phone: P, input: "", shortcut: ["4", "12345"] });
    expect(r).toMatchObject({ text: "shortcut 4/12345", end: true });
  });

  it("a finished session id cannot be used again (replay)", async () => {
    const { rt } = runtime();
    await rt.handle({ sessionId: "s3", phone: P, input: "", shortcut: ["9"] });
    const again = await rt.handle({ sessionId: "s3", phone: P, input: "1", shortcut: [] });
    expect(again).toMatchObject({ text: "Session expired.", end: true });
  });

  it("a session id belongs to the phone that opened it", async () => {
    const { rt } = runtime();
    await rt.handle({ sessionId: "s4", phone: P, input: "", shortcut: [] });
    const other = await rt.handle({ sessionId: "s4", phone: "+221781112233", input: "Eve", shortcut: [] });
    expect(other).toMatchObject({ text: "Service unavailable.", end: true });
  });

  it("a slow effect gets an honest answer before the network gives up, and still finishes", async () => {
    let finished = false;
    const { rt } = runtime({
      stepBudgetMs: 50,
      perform: async (e) => {
        await new Promise((r) => setTimeout(r, 200));
        finished = true;
        return { greeting: "Hi " + e.name };
      },
    });
    await rt.handle({ sessionId: "s5", phone: P, input: "", shortcut: [] });
    const r = await rt.handle({ sessionId: "s5", phone: P, input: "Awa", shortcut: [] });
    expect(r).toMatchObject({ text: "Working. You will get an SMS.", end: true });
    await new Promise((r2) => setTimeout(r2, 250));
    expect(finished).toBe(true);
  });

  it("an effect that throws ends the session with the generic error, not a stack trace", async () => {
    const { rt } = runtime({ perform: async () => Promise.reject(new Error("db down at 10.0.0.5")) });
    await rt.handle({ sessionId: "s6", phone: P, input: "", shortcut: [] });
    const r = await rt.handle({ sessionId: "s6", phone: P, input: "Awa", shortcut: [] });
    expect(r).toEqual(expect.objectContaining({ text: "Service unavailable.", end: true }));
  });

  it("a session older than two minutes is expired", async () => {
    const { rt, clock } = runtime();
    await rt.handle({ sessionId: "s7", phone: P, input: "", shortcut: [] });
    clock.advance(121_000);
    expect(await rt.handle({ sessionId: "s7", phone: P, input: "Awa", shortcut: [] })).toMatchObject({ text: "Session expired.", end: true });
  });

  it("a dropped session can be picked up again within three minutes", async () => {
    const { rt, clock } = runtime();
    await rt.handle({ sessionId: "a1", phone: P, input: "", shortcut: [] });
    await rt.handle({ sessionId: "a1", phone: P, input: "Awa", shortcut: [] }); // now at "found"
    clock.advance(60_000); // the network dropped the session; the user dials again
    const offer = await rt.handle({ sessionId: "a2", phone: P, input: "", shortcut: [] });
    expect(offer.text).toBe("Continue where you stopped?\n1 Yes\n2 No");
    const back = await rt.handle({ sessionId: "a2", phone: P, input: "1", shortcut: [] });
    expect(back.text).toBe("Hi Awa\n1 Again\n2 PIN\n0 Bye");
  });

  it("declining the offer, or dialling after three minutes, starts fresh", async () => {
    const { rt, clock } = runtime();
    await rt.handle({ sessionId: "b1", phone: P, input: "", shortcut: [] });
    await rt.handle({ sessionId: "b1", phone: P, input: "Awa", shortcut: [] });
    await rt.handle({ sessionId: "b2", phone: P, input: "", shortcut: [] });
    expect((await rt.handle({ sessionId: "b2", phone: P, input: "2", shortcut: [] })).text).toBe("Name?");
    await rt.handle({ sessionId: "b2", phone: P, input: "Awa", shortcut: [] });
    clock.advance(181_000);
    expect((await rt.handle({ sessionId: "b3", phone: P, input: "", shortcut: [] })).text).toBe("Name?");
  });

  it("never resumes at a PIN prompt: it goes back to the step the machine names", async () => {
    const { rt } = runtime();
    await rt.handle({ sessionId: "c1", phone: P, input: "", shortcut: [] });
    await rt.handle({ sessionId: "c1", phone: P, input: "Awa", shortcut: [] });
    expect((await rt.handle({ sessionId: "c1", phone: P, input: "2", shortcut: [] })).text).toBe("PIN:");
    await rt.handle({ sessionId: "c2", phone: P, input: "", shortcut: [] });
    expect((await rt.handle({ sessionId: "c2", phone: P, input: "1", shortcut: [] })).text).toBe("Name?");
  });

  it("a session that ended normally leaves nothing to resume", async () => {
    const { rt } = runtime();
    await rt.handle({ sessionId: "d1", phone: P, input: "", shortcut: [] });
    await rt.handle({ sessionId: "d1", phone: P, input: "Awa", shortcut: [] });
    await rt.handle({ sessionId: "d1", phone: P, input: "0", shortcut: [] });
    expect((await rt.handle({ sessionId: "d2", phone: P, input: "", shortcut: [] })).text).toBe("Name?");
  });
});

describe("Africa's Talking provider", () => {
  // Request shape as documented by Africa's Talking: form fields sessionId, serviceCode, phoneNumber, networkCode, text.
  const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
  it("turns the cumulative text into one input per step and answers CON / END", async () => {
    const { rt } = runtime();
    const at = africasTalking(rt, { serviceCode: "*384*2580#" });
    const base = { sessionId: "ATUid_1", serviceCode: "*384*2580#", phoneNumber: P, networkCode: "63902" };
    expect(await at.handle(form({ ...base, text: "" }))).toBe("CON Name?");
    expect(await at.handle(form({ ...base, text: "Awa" }))).toBe("CON Hi Awa\n1 Again\n2 PIN\n0 Bye");
    expect(await at.handle(form({ ...base, text: "Awa*1" }))).toBe("CON Name?");
    expect(await at.handle(form({ ...base, text: "Awa*1*Moussa" }))).toBe("CON Hi Moussa\n1 Again\n2 PIN\n0 Bye");
    expect(await at.handle(form({ ...base, text: "Awa*1*Moussa*0" }))).toBe("END Bye");
  });
  it("a first hit that already carries text is a shortcut dial", async () => {
    const { rt } = runtime();
    const at = africasTalking(rt, { serviceCode: "*384*2580#" });
    expect(await at.handle(form({ sessionId: "ATUid_2", serviceCode: "*384*2580#", phoneNumber: P, text: "4*12345" }))).toBe("END shortcut 4/12345");
  });
  it("refuses a request for another service code or with a malformed number", async () => {
    const { rt } = runtime();
    const at = africasTalking(rt, { serviceCode: "*384*2580#" });
    await expect(at.handle(form({ sessionId: "x", serviceCode: "*999#", phoneNumber: P, text: "" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(at.handle(form({ sessionId: "x", serviceCode: "*384*2580#", phoneNumber: "abc", text: "" }))).rejects.toMatchObject({ code: "BAD_PHONE" });
    await expect(at.handle(form({ serviceCode: "*384*2580#", phoneNumber: P, text: "" }))).rejects.toMatchObject({ code: "BAD_INPUT" });
  });
});

describe("generic HTTP provider (for a local aggregator)", () => {
  const secret = "shared-secret";
  const sign = (body: string, ts: string) => createHmac("sha256", secret).update(ts + "." + body).digest("hex");
  it("accepts a signed JSON request and answers with message + continue", async () => {
    const { rt, clock } = runtime();
    const g = genericHttp(rt, { secret, clock });
    const ts = String(Math.floor(clock.now() / 1000));
    const body = JSON.stringify({ sessionId: "g1", msisdn: "221771234567", input: "", newSession: true });
    expect(await g.handle(body, { signature: sign(body, ts), timestamp: ts })).toEqual({ message: "Name?", continue: true });
  });
  it("refuses a missing or wrong signature and a stale timestamp", async () => {
    const { rt, clock } = runtime();
    const g = genericHttp(rt, { secret, clock });
    const ts = String(Math.floor(clock.now() / 1000));
    const body = JSON.stringify({ sessionId: "g2", msisdn: "221771234567", input: "", newSession: true });
    await expect(g.handle(body, { signature: undefined, timestamp: ts })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(g.handle(body, { signature: sign(body + " ", ts), timestamp: ts })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const old = String(Math.floor(clock.now() / 1000) - 400);
    await expect(g.handle(body, { signature: sign(body, old), timestamp: old })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
