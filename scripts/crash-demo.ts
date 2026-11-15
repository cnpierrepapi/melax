// A live demo of the worst moment for a payment: the gateway is killed right after the mint did its part
// and before the gateway wrote down the answer. Then a fresh process starts and finishes the payment
// from what it had stored before calling the mint. Once, with both receipts, and the books still match.
//
// Everything is real on the local test network: two gateway processes (the real server, apps/gateway/src/main.ts),
// the Nutshell mint, the Lightning nodes, Postgres. The kill is SIGKILL, sent by the process to itself from
// scripts/crash-preload.mjs the moment the mint answers the swap. No product code knows about it.
//
// Needs: docker compose up -d --wait, bash scripts/dev-creds.sh. Uses its own database (melax_crash) and
// port 8790, so the demo on 8787 is not touched.
// Run: node scripts/crash-demo.ts
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPgDb } from "@melax/ledger";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_DB = "postgres://melax:melax@127.0.0.1:54329/melax";
const DB = "postgres://melax:melax@127.0.0.1:54329/melax_crash";
const PIN = "48291";
const AWA = "771234567";
const MOUSSA = "781112233";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (line = "") => process.stdout.write(line + "\n");

const env = {
  ...process.env,
  MELAX_PEPPER: randomBytes(32).toString("hex"),
  MELAX_DEMO: "1",
  DATABASE_URL: DB,
  MINT_URL: "http://127.0.0.1:3338",
  PORT: String(PORT),
  RATE_FIXED_XOF_PER_BTC: "40000000",
  ESCROW_CLTV_BLOCKS: "432",
  ESCROW_BLOCK_SECONDS: "30",
  DEMO_WORLD_LND_REST_URL: "https://127.0.0.1:18082",
  DEMO_WORLD_LND_MACAROON_PATH: resolve(ROOT, ".keys/lnd-world/admin.macaroon"),
  DEMO_WORLD_LND_TLS_CERT_PATH: resolve(ROOT, ".keys/lnd-world/tls.cert"),
  LOG_LEVEL: "warn",
};

function startGateway(crashOn?: string): ChildProcess {
  const child = spawn(process.execPath, ["--import", pathToFileURL(resolve(ROOT, "scripts/crash-preload.mjs")).href, "apps/gateway/src/main.ts"], {
    cwd: ROOT,
    env: { ...env, MELAX_CRASH_ON: crashOn ?? "" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) if (line.includes("[crash-preload]")) say("   " + line.trim());
  });
  return child;
}

async function healthy(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("the gateway did not come up");
}

let n = 0;
async function ussd(phone: string, inputs: string[]): Promise<string> {
  const sessionId = `crash-demo-${Date.now()}-${++n}`;
  let text = "";
  for (const [i, input] of ["", ...inputs].entries()) {
    const r = await fetch(`${BASE}/ussd/sim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, phone, input, dial: i === 0 ? "#2580#" : undefined }) });
    text = ((await r.json()) as { message: string }).message;
  }
  return text;
}

const exited = (p: ChildProcess) => new Promise<number | string | null>((r) => p.once("exit", (code, signal) => r(signal ?? code)));

// ---------- a fresh database ----------
const admin = await createPgDb(ADMIN_DB);
await admin.query("DROP DATABASE IF EXISTS melax_crash");
await admin.query("CREATE DATABASE melax_crash");
await admin.close();
const db = await createPgDb(DB);

async function books(label: string): Promise<void> {
  const rows = await db.query<{ name: string; account: string; balance: string }>(
    "SELECT u.name, a.account, a.balance::text FROM accounts a JOIN users u ON a.account LIKE 'user:' || u.id || ':%' WHERE a.balance <> 0 ORDER BY u.name, a.account",
  );
  const ops = await db.query<{ status: string; n: string }>("SELECT status, COUNT(*)::text AS n FROM ops WHERE kind = 'transfer' GROUP BY status");
  const receipts = await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM txlog WHERE kind IN ('send', 'receive')");
  say(`   ${label}`);
  for (const r of rows) say(`     ${r.name.padEnd(7)} ${r.account.endsWith(":locked") ? "locked   " : "spendable"} ${r.balance.padStart(6)} sats`);
  say(`     transfers: ${ops.map((o) => `${o.n} ${o.status}`).join(", ") || "none"}; history rows of the send: ${receipts[0]!.n}`);
}

say("1. A gateway on port 8790, armed to die the moment the mint answers a swap.");
let gw = startGateway("/v1/swap");
await healthy();

say("2. Awa and Moussa open accounts from the menus. Awa is topped up with 5 000 F of real regtest sats.");
await ussd(AWA, ["1", PIN, PIN, "Awa"]);
await ussd(MOUSSA, ["1", PIN, PIN, "Moussa"]);
const fund = await fetch(`${BASE}/sim/fund`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: AWA, fcfa: 5000 }) });
say(`   top-up answered ${fund.status}`);
await books("before the send:");

say("3. Awa sends 500 F to Moussa and types her code. The mint does the swap. The gateway dies before it hears back.");
const dying = exited(gw);
try {
  await ussd(AWA, ["2", MOUSSA, "500", "1", PIN]);
  say("   (the send finished: the kill switch did not fire)");
} catch {
  say("   Awa's phone: the connection dropped.");
}
say(`   the gateway process ended with ${await dying}`);
await books("what the database holds now:");

say("4. A new gateway process starts, with no kill switch. Before it answers any phone it asks the mint what happened.");
gw = startGateway();
await healthy();
await books("after the restart:");
const sms = async (p: string) => ((await (await fetch(`${BASE}/sim/sms?phone=${p}`)).json()) as { messages: Array<{ kind: string; text: string }> }).messages.filter((m) => m.kind === "sent" || m.kind === "received");
for (const [name, p] of [["Awa", AWA], ["Moussa", MOUSSA]] as const) for (const m of await sms(p)) say(`   SMS to ${name}: ${m.text}`);
const state = (await (await fetch(`${BASE}/sim/state`)).json()) as { totals: { ledgerSat: number; ecashSat: number; match: boolean } };
say(`   books: ${state.totals.ledgerSat} sats owed, ${state.totals.ecashSat} sats of ecash held, ${state.totals.match ? "they match" : "THEY DO NOT MATCH"}`);

say("5. Restart once more: the payment is not made a second time.");
gw.kill();
await exited(gw);
gw = startGateway();
await healthy();
await books("after a second restart:");

gw.kill();
await exited(gw);
await db.close();
say("Done. The database melax_crash is left for a look; the next run starts it again from empty.");
process.exit(0);
