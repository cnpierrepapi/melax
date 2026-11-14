// Housekeeping for regtest: cancel every hold invoice left in the "accepted" state by an aborted test run.
// Run: node scripts/probe/lnd-cancel-held.ts
import { resolve } from "node:path";
import { LndBackend } from "@melax/lightning";

const keys = resolve(import.meta.dirname, "../../.keys");
const gw = LndBackend.fromFiles({ baseUrl: "https://localhost:18081", macaroonPath: `${keys}/lnd-gw/admin.macaroon`, tlsCertPath: `${keys}/lnd-gw/tls.cert` });
const r = await gw.request<{ invoices?: Array<{ r_hash: string; state: string }> }>("GET", "/v1/invoices?pending_only=true&num_max_invoices=1000");
let n = 0;
for (const inv of r.invoices ?? []) {
  if (inv.state !== "ACCEPTED") continue;
  await gw.cancel(Buffer.from(inv.r_hash, "base64").toString("hex"));
  n++;
}
console.log(`cancelled ${n} held invoice(s)`);
await gw.close();
