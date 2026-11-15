// Probe: what fee reserve does the mint ask for at different amounts, and how does it compare with
// the vault's fee cap (5 sats or 0.5 %)? Run: node scripts/probe/fee-reserve-probe.ts
// Needs the regtest stack and scripts/dev-creds.sh.
import { resolve } from "node:path";
import { MintClient } from "@melax/cashu";
import { LndBackend, feeCapSat } from "@melax/lightning";

const keys = resolve(import.meta.dirname, "../../.keys");
const world = LndBackend.fromFiles({ baseUrl: "https://localhost:18082", macaroonPath: `${keys}/lnd-world/admin.macaroon`, tlsCertPath: `${keys}/lnd-world/tls.cert` });
const mint = await MintClient.connect(process.env.MINT_URL ?? "http://localhost:3338");
for (const amountSat of [100, 250, 1000, 2000, 20_000, 100_000, 500_000]) {
  const inv = await world.makeInvoice({ amountSat, memo: "fee probe" });
  const q = await mint.meltQuote(inv.bolt11);
  const cap = feeCapSat(amountSat);
  console.log(`${String(amountSat).padStart(7)} sats: reserve ${String(q.feeReserveSat).padStart(5)}  cap ${String(cap).padStart(5)}  ${q.feeReserveSat > cap ? "REFUSED by the vault" : "ok"}`);
}
await world.close();
