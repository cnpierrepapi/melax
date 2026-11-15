// Prints what each regtest node can send and receive right now. Read only.
// Top-ups and test deposits flow world -> gateway -> mint, so the world node's side of its channel and
// the room on the mint's node both shrink with use. The regtest helper (infra/regtest-init/init.ts)
// opens one more channel when either falls under 1,000,000 sats. This script shows where things stand.
// Needs: docker compose up, bash scripts/dev-creds.sh.
// Run: node scripts/probe/balances.ts
import { resolve } from "node:path";
import { LndBackend } from "@melax/lightning";

const keys = resolve(import.meta.dirname, "../../.keys");
const lnd = (name: string, port: number) => LndBackend.fromFiles({ baseUrl: `https://localhost:${port}`, macaroonPath: `${keys}/lnd-${name}/admin.macaroon`, tlsCertPath: `${keys}/lnd-${name}/tls.cert` });
const nodes = { world: lnd("world", 18082), gw: lnd("gw", 18081), mint: lnd("mint", 18083) };

for (const [name, node] of Object.entries(nodes)) {
  const b = await node.balance();
  console.log(`${name.padEnd(6)} can send ${String(b.spendableSat).padStart(9)} sats, can receive ${String(b.receivableSat).padStart(9)} sats`);
}
for (const node of Object.values(nodes)) await node.close();
