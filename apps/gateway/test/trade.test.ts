// The trade state machine, alone: every state against every event. Pure, no database.
import { describe, expect, it } from "vitest";
import { ACTORS, EVENTS, OPEN_STATES, STATES, TERMINAL, type TradeEvent, type TradeKind, type TradeState, next } from "../src/escrow/trade.ts";

const KINDS: TradeKind[] = ["cashin", "cashout"];

/** The moves this phase allows, written out by hand so the table in trade.ts is checked against a second copy. */
const EXPECTED: Record<TradeKind, Array<[TradeState, TradeEvent, TradeState]>> = {
  cashin: [
    ["open", "held", "held"],
    ["open", "timeout", "expired"],
    ["open", "cancel", "expired"],
    ["held", "agentConfirm", "settling"],
    ["held", "timeout", "expired"],
    ["held", "cancel", "expired"],
    ["held", "dispute", "disputed"],
    ["settling", "credited", "done"],
    ["settling", "lost", "bonding"],
    ["disputed", "decideUser", "settling"],
    ["disputed", "decideAgent", "rejected"],
    ["disputed", "hardCap", "released"],
    ["released", "decideUser", "bonding"],
    ["released", "decideAgent", "rejected"],
    ["bonding", "slashed", "done"],
  ],
  cashout: [
    ["locking", "locked", "locked"],
    ["locking", "lockFailed", "failed"],
    ["locked", "agentSent", "sent"],
    ["locked", "agentDecline", "refunding"],
    ["locked", "timeout", "refunding"],
    ["locked", "userConfirm", "paying"],
    ["locked", "dispute", "disputed"],
    ["sent", "userConfirm", "paying"],
    ["sent", "timeout", "disputed"],
    ["sent", "dispute", "disputed"],
    ["paying", "paid", "returning"],
    ["returning", "changeBack", "done"],
    ["refunding", "refunded", "refunded"],
    ["disputed", "decideUser", "refunding"],
    ["disputed", "decideAgent", "paying"],
  ],
};

describe("the trade machine", () => {
  it("for every state and every event, the move is in the table or it is refused", () => {
    let checked = 0;
    for (const kind of KINDS) {
      for (const state of STATES) {
        for (const event of EVENTS) {
          const want = EXPECTED[kind].find(([s, e]) => s === state && e === event)?.[2] ?? null;
          expect(next(kind, state, event), `${kind} ${state} + ${event}`).toBe(want);
          checked++;
        }
      }
    }
    expect(checked).toBe(KINDS.length * STATES.length * EVENTS.length);
  });

  it("nothing leaves done, expired, rejected, refunded or failed", () => {
    for (const kind of KINDS) for (const state of TERMINAL) for (const event of EVENTS) expect(next(kind, state, event), `${kind} ${state} + ${event}`).toBeNull();
  });

  it("a dispute is decided once: no state reached by a decision can be decided again", () => {
    for (const kind of KINDS) {
      for (const [from, event, to] of EXPECTED[kind]) {
        if (event !== "decideUser" && event !== "decideAgent") continue;
        expect(next(kind, to, "decideUser"), `${kind} ${from} -> ${to}`).toBeNull();
        expect(next(kind, to, "decideAgent"), `${kind} ${from} -> ${to}`).toBeNull();
      }
    }
  });

  it("a cash-out the agent has marked sent can no longer be refunded by the agent or by the clock", () => {
    expect(next("cashout", "sent", "agentDecline")).toBeNull();
    expect(next("cashout", "sent", "timeout")).toBe("disputed");
  });

  it("a user cannot cancel a cash-out: the agent may be sending the francs at that moment", () => {
    for (const s of STATES) expect(next("cashout", s, "cancel")).toBeNull();
  });

  it("open states are exactly the states that are not terminal, and every state is reachable or a start", () => {
    for (const s of STATES) expect(OPEN_STATES.includes(s)).toBe(!TERMINAL.includes(s));
    for (const kind of KINDS) {
      const starts: TradeState[] = kind === "cashin" ? ["open"] : ["locking"];
      const reached = new Set<TradeState>(starts);
      for (const [, , to] of EXPECTED[kind]) reached.add(to);
      const used = new Set<TradeState>([...EXPECTED[kind].map(([s]) => s), ...EXPECTED[kind].map(([, , t]) => t)]);
      for (const s of used) expect(reached.has(s), `${kind} ${s}`).toBe(true);
    }
  });

  it("every event names who may cause it", () => {
    for (const e of EVENTS) expect(["user", "agent", "system", "arbiter"]).toContain(ACTORS[e]);
    expect(ACTORS.agentConfirm).toBe("agent");
    expect(ACTORS.agentSent).toBe("agent");
    expect(ACTORS.agentDecline).toBe("agent");
    expect(ACTORS.userConfirm).toBe("user");
    expect(ACTORS.dispute).toBe("user");
    expect(ACTORS.cancel).toBe("user");
    expect(ACTORS.decideUser).toBe("arbiter");
    expect(ACTORS.decideAgent).toBe("arbiter");
  });
});
