// Boot: read the configuration, migrate the database, connect the mint and the Lightning node, finish
// whatever a previous run left unfinished, then listen.
// Contract: nothing answers a phone before vault.recover() has run once, so a restart cannot show a
// balance that an unfinished operation is about to change. Two timers keep going afterwards: one
// resolves operations left pending, one sends queued SMS.
// Run: node apps/gateway/src/main.ts (see docs/PLAN.md section 6 for the environment).
import { createLogger, systemClock } from "@melax/core";
import { MintClient } from "@melax/cashu";
import { createPgDb, ledgerMigrations, migrate } from "@melax/ledger";
import { LndBackend } from "@melax/lightning";
import { AndroidSmsGateway, HttpSms, type SmsAdapter } from "@melax/sms";
import { vaultMigrations } from "@melax/vault";
import { buildApp } from "./app.ts";
import { type Config, loadConfig } from "./config.ts";
import { buildHttp } from "./http.ts";
import { gatewayMigrations } from "./schema.ts";

function smsAdapter(config: Config): SmsAdapter {
  const out = config.smsOut;
  if (out.adapter === "asg") return new AndroidSmsGateway({ baseUrl: out.url, username: out.user, password: out.password });
  if (out.adapter === "httpsms") return new HttpSms({ apiKey: out.apiKey, from: out.from, baseUrl: out.url });
  // Demo mode: nothing leaves the machine. The outbox keeps the texts and the web simulator reads them there.
  return { name: "demo", send: async () => ({ id: "" }) };
}

const config = loadConfig(process.env);
const clock = systemClock;
const log = createLogger({ level: config.logLevel });

const db = await createPgDb(config.databaseUrl);
const applied = await migrate(db, [...ledgerMigrations, ...vaultMigrations, ...gatewayMigrations]);
const mint = await MintClient.connect(config.mintUrl);
const ln = LndBackend.fromFiles({ baseUrl: config.lnd.restUrl, macaroonPath: config.lnd.macaroonPath, tlsCertPath: config.lnd.tlsCertPath });
const app = buildApp({ db, clock, log, mint, ln, sms: smsAdapter(config), config });

const recovered = await app.vault.recover();
log.info("boot", { migrations: applied.length, demo: config.demo, mint: mint.name, recovered });

const http = buildHttp(app);
await http.listen({ host: config.host, port: config.port });
log.info("listening", { port: config.port });

const guard = (what: string, fn: () => Promise<unknown>) => () => {
  fn().catch((err) => log.error("timer.failed", { timer: what, err }));
};
const timers = [
  // Operations left pending for more than 20 seconds are asked about, never retried blindly.
  setInterval(guard("recover", () => app.vault.recover(20_000)), 30_000),
  setInterval(guard("sms", () => app.outbox.flush()), 2000),
];

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info("stopping", { signal });
  for (const timer of timers) clearInterval(timer);
  await http.close().catch(() => undefined);
  await ln.close().catch(() => undefined);
  await db.close().catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
