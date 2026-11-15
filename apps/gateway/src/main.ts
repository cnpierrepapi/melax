// The server: connect everything (boot.ts), finish whatever a previous run left unfinished, seed the
// demo if asked, then listen.
// Contract: nothing answers a phone before vault.recover() has run once, so a restart cannot show a
// balance that an unfinished operation is about to change; the escrow's sweep runs once for the same
// reason. Three timers keep going afterwards: one resolves operations left pending, one sends queued
// SMS, one moves trades on (escrow/engine.ts). SIGINT and SIGTERM stop the timers, close
// the port, the nodes and the database, and exit 0; the handlers are in place before anything slow
// starts, so a stop during the seed is clean too.
// Run: node apps/gateway/src/main.ts (see docs/PLAN.md section 6 for the environment).
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { boot } from "./boot.ts";
import { seedAgents, seedDemo } from "./demo.ts";
import { buildHttp } from "./http.ts";
import { loadStatic } from "./static.ts";

const { app, config, log, applied, close } = await boot(process.env);

let http: FastifyInstance | undefined;
const timers: Array<ReturnType<typeof setInterval>> = [];
let stopping = false;
let stopWatching: (() => void) | undefined;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info("stopping", { signal });
  for (const timer of timers) clearInterval(timer);
  stopWatching?.();
  await app.agents.close();
  await http?.close().catch(() => undefined);
  await close();
  process.exit(0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

const recovered = await app.vault.recover();
// Trades left mid-way by the last run: held payments past their window, confirmed cash-ins not yet
// credited, pay-outs not yet resolved. Before the first phone is answered, like the vault's recovery.
const trades = await app.escrow.sweep();
log.info("boot", { migrations: applied.length, demo: config.demo, mint: app.mint.name, topUp: app.world !== undefined, recovered, trades: trades.checked });

if (config.demoSeed) {
  // A seed that fails must not keep the wallet from starting: it is logged, and the server comes up.
  await seedDemo(app).catch((err) => log.error("demo.seed.failed", { err }));
  // The agents are checked on every start, so a demo database from before phase 6 gets them too.
  await seedAgents(app).catch((err) => log.error("demo.agents.failed", { err }));
}

const web = config.demo ? loadStatic(config.webDir ?? resolve(import.meta.dirname, "../../simulator/dist")) : undefined;
if (config.demo) log.info("web", { files: web?.size ?? 0 });

if (!stopping) {
  http = buildHttp(app, { web });
  await http.listen({ host: config.host, port: config.port });
  log.info("listening", { port: config.port });

  const guard = (what: string, fn: () => Promise<unknown>) => () => {
    fn().catch((err) => log.error("timer.failed", { timer: what, err }));
  };
  // Operations left pending for more than 20 seconds are asked about, never retried blindly.
  timers.push(setInterval(guard("recover", () => app.vault.recover(20_000)), 30_000));
  timers.push(setInterval(guard("sms", () => app.outbox.flush()), 2000));
  // Trades move on the clock (45 minute windows, the 3 hour cap, retries) and on the node's word.
  timers.push(setInterval(guard("escrow", () => app.escrow.sweep()), 5000));
  stopWatching = app.escrow.watchInvoices();
}
