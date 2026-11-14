// Probe: Cashu voucher shape. Does a token fit in an SMS? Can a short code unlock a P2PK-locked token?
import { Wallet, getEncodedToken, getEncodedTokenBinary } from "@cashu/cashu-ts";
import { scryptSync } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";

const MINT = "http://localhost:3338";
const wallet = new Wallet(MINT, { unit: "sat" });
await wallet.loadMint();
const out = {};

async function mint(amount) {
  const q = await wallet.createMintQuoteBolt11(amount);
  for (let i = 0; i < 10; i++) {
    const s = await wallet.checkMintQuoteBolt11(q.quote);
    if (s.state === "PAID") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return wallet.ops.mintBolt11(amount, q).run();
}

// 1. sizes of plain bearer tokens
for (const amt of [64, 1000, 5000, 37219]) {
  const proofs = await mint(amt);
  const tok = getEncodedToken({ mint: MINT, proofs, unit: "sat" });
  const bin = getEncodedTokenBinary({ mint: MINT, proofs, unit: "sat" });
  out[`plain_${amt}`] = { proofs: proofs.length, textChars: tok.length, binBytes: bin.length, sms160: Math.ceil(tok.length / 153) };
  if (amt === 5000) out.sample = tok.slice(0, 60) + "...";
}

// 2. short voucher code -> scrypt -> secp256k1 key -> P2PK lock
const ALPHA = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // 30 symbols, no lookalikes
const code = Array.from({ length: 16 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");
const t = Date.now();
const sk = scryptSync(code, "melax-voucher-v1", 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
out.kdfMs = Date.now() - t;
const pub = Buffer.from(secp256k1.getPublicKey(sk, true)).toString("hex");
out.codeBits = Math.round(16 * Math.log2(ALPHA.length));

const funds = await mint(5000);
const refundSk = scryptSync("issuer", "x", 32);
const refundPub = Buffer.from(secp256k1.getPublicKey(refundSk, true)).toString("hex");
const locktime = Math.floor(Date.now() / 1000) + 30 * 86400;
const { keep, send } = await wallet.ops.send(5000, funds).asP2PK({ pubkey: pub, locktime, refundKeys: [refundPub] }).run();
const locked = getEncodedToken({ mint: MINT, proofs: send, unit: "sat" });
out.locked = { proofs: send.length, textChars: locked.length, keep: keep.length };

// 3. redeem without the key must fail; with the key must succeed; second redeem must fail
const w2 = new Wallet(MINT, { unit: "sat" });
await w2.loadMint();
try { await w2.ops.receive(locked).run(); out.redeemNoKey = "UNEXPECTED SUCCESS"; } catch (e) { out.redeemNoKey = "rejected: " + String(e.message).slice(0, 60); }
try {
  const got = await w2.ops.receive(locked).privkey(Buffer.from(sk).toString("hex")).run();
  out.redeemWithCode = got.reduce((a, p) => a + Number(p.amount), 0) + " sats";
} catch (e) { out.redeemWithCode = "FAILED: " + String(e.message).slice(0, 120); }
try { await w2.ops.receive(locked).privkey(Buffer.from(sk).toString("hex")).run(); out.doubleSpend = "UNEXPECTED SUCCESS"; } catch (e) { out.doubleSpend = "rejected: " + String(e.message).slice(0, 60); }

// 4. state check (NUT-07) lets issuer see if voucher was claimed
try { const st = await wallet.checkProofsStates(send); out.stateCheck = st.map((s) => s.state).join(","); } catch (e) { out.stateCheck = "ERR " + e.message; }

// 5. melt path exists? (voucher -> Lightning payout) just fetch a melt quote for a fake invoice
out.info = (await (await fetch(MINT + "/v1/info")).json()).nuts["5"];
console.log(JSON.stringify(out, null, 1));
