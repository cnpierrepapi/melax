// One-shot setup for the local regtest network, then a slow block miner.
// It funds the three LND nodes, opens world <-> gateway <-> mint channels with liquidity on both
// sides, writes /tmp/ready, and keeps mining a block every 30 s so confirmations keep arriving.
// On every round it also checks that world can still send and the mint's node can still receive,
// and opens one more channel when either runs low.
// Regtest only: this is the one process that can see all three nodes' credentials. It does not exist
// on a public network, where channels are opened by each operator on their own. It also hands the
// demo gateway a readable copy of two of them (its own node and the world node), never the mint's.
// Run by: the `regtest-init` service in compose.yaml. Safe to restart: every step checks before acting.
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { LndBackend } from "@melax/lightning";

const RPC = process.env.BITCOIND_RPC ?? "http://bitcoind:18443";
const RPC_AUTH = "Basic " + Buffer.from(`${process.env.BITCOIND_USER ?? "melax"}:${process.env.BITCOIND_PASS ?? "melax"}`).toString("base64");
/** Where the demo gateway's copies of the node credentials go. The folder exists only when compose mounts it. */
const KEYS_DIR = process.env.DEMO_KEYS_DIR ?? "/keys";
const CHANNEL_SAT = 5_000_000;
const PUSH_SAT = 2_500_000;
/** Below this, a node that should be able to send gets one more channel. */
const LOW_SAT = 1_000_000;
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

  // LND treats a chain whose last block is hours old as "not synced" and will not finish starting.
  // After the stack has been stopped for a while that is every node, so mine a fresh block before
  // waiting for them, and keep one coming while they catch up. (Defect 17 in docs/BUILD_LOG.md.)
  await mine(1, minerAddr);

  const names = ["world", "gw", "mint"] as const;
  const lnd = Object.fromEntries(names.map((n) => [n, null as unknown as LndBackend])) as Record<(typeof names)[number], LndBackend>;
  const info = {} as Record<(typeof names)[number], Info>;
  for (const n of names) {
    lnd[n] = await until(`lnd-${n} credentials`, async () => node(n));
    let tries = 0;
    info[n] = await until(`lnd-${n} to sync`, async () => {
      if (++tries % 10 === 0) await mine(1, minerAddr);
      const i = await lnd[n].request<Info>("GET", "/v1/getinfo");
      return i.synced_to_chain ? i : false;
    });
    log(`lnd-${n} is up`, info[n].identity_pubkey.slice(0, 16));
  }

  // The demo gateway runs as an unprivileged user and cannot read the nodes' volumes, which belong to
  // root. Copy what it needs, and only that, into the volume it mounts read-only: its own node's
  // certificate and macaroon, and those of the world node that pays top-ups. The mint node's
  // credentials are not copied: the gateway has no business there.
  if (existsSync(KEYS_DIR)) {
    for (const n of ["gw", "world"] as const) {
      const dir = `${KEYS_DIR}/lnd-${n}`;
      mkdirSync(dir, { recursive: true, mode: 0o755 });
      for (const [from, to] of [[`/lnd/${n}/tls.cert`, "tls.cert"], [`/lnd/${n}/data/chain/bitcoin/regtest/admin.macaroon`, "admin.macaroon"]] as const) {
        copyFileSync(from, `${dir}/${to}`);
        chmodSync(`${dir}/${to}`, 0o444);
      }
    }
    log("copied the gateway's and the world node's credentials for the demo gateway");
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
    // Connect by host name on every run, not only when opening the channel. Docker can hand the
    // containers new addresses after a restart, and LND remembers its peer by the old one. (Defect 18.)
    await until(`peer ${a} -> ${b}`, async () => {
      await lnd[a].request("POST", "/v1/peers", { addr: { pubkey: info[b].identity_pubkey, host: `lnd-${b}:9735` }, perm: true }).catch((e: Error) => {
        if (!/already connected/i.test(e.message)) throw e;
      });
      return true;
    }, 30);
    if (has) continue;
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

  // Money on this network only flows one way until cash-out exists: world -> gateway -> mint. Every
  // top-up and every test deposit uses up a little of what world can send and of what the mint's node
  // can receive. When either runs low, the sender opens one more channel. The mint's node is never
  // paid back out: those sats back the ecash it issued. (Defect 29 in docs/BUILD_LOG.md.)
  async function addLiquidity(): Promise<boolean> {
    let opened = false;
    for (const [a, b] of links) {
      const chans = (await lnd[a].request<{ channels?: Chan[] }>("GET", "/v1/channels")).channels ?? [];
      const canSend = chans.filter((c) => c.remote_pubkey === info[b].identity_pubkey).reduce((s, c) => s + Number(c.local_balance), 0);
      if (canSend >= LOW_SAT) continue;
      const pending = await lnd[a].request<{ pending_open_channels?: Array<{ channel: { remote_node_pub: string } }> }>("GET", "/v1/channels/pending");
      if ((pending.pending_open_channels ?? []).some((c) => c.channel.remote_node_pub === info[b].identity_pubkey)) continue;
      const onChain = await lnd[a].request<{ confirmed_balance: string }>("GET", "/v1/balance/blockchain");
      if (Number(onChain.confirmed_balance) < CHANNEL_SAT + 100_000) {
        const { address } = await lnd[a].request<{ address: string }>("GET", "/v1/newaddress?type=0");
        await rpc("sendtoaddress", [address, 1], "miner");
        await mine(1, minerAddr);
        log(`sent 1 more BTC to lnd-${a}`);
        continue; // the channel is opened on the next round, once the node has seen its coins
      }
      // Right after a block, LND answers "channels cannot be created before the wallet is fully synced"
      // for a few seconds. Ask again, as the first channels above do.
      await until(`one more channel ${a} -> ${b}`, async () => {
        await lnd[a].request("POST", "/v1/channels", { node_pubkey: Buffer.from(info[b].identity_pubkey, "hex").toString("base64"), local_funding_amount: String(CHANNEL_SAT) });
        return true;
      }, 30);
      opened = true;
      log(`${a} could send only ${canSend} sats to ${b}: opened one more channel`);
    }
    if (opened) await mine(6, minerAddr);
    return opened;
  }

  if (await addLiquidity()) {
    for (const [a, b] of links) {
      await until(`the new channel ${a} -> ${b} to be active`, async () => {
        await mine(1, minerAddr);
        const pending = await lnd[a].request<{ pending_open_channels?: unknown[] }>("GET", "/v1/channels/pending");
        const chans = (await lnd[a].request<{ channels?: Chan[] }>("GET", "/v1/channels")).channels ?? [];
        return (pending.pending_open_channels ?? []).length === 0 && chans.filter((c) => c.remote_pubkey === info[b].identity_pubkey).every((c) => c.active);
      }, 90);
    }
  }

  writeFileSync("/tmp/ready", new Date().toISOString());
  log("READY: channels world <-> gw <-> mint are active");

  if (process.env.MINE_FOREVER === "0") return;
  for (;;) {
    await sleep(30_000);
    await mine(1, minerAddr).catch((e) => log("mining failed", String(e)));
    await addLiquidity().catch((e) => log("liquidity check failed", String(e)));
  }
}

main().catch((e) => {
  log("FAILED", e instanceof Error ? e.message : e);
  process.exit(1);
});
