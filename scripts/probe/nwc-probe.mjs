// Probe: does the NWC faucet give us hold invoices (escrow) in the shape Melax needs?
import { NWCClient } from "@getalby/sdk";
import { randomBytes, createHash } from "node:crypto";

const mk = async (bal) => {
  const r = await fetch(`https://faucet.nwc.dev?balance=${bal}`, { method: "POST" });
  const url = (await r.text()).trim();
  return new NWCClient({ nostrWalletConnectUrl: url });
};
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const bal = async (c) => Math.round((await c.getBalance()).balance / 1000);

const seller = await mk(10000); // agent selling sats (pays the hold invoice)
const escrow = await mk(0);     // coordinator / buyer side issuing hold invoice
const info = await escrow.getInfo();
log("methods:", info.methods.join(","));
log("notifications:", (info.notifications || []).join(","));

// 1. plain invoice
const inv = await escrow.makeInvoice({ amount: 1000_000, description: "plain" });
const p = await seller.payInvoice({ invoice: inv.invoice });
log("plain pay ok, preimage len", p.preimage.length, "fees_paid", p.fees_paid);

// 2. hold invoice -> settle
const pre = randomBytes(32);
const hash = createHash("sha256").update(pre).digest("hex");
const hold = await escrow.makeHoldInvoice({ amount: 2000_000, description: "escrow", payment_hash: hash, expiry: 3600 });
log("hold invoice created", hold.invoice.slice(0, 30));
const payP = seller.payInvoice({ invoice: hold.invoice }).then((r) => ({ ok: r }), (e) => ({ err: e.message }));
await new Promise((r) => setTimeout(r, 6000));
const look = await escrow.lookupInvoice({ payment_hash: hash });
log("state while held:", look.state, "| seller bal", await bal(seller), "| escrow bal", await bal(escrow));
await escrow.settleHoldInvoice({ preimage: pre.toString("hex") });
log("settled ->", JSON.stringify(await payP).slice(0, 90));
log("after settle: seller", await bal(seller), "escrow", await bal(escrow));

// 3. hold invoice -> cancel (refund)
const pre2 = randomBytes(32);
const hash2 = createHash("sha256").update(pre2).digest("hex");
const hold2 = await escrow.makeHoldInvoice({ amount: 3000_000, description: "escrow2", payment_hash: hash2 });
const payP2 = seller.payInvoice({ invoice: hold2.invoice }).then((r) => ({ ok: r }), (e) => ({ err: e.message }));
await new Promise((r) => setTimeout(r, 6000));
log("held2 state:", (await escrow.lookupInvoice({ payment_hash: hash2 })).state, "seller", await bal(seller));
await escrow.cancelHoldInvoice({ payment_hash: hash2 });
log("cancel ->", JSON.stringify(await payP2).slice(0, 120));
log("after cancel: seller", await bal(seller), "escrow", await bal(escrow));

// 4. lightning address of faucet wallet resolves?
const lud16 = seller.lud16 || seller.options?.lud16;
log("lud16:", lud16);
if (lud16) {
  const [u, d] = lud16.split("@");
  const r = await fetch(`https://${d}/.well-known/lnurlp/${u}`);
  log("lnurlp status", r.status, (await r.text()).slice(0, 160));
}
seller.close(); escrow.close();
process.exit(0);
