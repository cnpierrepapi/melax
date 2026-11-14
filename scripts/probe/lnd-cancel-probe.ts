// Probe: what does LND's channel balance look like on the payer side before, during and after a
// cancelled hold invoice? Written to settle a failing contract test with a measurement.
// Run: node scripts/probe/lnd-cancel-probe.ts   (needs the regtest stack and scripts/dev-creds.sh)
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { LndBackend } from "@melax/lightning";

const keys = resolve(import.meta.dirname, "../../.keys");
const lnd = (name: string, port: number) =>
  LndBackend.fromFiles({ baseUrl: `https://localhost:${port}`, macaroonPath: `${keys}/lnd-${name}/admin.macaroon`, tlsCertPath: `${keys}/lnd-${name}/tls.cert` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gw = lnd("gw", 18081);
const world = lnd("world", 18082);
const raw = async (label: string) => {
  const b = await world.request<Record<string, { sat?: string }>>("GET", "/v1/balance/channels");
  console.log(label.padEnd(18), Object.entries(b).filter(([k]) => k.endsWith("_balance")).map(([k, v]) => `${k}=${v?.sat ?? 0}`).join(" "));
};

const preimage = randomBytes(32);
const hash = createHash("sha256").update(preimage).digest("hex");
await raw("before");
const inv = await gw.makeHoldInvoice({ amountSat: 3000, paymentHash: hash, expirySec: 600 });
const paying = world.pay({ bolt11: inv.bolt11, maxFeeSat: 20, timeoutSec: 60 });
await sleep(2500);
await raw("held");
await gw.cancel(hash);
console.log("pay outcome:", JSON.stringify(await paying));
for (const t of [0, 500, 1500, 4000, 8000]) {
  await sleep(t);
  await raw(`after +${t}ms`);
}
await gw.close();
await world.close();
