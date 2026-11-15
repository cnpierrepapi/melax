// The trade state machine, pure: (kind, state, event) -> next state, or null when the move is refused.
// Contract:
//   - this table is the only place that says which move is allowed. The engine applies a move with
//     UPDATE trades SET state = <next> WHERE id = $1 AND state = <current> and checks one row changed;
//     whoever loses that race does nothing;
//   - done, expired, rejected, refunded and failed are terminal: no event leaves them;
//   - a dispute is decided once: decideUser and decideAgent are only allowed from disputed and released;
//   - ACTORS names who may cause each event. The engine checks the person before it asks this table.
// Callers: escrow/engine.ts, test/trade.test.ts.

export type TradeKind = "cashin" | "cashout";

export const STATES = [
  // cash-in
  "open", // the hold invoice exists, the agent's payment has not arrived
  "held", // the agent's sats are locked in the payment, waiting for the agent to say the francs arrived
  "settling", // the agent confirmed (or the arbiter decided for the user while held): settle, then credit
  "disputed", // the user says the francs were sent (cash-in), or nobody can be believed without a look (cash-out)
  "released", // a cash-in dispute outlived its payment: the sats went back to the agent, the bond answers for it
  "bonding", // the user is paid out of the agent's bond
  "rejected", // a dispute decided for the agent
  "expired", // a cash-in that ended with nothing moved
  // cash-out
  "locking", // the user's sats are on their way to escrow:<tradeId>
  "locked", // the sats are in escrow, the agent has not marked the francs sent
  "sent", // the agent says the francs were sent, the user has not confirmed
  "paying", // the escrow pays the agent's wallet over Lightning
  "returning", // the agent is paid; what is left of the fee allowance goes back to the user
  "refunding", // the escrow goes back to the user
  "refunded",
  "failed", // the lock never happened: nothing moved
  // both
  "done",
] as const;
export type TradeState = (typeof STATES)[number];

export const EVENTS = [
  "held",
  "timeout",
  "cancel",
  "agentConfirm",
  "agentDecline",
  "agentSent",
  "userConfirm",
  "dispute",
  "credited",
  "lost",
  "decideUser",
  "decideAgent",
  "hardCap",
  "slashed",
  "locked",
  "lockFailed",
  "paid",
  "changeBack",
  "refunded",
] as const;
export type TradeEvent = (typeof EVENTS)[number];

export const TERMINAL: readonly TradeState[] = ["done", "expired", "rejected", "refunded", "failed"];
export const OPEN_STATES: readonly TradeState[] = STATES.filter((s) => !TERMINAL.includes(s));
/** Cash-in states that hold a claim on the agent's bond: open cash-ins must never add up to more than the bond. */
export const BONDED_STATES: readonly TradeState[] = ["open", "held", "settling", "disputed", "released", "bonding"];

type Table = Partial<Record<TradeState, Partial<Record<TradeEvent, TradeState>>>>;

const CASHIN: Table = {
  open: { held: "held", timeout: "expired", cancel: "expired" },
  held: { agentConfirm: "settling", timeout: "expired", cancel: "expired", dispute: "disputed" },
  // `lost`: the node cancelled the payment before it could be settled (it outlived its block limit).
  // The agent said the francs arrived, so the user is paid from the bond.
  settling: { credited: "done", lost: "bonding" },
  disputed: { decideUser: "settling", decideAgent: "rejected", hardCap: "released" },
  released: { decideUser: "bonding", decideAgent: "rejected" },
  bonding: { slashed: "done" },
};

const CASHOUT: Table = {
  locking: { locked: "locked", lockFailed: "failed" },
  // The user can confirm before the agent marks it sent: the francs arrived, that is all that matters.
  locked: { agentSent: "sent", agentDecline: "refunding", timeout: "refunding", userConfirm: "paying", dispute: "disputed" },
  // Once the agent says the francs left, neither the agent nor the clock can give the sats back.
  sent: { userConfirm: "paying", timeout: "disputed", dispute: "disputed" },
  paying: { paid: "returning" },
  returning: { changeBack: "done" },
  refunding: { refunded: "refunded" },
  disputed: { decideUser: "refunding", decideAgent: "paying" },
};

export function next(kind: TradeKind, state: TradeState, event: TradeEvent): TradeState | null {
  return (kind === "cashin" ? CASHIN : CASHOUT)[state]?.[event] ?? null;
}

/** Who may cause an event. "system" is the engine itself: the clock, the node, a settled operation. */
export const ACTORS: Record<TradeEvent, "user" | "agent" | "system" | "arbiter"> = {
  held: "system",
  timeout: "system",
  cancel: "user",
  agentConfirm: "agent",
  agentDecline: "agent",
  agentSent: "agent",
  userConfirm: "user",
  dispute: "user",
  credited: "system",
  lost: "system",
  decideUser: "arbiter",
  decideAgent: "arbiter",
  hardCap: "system",
  slashed: "system",
  locked: "system",
  lockFailed: "system",
  paid: "system",
  changeBack: "system",
  refunded: "system",
};
