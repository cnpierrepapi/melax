// @melax/crypto: every secret-handling primitive in one audited place.
// Contract: thin wrappers over node:crypto only (Argon2id, HKDF, AES-256-GCM, HMAC, scrypt, secp256k1).
// Nothing here is home-made cryptography; the only original part is the voucher code check character.
// Callers: vault (sealing proofs), gateway (PINs, phone lookups, vouchers, aliases), voucher-web (same KDF in the browser).
import {
  argon2,
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { AppError } from "@melax/core";

// ---------- PIN ----------

const ARGON = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;

function argon2id(pin: string, salt: Buffer, pepper: Buffer, p: { memory: number; passes: number; parallelism: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      "argon2id",
      { message: Buffer.from(pin, "utf8"), nonce: salt, secret: pepper, parallelism: p.parallelism, tagLength: ARGON.tagLength, memory: p.memory, passes: p.passes },
      (err, key) => (err ? reject(err) : resolve(Buffer.from(key))),
    );
  });
}

/**
 * Argon2id with a random salt per user and the server pepper as the Argon2 secret input.
 * Output: argon2id$memoryKiB$passes$parallelism$saltB64$hashB64. The pepper never touches the database.
 */
export async function hashPin(pin: string, pepper: Buffer): Promise<string> {
  const salt = randomBytes(16);
  const h = await argon2id(pin, salt, pepper, ARGON);
  return ["argon2id", ARGON.memory, ARGON.passes, ARGON.parallelism, salt.toString("base64"), h.toString("base64")].join("$");
}

export async function verifyPin(pin: string, stored: string, pepper: Buffer): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "argon2id") return false;
    const memory = Number(parts[1]);
    const passes = Number(parts[2]);
    const parallelism = Number(parts[3]);
    if (![memory, passes, parallelism].every((n) => Number.isInteger(n) && n > 0) || memory > 1_048_576 || passes > 16) return false;
    const salt = Buffer.from(parts[4]!, "base64");
    const want = Buffer.from(parts[5]!, "base64");
    if (salt.length < 8 || want.length !== ARGON.tagLength) return false;
    const got = await argon2id(pin, salt, pepper, { memory, passes, parallelism });
    return timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

export const PIN_LENGTH = 5;

/** True for PINs we refuse to set: wrong shape, one repeated digit, straight runs, steps, two-digit patterns, or digits lifted from the phone number. */
export function isWeakPin(pin: string, phoneE164?: string): boolean {
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) return true;
  const d = [...pin].map(Number);
  const diffs = d.slice(1).map((x, i) => (x - d[i]! + 10) % 10);
  if (diffs.every((x) => x === diffs[0])) return true; // 11111, 12345, 54321, 24680, 13579, 90123
  if (d[0] === d[2] && d[2] === d[4] && d[1] === d[3]) return true; // 12121
  if (new Set(d).size <= 2) return true; // 11222, 77177
  if (phoneE164 && phoneE164.replace(/\D/g, "").includes(pin)) return true;
  return false;
}

// ---------- lookups and sealing ----------

/** HMAC-SHA256 of the E.164 number. Lets us find a user by number without storing the number in the clear. */
export function phoneLookupKey(phoneE164: string, hmacKey: Buffer): Buffer {
  return createHmac("sha256", hmacKey).update(phoneE164, "utf8").digest();
}

/** Per-owner data key: HKDF-SHA256(pepper, salt). The pepper lives in the environment, the salt in the database. */
export function deriveUserKey(pepper: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", pepper, salt, "melax/vault/v1", 32));
}

/**
 * A separate 32-byte key per purpose from the one server pepper: HKDF-SHA256(pepper, label).
 * The gateway uses it so the PIN pepper, the phone lookup key and the data sealing key are never the same bytes.
 */
export function deriveKey(pepper: Buffer, label: string): Buffer {
  if (pepper.length < 32) throw new AppError("BAD_INPUT", "pepper must be at least 32 bytes");
  if (!label) throw new AppError("BAD_INPUT", "a derived key needs a label");
  return Buffer.from(hkdfSync("sha256", pepper, Buffer.alloc(0), "melax/key/v1/" + label, 32));
}

/** AES-256-GCM. Layout: 12-byte nonce | ciphertext | 16-byte tag. `aad` binds the blob to its owner. */
export function seal(key: Buffer, plaintext: Buffer, aad = ""): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([nonce, body, c.getAuthTag()]);
}

