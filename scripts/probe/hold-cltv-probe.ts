// Probe for phase 6: how long does a held Lightning payment survive on our LND nodes?
// Three questions, each answered by measuring on the regtest stack:
//   1. With no cltv_expiry on the hold invoice (what makeHoldInvoice sent before phase 6), at which
//      block does the gateway's node cancel a held payment on its own?
//   2. With cltv_expiry set, does the world node still pay it, and does the payment survive as many
//      blocks as the 3 hour hard cap needs at one block per 30 s?
//   3. What does the gateway's node report for a held payment once the invoice's own expiry time passed?
// Blocks are mined here by hand, as fast as LND keeps up, instead of waiting 30 s for each.
// Needs: docker compose up, bash scripts/dev-creds.sh.
// Run: node scripts/probe/hold-cltv-probe.ts [cltvBlocks]
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { LndBackend } from "@melax/lightning";

const keys = resolve(import.meta.dirname, "../../.keys");
const lnd = (name: string, port: number) =>
  LndBackend.fromFiles({ baseUrl: `https://localhost:${port}`, macaroonPath: `${keys}/lnd-${name}/admin.macaroon`, tlsCertPath: `${keys}/lnd-${name}/tls.cert` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gw = lnd("gw", 18081);
const world = lnd("world", 18082);
const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");
const out: string[] = [];
const say = (line: string) => {
  out.push(line);
  process.stdout.write(line + "\n");
};

async function rpc<T>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
  const r = await fetch("http://127.0.0.1:18443" + (wallet ? `/wallet/${wallet}` : ""), {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from("melax:melax").toString("base64"), "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "1.0", id: "probe", method, params }),
  });
  const j = (await r.json()) as { result: T; error: { message: string } | null };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const minerAddr = await rpc<string>("getnewaddress", [], "miner");
const chainHeight = async () => (await rpc<{ blocks: number }>("getblockchaininfo")).blocks;
const gwHeight = async () => (await gw.request<{ block_height: number }>("GET", "/v1/getinfo")).block_height;
/** Mine n blocks and wait until the gateway's node has seen them. */
async function mine(n: number): Promise<number> {
  await rpc("generatetoaddress", [n, minerAddr]);
  const want = await chainHeight();
  for (let i = 0; i < 200; i++) {
    if ((await gwHeight()) >= want) return want;
    await sleep(100);
  }
  throw new Error("the gateway node did not catch up");
}

type RawInvoice = { state: string; cltv_expiry: string; htlcs?: Array<{ expiry_height: number; state: string }> };
const raw = (hash: string) => gw.request<RawInvoice>("GET", `/v1/invoice/${hash}`);

async function holdAndPay(opts: { cltv?: number; expirySec: number; amountSat: number }) {
  const preimage = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
  const body: Record<string, unknown> = { hash: b64(hash), value: String(opts.amountSat), memo: "cltv probe", expiry: String(opts.expirySec) };
  if (opts.cltv !== undefined) body.cltv_expiry = String(opts.cltv);
  const inv = await gw.request<{ payment_request: string }>("POST", "/v2/invoices/hodl", body);
  const paying = world.pay({ bolt11: inv.payment_request, maxFeeSat: 20, timeoutSec: 60 });
  for (let i = 0; i < 100; i++) {
    const r = await raw(hash);
    if (r.state === "ACCEPTED") return { hash, preimage, paying, inv: r };
    await sleep(300);
  }
  const outcome = await Promise.race([paying, sleep(2000).then(() => ({ status: "still waiting" }))]);
  throw new Error("the payment was never held; pay outcome " + JSON.stringify(outcome));
}

/** Mine one block at a time until the held payment is no longer accepted, or `max` blocks. Returns blocks mined. */
async function mineUntilDropped(hash: string, max: number): Promise<{ mined: number; state: string }> {
  for (let mined = 1; mined <= max; mined++) {
    await mine(1);
    await sleep(150);
    const r = await raw(hash);
    if (r.state !== "ACCEPTED") return { mined, state: r.state };
  }
  return { mined: max, state: (await raw(hash)).state };
}

const info = await gw.request<{ block_height: number; version: string }>("GET", "/v1/getinfo");
say(`lnd ${info.version}, height ${info.block_height}`);

// ---------- 1. default cltv ----------
{
  const h = await holdAndPay({ expirySec: 600, amountSat: 1000 });
  const height = await gwHeight();
  const htlc = h.inv.htlcs?.[0];
  say(`1. no cltv_expiry: invoice cltv_expiry=${h.inv.cltv_expiry}, htlc expiry_height=${htlc?.expiry_height}, height=${height}, blocks left on the htlc=${(htlc?.expiry_height ?? 0) - height}`);
  const r = await mineUntilDropped(h.hash, 300);
  say(`   held payment left ACCEPTED after ${r.mined} blocks (state ${r.state}). At 30 s a block that is ${((r.mined * 30) / 60).toFixed(1)} min`);
  say(`   payer saw: ${JSON.stringify(await h.paying)}`);
}

// ---------- 2. cltv set for the hard cap ----------
{
  const cltv = Number(process.argv[2] ?? 432);
  const capBlocks = (3 * 3600) / 30;
  const h = await holdAndPay({ cltv, expirySec: 600, amountSat: 1000 });
  const height = await gwHeight();
  const htlc = h.inv.htlcs?.[0];
  say(`2. cltv_expiry=${cltv}: world paid it. invoice cltv_expiry=${h.inv.cltv_expiry}, blocks left on the htlc=${(htlc?.expiry_height ?? 0) - height}`);
  const r = await mineUntilDropped(h.hash, capBlocks);
  say(`   after ${r.mined} blocks (the 3 h cap at 30 s a block is ${capBlocks}): state ${r.state}`);
  if (r.state === "ACCEPTED") {
    const more = await mineUntilDropped(h.hash, cltv);
    say(`   kept mining: it left ACCEPTED ${more.mined} blocks later (state ${more.state}), ${r.mined + more.mined} blocks after it was held`);
  }
  say(`   payer saw: ${JSON.stringify(await h.paying)}`);
}

// ---------- 2b. does the payer refuse a very large delta? ----------
{
  const preimage = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
  const inv = await gw.request<{ payment_request: string }>("POST", "/v2/invoices/hodl", { hash: b64(hash), value: "1000", expiry: "600", cltv_expiry: "2100" });
  const paid = await Promise.race([world.pay({ bolt11: inv.payment_request, maxFeeSat: 20, timeoutSec: 20 }), sleep(25_000).then(() => ({ status: "timeout" }))]);
  say(`2b. cltv_expiry=2100: payer answered ${JSON.stringify(paid)}`);
  await gw.cancel(hash).catch(() => undefined);
}

// ---------- 3. invoice expiry passes while held ----------
{
  const h = await holdAndPay({ cltv: Number(process.argv[2] ?? 432), expirySec: 15, amountSat: 1000 });
  await sleep(25_000);
  const r = await raw(h.hash);
  say(`3. invoice expiry 15 s, read 25 s later while held: state ${r.state}`);
  const looked = await gw.lookupInvoice(h.hash);
  say(`   lookupInvoice says ${looked?.state}`);
  await gw.settle(h.preimage);
  say(`   settled after its expiry: payer saw ${JSON.stringify(await h.paying)}, invoice ${(await raw(h.hash)).state}`);
}

await gw.close();
await world.close();
