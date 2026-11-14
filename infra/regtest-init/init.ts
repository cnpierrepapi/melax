// One-shot setup for the local regtest network, then a slow block miner.
// It funds the three LND nodes, opens world <-> gateway <-> mint channels with liquidity on both
// sides, writes /tmp/ready, and keeps mining a block every 30 s so confirmations keep arriving.
// Regtest only: this is the one process that can see all three nodes' credentials. It does not exist
// on a public network, where channels are opened by each operator on their own.
// Run by: the `regtest-init` service in compose.yaml. Safe to restart: every step checks before acting.
import { rmSync, writeFileSync } from "node:fs";
import { LndBackend } from "@melax/lightning";

const RPC = process.env.BITCOIND_RPC ?? "http://bitcoind:18443";
const RPC_AUTH = "Basic " + Buffer.from(`${process.env.BITCOIND_USER ?? "melax"}:${process.env.BITCOIND_PASS ?? "melax"}`).toString("base64");
const CHANNEL_SAT = 5_000_000;
const PUSH_SAT = 2_500_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[regtest-init]", ...a);

async function rpc<T>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
  const r = await fetch(RPC + (wallet ? `/wallet/${wallet}` : ""), {
    method: "POST",
    headers: { Authorization: RPC_AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "1.0", id: "init", method, params }),
  });
  const j = (await r.json()) as { result: T; error: { message: string; code: number } | null };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function until<T>(what: string, fn: () => Promise<T | false | null | undefined>, tries = 120, everyMs = 1000): Promise<T> {
  let last = "";
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last ? ": " + last : ""}`);
}

type Info = { identity_pubkey: string; synced_to_chain: boolean; block_height: number };
type Chan = { remote_pubkey: string; active: boolean; local_balance: string; remote_balance: string };

function node(name: string): LndBackend {
  return LndBackend.fromFiles({
    baseUrl: process.env[`LND_${name.toUpperCase()}_URL`] ?? `https://lnd-${name}:8080`,
    macaroonPath: `/lnd/${name}/data/chain/bitcoin/regtest/admin.macaroon`,
    tlsCertPath: `/lnd/${name}/tls.cert`,
  });
}

async function mine(n: number, address: string): Promise<void> {
  await rpc("generatetoaddress", [n, address]);
}

async function main(): Promise<void> {
  rmSync("/tmp/ready", { force: true }); // a restarted container must prove itself again
  await until("bitcoind", () => rpc<{ blocks: number }>("getblockchaininfo"));
  try {
    await rpc("createwallet", ["miner"]);
  } catch (e) {
    if (!/already exists/i.test(String(e))) throw e;
    await rpc("loadwallet", ["miner"]).catch(() => undefined);
  }
  const minerAddr = await rpc<string>("getnewaddress", [], "miner");
  const height = (await rpc<{ blocks: number }>("getblockchaininfo")).blocks;
  if (height < 101) {
    log("mining the first 101 blocks");
    await mine(101 - height, minerAddr);
  }

  const names = ["world", "gw", "mint"] as const;
  const lnd = Object.fromEntries(names.map((n) => [n, null as unknown as LndBackend])) as Record<(typeof names)[number], LndBackend>;
  const info = {} as Record<(typeof names)[number], Info>;
  for (const n of names) {
    lnd[n] = await until(`lnd-${n} credentials`, async () => node(n));
    info[n] = await until(`lnd-${n} to sync`, async () => {
      const i = await lnd[n].request<Info>("GET", "/v1/getinfo");
      return i.synced_to_chain ? i : false;
    });
    log(`lnd-${n} is up`, info[n].identity_pubkey.slice(0, 16));
  }

  // Fund each node's on-chain wallet once.
  let funded = false;
  for (const n of names) {
    const bal = await lnd[n].request<{ total_balance: string }>("GET", "/v1/balance/blockchain");
    const chans = await lnd[n].request<{ channels?: Chan[] }>("GET", "/v1/channels");
    if (Number(bal.total_balance) < 10_000_000 && (chans.channels ?? []).length === 0) {
      const { address } = await lnd[n].request<{ address: string }>("GET", "/v1/newaddress?type=0");
      await rpc("sendtoaddress", [address, 1], "miner");
      funded = true;
      log(`sent 1 BTC to lnd-${n}`);
    }
  }
  if (funded) {
    await mine(3, minerAddr);
    for (const n of names) {
      await until(`lnd-${n} to see its coins`, async () => {
        const chans = await lnd[n].request<{ channels?: Chan[] }>("GET", "/v1/channels");
        if ((chans.channels ?? []).length > 0) return true;
        const b = await lnd[n].request<{ confirmed_balance: string }>("GET", "/v1/balance/blockchain");
        return Number(b.confirmed_balance) > 0;
      });
    }
  }

  // world -> gw and gw -> mint, half pushed to the far side so both directions can pay from the start.
  const links: Array<[(typeof names)[number], (typeof names)[number]]> = [
    ["world", "gw"],
    ["gw", "mint"],
  ];
  let opened = false;
  for (const [a, b] of links) {
    const existing = await lnd[a].request<{ channels?: Chan[] }>("GET", "/v1/channels");
    const pending = await lnd[a].request<{ pending_open_channels?: Array<{ channel: { remote_node_pub: string } }> }>("GET", "/v1/channels/pending");
    const has = (existing.channels ?? []).some((c) => c.remote_pubkey === info[b].identity_pubkey) || (pending.pending_open_channels ?? []).some((c) => c.channel.remote_node_pub === info[b].identity_pubkey);
    if (has) continue;
    await lnd[a].request("POST", "/v1/peers", { addr: { pubkey: info[b].identity_pubkey, host: `lnd-${b}:9735` }, perm: true }).catch((e: Error) => {
      if (!/already connected/i.test(e.message)) throw e;
    });
    await until(`channel ${a} -> ${b}`, async () => {
      await lnd[a].request("POST", "/v1/channels", {
        node_pubkey: Buffer.from(info[b].identity_pubkey, "hex").toString("base64"),
        local_funding_amount: String(CHANNEL_SAT),
        push_sat: String(PUSH_SAT),
      });
      return true;
    }, 30);
    opened = true;
    log(`opened channel ${a} -> ${b}`);
  }
  if (opened) await mine(6, minerAddr);

  for (const [a, b] of links) {
    await until(`channel ${a} <-> ${b} to be active`, async () => {
      const mineMore = mine(1, minerAddr);
      const ca = await lnd[a].request<{ channels?: Chan[] }>("GET", "/v1/channels");
      const cb = await lnd[b].request<{ channels?: Chan[] }>("GET", "/v1/channels");
      await mineMore;
      return (ca.channels ?? []).some((c) => c.remote_pubkey === info[b].identity_pubkey && c.active) && (cb.channels ?? []).some((c) => c.remote_pubkey === info[a].identity_pubkey && c.active);
    }, 90);
  }

  // The gateway must know a route world <-> mint through itself; wait until gossip has both channels.
  await until("the mint to see a route to the world", async () => {
    const g = await lnd.mint.request<{ num_channels: number }>("GET", "/v1/graph/info");
    return g.num_channels >= 2;
  }, 90);

  writeFileSync("/tmp/ready", new Date().toISOString());
  log("READY: channels world <-> gw <-> mint are active");

  if (process.env.MINE_FOREVER === "0") return;
  for (;;) {
    await sleep(30_000);
    await mine(1, minerAddr).catch((e) => log("mining failed", String(e)));
  }
}

main().catch((e) => {
  log("FAILED", e instanceof Error ? e.message : e);
  process.exit(1);
});
