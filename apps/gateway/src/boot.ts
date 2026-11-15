// Connects the gateway to the things it needs and returns a built App: the database (migrated), the
// mint, the gateway's Lightning node, the SMS adapter and, in a regtest demo, the node that pays top-ups.
// Contract: reads the environment once through loadConfig. Opens no port and starts no timer, so a
// script can use it and exit. `close` releases everything it opened.
// Callers: main.ts (the server), scripts/demo-seed.ts (the seed, run by hand).
import { type Logger, createLogger, systemClock } from "@melax/core";
import { MintClient } from "@melax/cashu";
import { createPgDb, ledgerMigrations, migrate } from "@melax/ledger";
import { LndBackend } from "@melax/lightning";
import { AndroidSmsGateway, HttpSms, type SmsAdapter } from "@melax/sms";
import { vaultMigrations } from "@melax/vault";
import { type App, buildApp } from "./app.ts";
import { type Config, loadConfig } from "./config.ts";
import { regtestWorld } from "./demo.ts";
import { gatewayMigrations } from "./schema.ts";

function smsAdapter(config: Config): SmsAdapter {
  const out = config.smsOut;
  if (out.adapter === "asg") return new AndroidSmsGateway({ baseUrl: out.url, username: out.user, password: out.password });
  if (out.adapter === "httpsms") return new HttpSms({ apiKey: out.apiKey, from: out.from, baseUrl: out.url });
  // Demo mode: nothing leaves the machine. The outbox keeps the texts and the web simulator reads them there.
  return { name: "demo", send: async () => ({ id: "" }) };
}

export interface Booted {
  app: App;
  config: Config;
  log: Logger;
  /** Names of the migrations this start applied. */
  applied: string[];
  close(): Promise<void>;
}

export async function boot(env: Record<string, string | undefined>): Promise<Booted> {
  const config = loadConfig(env);
  const clock = systemClock;
  const log = createLogger({ level: config.logLevel });

  const db = await createPgDb(config.databaseUrl);
  const applied = await migrate(db, [...ledgerMigrations, ...vaultMigrations, ...gatewayMigrations]);
  const mint = await MintClient.connect(config.mintUrl);
  const ln = LndBackend.fromFiles({ baseUrl: config.lnd.restUrl, macaroonPath: config.lnd.macaroonPath, tlsCertPath: config.lnd.tlsCertPath });
  const world = await regtestWorld({ config, ln, log });
  const app = buildApp({ db, clock, log, mint, ln, world, sms: smsAdapter(config), config });

  return {
    app,
    config,
    log,
    applied,
    async close() {
      await world?.close().catch(() => undefined);
      await ln.close().catch(() => undefined);
      await db.close().catch(() => undefined);
    },
  };
}
