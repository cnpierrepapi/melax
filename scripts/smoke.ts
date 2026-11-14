// Smoke test for the regtest stack: real Lightning payments and real ecash, end to end.
//   1. the gateway node pays the mint's invoice and gets ecash (mint)
//   2. the ecash is swapped for fresh ecash (swap)
//   3. the mint pays an invoice issued by the "world" node from that ecash (melt)
// Run on the host:      bash scripts/dev-creds.sh && node scripts/smoke.ts
// Run in the stack:     docker compose run --rm regtest-init node scripts/smoke.ts
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet, sumProofs } from "@cashu/cashu-ts";
import { LndBackend, feeCapSat } from "@melax/lightning";

const inDocker = existsSync("/lnd/gw/tls.cert");
const keys = resolve(import.meta.dirname, "../.keys");
const lnd = (name: string, port: number) =>
  inDocker
    ? LndBackend.fromFiles({ baseUrl: `https://lnd-${name}:8080`, macaroonPath: `/lnd/${name}/data/chain/bitcoin/regtest/admin.macaroon`, tlsCertPath: `/lnd/${name}/tls.cert` })
    : LndBackend.fromFiles({ baseUrl: `https://localhost:${port}`, macaroonPath: `${keys}/lnd-${name}/admin.macaroon`, tlsCertPath: `${keys}/lnd-${name}/tls.cert` });
const MINT_URL = process.env.MINT_URL ?? (inDocker ? "http://mint:3338" : "http://localhost:3338");

const t0 = Date.now();
const step = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const fail = (msg: string): never => {
  console.error("SMOKE FAILED: " + msg);
  process.exit(1);
};

const gw = lnd("gw", 18081);
const world = lnd("world", 18082);
const wallet = new Wallet(MINT_URL, { unit: "sat" });
await wallet.loadMint();
const info = wallet.getMintInfo();
step(`mint "${info.name}" is up, keyset ${wallet.keysetId}`);

// 1. mint: Lightning in, ecash out
const quote = await wallet.createMintQuoteBolt11(1000);
const paid = await gw.pay({ bolt11: quote.request, maxFeeSat: feeCapSat(1000) });
if (paid.status !== "succeeded") fail("gateway could not pay the mint: " + JSON.stringify(paid));
let state = "";
for (let i = 0; i < 40 && state !== "PAID"; i++) {
  state = (await wallet.checkMintQuoteBolt11(quote.quote)).state;
  if (state !== "PAID") await new Promise((r) => setTimeout(r, 250));
}
if (state !== "PAID") fail("mint never saw the payment, quote state " + state);
const proofs = await wallet.ops.mintBolt11(1000, quote).run();
if (sumProofs(proofs).toNumber() !== 1000) fail("minted the wrong amount");
step(`minted 1000 sats of ecash in ${proofs.length} proofs`);

// 2. swap: old ecash in, fresh ecash out
const { keep, send } = await wallet.ops.send(300, proofs).run();
if (sumProofs(send).toNumber() !== 300 || sumProofs(keep).toNumber() !== 700) fail("swap amounts are wrong");
const spent = await wallet.checkProofsStates(proofs);
step(`swapped into 300 + 700; old proofs now: ${[...new Set(spent.map((s) => s.state))].join(",")}`);

// 3. melt: ecash in, Lightning out to another node
const inv = await world.makeInvoice({ amountSat: 250, memo: "smoke" });
const melt = await wallet.createMeltQuoteBolt11(inv.bolt11);
const need = melt.amount.add(melt.fee_reserve).toNumber();
const exact = await wallet.ops.send(need, send).run();
const res = await wallet.ops.meltBolt11(melt, exact.send).run();
if (res.quote.state !== "PAID") fail("melt did not pay, state " + res.quote.state);
const got = await world.lookupInvoice(inv.paymentHash);
if (got?.state !== "settled") fail("world node did not receive the payment");
step(`mint paid 250 sats to the world node; fee reserve ${melt.fee_reserve.toNumber()}, change ${sumProofs(res.change).toNumber()}`);

await gw.close();
await world.close();
console.log("SMOKE OK");
process.exit(0);
