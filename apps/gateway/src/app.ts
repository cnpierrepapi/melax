// Builds the gateway from its parts. Everything a service needs is passed in here, once, so tests can
// swap the database, the clock, the SMS adapter and the log, and so no module reaches for a global.
// Contract: the server pepper is split into three keys here (code hashing, phone lookups, sealing), and
// the vault keeps its own derivation. The vault's single settle hook is given to the SettleRouter.
// Callers: main.ts (production wiring), tests (helpers.ts).
import type { Clock, Logger } from "@melax/core";
import type { MintClient } from "@melax/cashu";
import { deriveKey } from "@melax/crypto";
import type { Db } from "@melax/ledger";
import type { LightningBackend } from "@melax/lightning";
import type { SmsAdapter } from "@melax/sms";
import { MemorySessions, UssdRuntime } from "@melax/ussd";
import { Vault } from "@melax/vault";
import type { Config } from "./config.ts";
import { Rates } from "./rates.ts";
import { SettleRouter } from "./settle.ts";
import { SmsInbound } from "./smsin.ts";
import { SmsOutbox } from "./smsout.ts";
import { type Effect, type Res, type S, createWalletMachine, runtimeTexts } from "./ussd/machine.ts";
import { createPerform } from "./ussd/perform.ts";
import { Users } from "./users.ts";
import { Wallet } from "./wallet.ts";

export interface AppDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  mint: MintClient;
  /** The gateway's own Lightning node. */
  ln: LightningBackend;
  sms: SmsAdapter;
  config: Config;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface App extends AppDeps {
  vault: Vault;
  outbox: SmsOutbox;
  users: Users;
  rates: Rates;
  settle: SettleRouter;
  wallet: Wallet;
  inbound: SmsInbound;
  runtime: UssdRuntime<S, Effect, Res>;
}

export function buildApp(deps: AppDeps): App {
  const { db, clock, log, config } = deps;
  const pinPepper = deriveKey(config.pepper, "pin");
  const phoneKey = deriveKey(config.pepper, "phone");
  const dataKey = deriveKey(config.pepper, "data");

  const vault = new Vault({ db, clock, mint: deps.mint, ln: deps.ln, pepper: config.pepper, log });
  const settle = new SettleRouter();
  vault.onSettled(settle.dispatch);

  const outbox = new SmsOutbox({ db, clock, log, adapter: deps.sms, phoneKey, dataKey, keepBodies: config.demo });
  const users = new Users({ db, clock, log, pinPepper, phoneKey, dataKey, outbox, domain: config.domain, code: config.ussdCode });
  const rates = new Rates({ db, clock, log, fixedXofPerBtc: config.rateFixed, fetch: deps.fetch });
  const wallet = new Wallet({ db, clock, log, vault, users, rates, outbox, settle });
  const inbound = new SmsInbound({ db, clock, log, users, wallet, outbox, code: config.ussdCode });

  const runtime = new UssdRuntime<S, Effect, Res>({
    machine: createWalletMachine({ code: config.ussdCode }),
    perform: createPerform({ db, users, wallet, outbox, log }),
    sessions: new MemorySessions<S>(),
    texts: runtimeTexts(config.ussdCode),
    clock,
    log,
    stepBudgetMs: config.stepBudgetMs,
  });

  return { ...deps, vault, outbox, users, rates, settle, wallet, inbound, runtime };
}