export function open(key: Buffer, sealed: Buffer, aad = ""): Buffer {
  try {
    if (sealed.length < 28) throw new Error("short");
    const d = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([d.update(sealed.subarray(12, sealed.length - 16)), d.final()]);
  } catch {
    throw new AppError("INTERNAL", "sealed data failed authentication");
  }
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// ---------- voucher codes ----------

/** 30 symbols. No 0/O, 1/I/L or U, so a code survives being read aloud or copied by hand. */
export const VOUCHER_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
export const VOUCHER_CODE_LENGTH = 16;

// Check character: Damm's scheme over a 30-element quasigroup built as the product of
// x*y = 2x+y (mod 3) and Damm's order-10 table. The product keeps the anti-symmetry
// (c*x)*y = (c*y)*x => x = y, so every single wrong character and every swap of two
// neighbours is caught. test/crypto.test.ts proves it by enumeration.
const DAMM10 = ["0317598642", "7092154863", "4206871359", "1750983426", "6123045978", "3674209581", "5869720134", "8945362017", "9438617205", "2581436790"].map(
  (r) => [...r].map(Number),
);
function q30(x: number, y: number): number {
  return ((2 * (x % 3) + (y % 3)) % 3) + 3 * DAMM10[Math.floor(x / 3)]![Math.floor(y / 3)]!;
}
function dammInterim(indices: number[]): number {
  let i = 0;
  for (const s of indices) i = q30(i, s);
  return i;
}
/** Exposed for the exhaustive property test. */
export const _q30 = q30;

/** 15 random symbols (73.6 bits) plus one check symbol. */
export function newVoucherCode(): string {
  const idx = Array.from({ length: VOUCHER_CODE_LENGTH - 1 }, () => randomInt(VOUCHER_ALPHABET.length));
  const interim = dammInterim(idx);
  let check = 0;
  while (q30(interim, check) !== 0) check++;
  return [...idx, check].map((i) => VOUCHER_ALPHABET[i]).join("");
}

/** Upper-case, strip separators, verify length, alphabet and check character. Throws BAD_INPUT. */
export function normalizeVoucherCode(input: string): string {
  const s = String(input ?? "")
    .toUpperCase()
    .replace(/[\s\-_.]/g, "");
  if (s.length !== VOUCHER_CODE_LENGTH) throw new AppError("BAD_INPUT", "voucher code has the wrong length");
  const idx = [...s].map((c) => VOUCHER_ALPHABET.indexOf(c));
  if (idx.some((i) => i < 0)) throw new AppError("BAD_INPUT", "voucher code has an invalid character");
  if (dammInterim(idx) !== 0) throw new AppError("BAD_INPUT", "voucher code check failed");
  return s;
}

export function formatVoucherCode(code: string): string {
  return code.match(/.{4}/g)!.join("-");
}

/** Where the gateway files the locked token. Knowing this hash does not help spend it. */
export function voucherCodeHash(code: string): string {
  return sha256Hex("melax-voucher-id-v1:" + normalizeVoucherCode(code));
}

export const VOUCHER_KDF = { salt: "melax-voucher-v1", N: 2 ** 15, r: 8, p: 1 } as const;
const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");

/**
 * Code -> scrypt -> secp256k1 key. The ecash is locked (NUT-11 P2PK) to pubHex, so only someone
 * holding the code can produce the signature that spends it. The browser redeem page runs the same KDF.
 */
export function voucherKey(code: string): { privHex: string; pubHex: string } {
  let sk = scryptSync(normalizeVoucherCode(code), VOUCHER_KDF.salt, 32, { N: VOUCHER_KDF.N, r: VOUCHER_KDF.r, p: VOUCHER_KDF.p, maxmem: 128 * 1024 * 1024 });
  for (;;) {
    const n = BigInt("0x" + sk.toString("hex"));
    if (n > 0n && n < SECP256K1_N) break;
    sk = createHash("sha256").update(sk).digest();
  }
  return { privHex: sk.toString("hex"), pubHex: pubkeyFromPriv(sk.toString("hex")) };
}

/** Compressed secp256k1 public key (33 bytes hex) for a 32-byte private key. */
export function pubkeyFromPriv(privHex: string): string {
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(privHex, "hex"));
  return ecdh.getPublicKey("hex", "compressed");
}

export function randomPrivKey(): string {
  for (;;) {
    const sk = randomBytes(32);
    const n = BigInt("0x" + sk.toString("hex"));
    if (n > 0n && n < SECP256K1_N) return sk.toString("hex");
  }
}

// ---------- aliases and short codes ----------

const WORDS_A = ["baobab", "kora", "pirogue", "bissap", "mangue", "lion", "soleil", "ocean", "djembe", "savane", "gazelle", "filao", "calao", "tama", "kinkeliba", "lagune", "dune", "pagne", "flamant", "cauri", "tilapia", "karite", "ditakh", "madd", "bouye", "ngalam", "sabar", "xalam", "teranga", "ndar"];
const WORDS_B = ["bleu", "vert", "dore", "vif", "calme", "fier", "brave", "sage", "libre", "rapide", "solide", "clair", "juste", "franc", "noble", "agile", "doux", "grand", "malin", "serein", "loyal", "vaillant", "habile", "joyeux", "fidele", "patient", "tenace", "digne", "ardent", "sobre"];

/** Random Lightning-address local part, e.g. kora-brave42. Not derived from the phone number on purpose. */
export function randomAlias(): string {
  return `${WORDS_A[randomInt(WORDS_A.length)]}-${WORDS_B[randomInt(WORDS_B.length)]}${String(randomInt(100)).padStart(2, "0")}`;
}

export function newPayCode(): string {
  return String(randomInt(1_000_000)).padStart(6, "0");
}

export function newMerchantCode(): string {
  return String(10_000 + randomInt(90_000));
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

export { randomBytes };
