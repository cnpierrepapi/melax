// The vault has one settle hook. This routes it: each kind of money flow registers a handler under
// the name it puts in the operation's meta as `t` ("send" today; vouchers, agents and pay-outs later).
// Contract: a handler runs inside the transaction that completes or fails the operation, so the
// history rows and SMS rows it writes commit with the money or not at all. It must only use the `tx`
// handle it is given, and it must not call the network. A handler that throws rolls the settlement
// back and leaves the operation pending, so handlers keep to plain inserts.
// Callers: app.ts (vault.onSettled(router.dispatch)), wallet.ts (router.on("send", ...)).
import type { Db } from "@melax/ledger";
import type { OpView } from "@melax/vault";

export type SettleHandler = (tx: Db, op: OpView) => Promise<void>;

export class SettleRouter {
  private readonly handlers = new Map<string, SettleHandler>();

  on(type: string, handler: SettleHandler): void {
    if (this.handlers.has(type)) throw new Error(`a settle handler for "${type}" is already registered`);
    this.handlers.set(type, handler);
  }

  readonly dispatch = async (tx: Db, op: OpView): Promise<void> => {
    const meta = op.data.meta as { t?: unknown } | undefined;
    const handler = typeof meta?.t === "string" ? this.handlers.get(meta.t) : undefined;
    if (handler) await handler(tx, op);
  };
}
