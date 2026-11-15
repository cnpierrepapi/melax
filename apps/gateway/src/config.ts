// The gateway's configuration, read from the environment once and checked with zod.
// Contract: secrets come from the environment only and never appear in an error message or a log line:
// a failed check names the variable and the rule, not the value.
// Callers: main.ts (process.env), tests (a plain object).
import { z } from "zod";
import { AppError } from "@melax/core";

const flag = z
  .enum(["0", "1", "true", "false"])
  .default("0")
  .transform((v) => v === "1" || v === "true");
const optional = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));
const secret = (min: number, what: string) => optional.refine((v) => v === undefined || v.length >= min, `${what} must be at least ${min} characters`);

const Env = z.object({
  /** At least 32 random bytes in hex. Seals the ecash, peppers the codes, keys the phone lookups. Losing it loses the money. */
  MELAX_PEPPER: z.string({ error: "is required" }).regex(/^[0-9a-fA-F]{64,}$/, "must be at least 32 random bytes written in hex"),
  /** Demo mode mounts the web simulator route and keeps SMS texts so the simulator can show them. */
  MELAX_DEMO: flag,
  /** Demo mode only: open six accounts with balances and a little history when the database is empty. */
  DEMO_SEED: flag,
  /**
   * Demo mode only, regtest only: the node that plays "everybody else". The top-up button of the web
   * simulator pays the gateway's invoices from it. All three or none.
   */
  DEMO_WORLD_LND_REST_URL: optional,
  DEMO_WORLD_LND_MACAROON_PATH: optional,
  DEMO_WORLD_LND_TLS_CERT_PATH: optional,
  /** Folder holding the built web pages. Unset, main.ts looks in apps/simulator/dist. */
  WEB_DIR: optional,
  DATABASE_URL: z.string().default("postgres://melax:melax@127.0.0.1:54329/melax"),
  MINT_URL: z.string().default("http://127.0.0.1:3338"),
  LND_REST_URL: z.string().default("https://127.0.0.1:18081"),
  LND_MACAROON_PATH: z.string().default(".keys/lnd-gw/admin.macaroon"),
  LND_TLS_CERT_PATH: z.string().default(".keys/lnd-gw/tls.cert"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  /** The short code as users dial it. Shown on screens and in SMS. */
  USSD_CODE: z.string().regex(/^[*#][0-9*]{2,12}#$/, "must look like #2580#").default("#2580#"),
  /** Domain of the Lightning addresses shown to users (alias@domain). They become payable in phase 8. */
  ADDRESS_DOMAIN: z.string().regex(/^[a-z0-9.-]{3,60}$/, "must be a host name").default("melax.test"),
  /** Africa's Talking does not sign its callbacks. The route is /ussd/at/<this secret>, and only these addresses may call it. */
  AT_SECRET: secret(24, "AT_SECRET"),
  AT_SERVICE_CODE: optional,
  AT_ALLOW_IPS: optional,
  /** Shared secret of the generic signed JSON route /ussd/http. */
  USSD_HTTP_SECRET: secret(24, "USSD_HTTP_SECRET"),
  SMS_ADAPTER: z.enum(["memory", "asg", "httpsms"]).default("memory"),
  ASG_URL: optional,
  ASG_USER: optional,
  ASG_PASSWORD: optional,
  /** Signing keys of the inbound webhooks. A route is mounted only when its key is set. */
  ASG_SIGNING_KEY: secret(16, "ASG_SIGNING_KEY"),
  HTTPSMS_URL: optional,
  HTTPSMS_API_KEY: optional,
  HTTPSMS_FROM: optional,
  HTTPSMS_SIGNING_KEY: secret(16, "HTTPSMS_SIGNING_KEY"),
  /** Whole FCFA per bitcoin. Set in tests and demos; unset, the live source is used. */
  RATE_FIXED_XOF_PER_BTC: z.coerce.number().int().min(100_000).max(100_000_000_000).optional(),
  /** Set to 1 behind a reverse proxy, so the caller's address is read from X-Forwarded-For. */
  TRUST_PROXY: flag,
  /** How long one USSD step may take before the user is told an SMS will follow. Networks cut at about 20 s. */
  STEP_BUDGET_MS: z.coerce.number().int().min(50).max(60_000).default(12_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type SmsOut = { adapter: "memory" } | { adapter: "asg"; url: string; user: string; password: string } | { adapter: "httpsms"; apiKey: string; from: string; url?: string };

export interface Config {
  pepper: Buffer;
  demo: boolean;
  demoSeed: boolean;
  demoWorld: { restUrl: string; macaroonPath: string; tlsCertPath: string } | null;
  webDir: string | null;
  databaseUrl: string;
  mintUrl: string;
  lnd: { restUrl: string; macaroonPath: string; tlsCertPath: string };
  host: string;
  port: number;
  ussdCode: string;
  domain: string;
  at: { secret: string; serviceCode?: string; allowIps: string[] } | null;
  ussdHttpSecret: string | null;
  smsOut: SmsOut;
  smsIn: { asgSigningKey: string | null; httpSmsSigningKey: string | null };
  rateFixed: number | null;
  trustProxy: boolean;
  stepBudgetMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

function refuse(problems: string[]): never {
  throw new AppError("BAD_INPUT", "configuration: " + problems.join("; "));
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  // A variable that is set but empty (`RATE_FIXED_XOF_PER_BTC=` in a compose file) means "not set".
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === "string" && v.trim() !== ""));
  const parsed = Env.safeParse(present);
  if (!parsed.success) refuse(parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`));
  const e = parsed.data;
  const problems: string[] = [];
  const need = (name: string, v: string | undefined): string => {
    if (v === undefined) problems.push(`${name} is required when SMS_ADAPTER=${e.SMS_ADAPTER}`);
    return v ?? "";
  };

  let smsOut: SmsOut = { adapter: "memory" };
  if (e.SMS_ADAPTER === "asg") smsOut = { adapter: "asg", url: need("ASG_URL", e.ASG_URL), user: need("ASG_USER", e.ASG_USER), password: need("ASG_PASSWORD", e.ASG_PASSWORD) };
  if (e.SMS_ADAPTER === "httpsms") smsOut = { adapter: "httpsms", apiKey: need("HTTPSMS_API_KEY", e.HTTPSMS_API_KEY), from: need("HTTPSMS_FROM", e.HTTPSMS_FROM), url: e.HTTPSMS_URL };
  // Outside demo mode an SMS must really leave: a receipt that only exists in memory is no receipt.
  if (!e.MELAX_DEMO && e.SMS_ADAPTER === "memory") problems.push("SMS_ADAPTER=memory is only allowed with MELAX_DEMO=1");

  const allowIps = (e.AT_ALLOW_IPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (e.AT_SECRET && !e.MELAX_DEMO && allowIps.length === 0) problems.push("AT_ALLOW_IPS is required with AT_SECRET outside demo mode: the Africa's Talking route has no signature to check");

  // Everything that only makes sense in a demo is refused outside one, so a deployment cannot carry
  // a top-up button or seeded accounts by accident.
  const world = { DEMO_WORLD_LND_REST_URL: e.DEMO_WORLD_LND_REST_URL, DEMO_WORLD_LND_MACAROON_PATH: e.DEMO_WORLD_LND_MACAROON_PATH, DEMO_WORLD_LND_TLS_CERT_PATH: e.DEMO_WORLD_LND_TLS_CERT_PATH };
  const worldSet = Object.entries(world).filter(([, v]) => v !== undefined);
  if (worldSet.length > 0 && worldSet.length < 3) for (const [name, v] of Object.entries(world)) if (v === undefined) problems.push(`${name} is required when another DEMO_WORLD_LND_* variable is set`);
  if (!e.MELAX_DEMO && worldSet.length > 0) problems.push(`${worldSet[0]![0]} is only allowed with MELAX_DEMO=1`);
  if (!e.MELAX_DEMO && e.DEMO_SEED) problems.push("DEMO_SEED is only allowed with MELAX_DEMO=1");
  if (problems.length > 0) refuse(problems);

  return {
    pepper: Buffer.from(e.MELAX_PEPPER, "hex"),
    demo: e.MELAX_DEMO,
    demoSeed: e.DEMO_SEED,
    demoWorld: worldSet.length === 3 ? { restUrl: world.DEMO_WORLD_LND_REST_URL!, macaroonPath: world.DEMO_WORLD_LND_MACAROON_PATH!, tlsCertPath: world.DEMO_WORLD_LND_TLS_CERT_PATH! } : null,
    webDir: e.WEB_DIR ?? null,
    databaseUrl: e.DATABASE_URL,
    mintUrl: e.MINT_URL,
    lnd: { restUrl: e.LND_REST_URL, macaroonPath: e.LND_MACAROON_PATH, tlsCertPath: e.LND_TLS_CERT_PATH },
    host: e.HOST,
    port: e.PORT,
    ussdCode: e.USSD_CODE,
    domain: e.ADDRESS_DOMAIN,
    at: e.AT_SECRET ? { secret: e.AT_SECRET, serviceCode: e.AT_SERVICE_CODE, allowIps } : null,
    ussdHttpSecret: e.USSD_HTTP_SECRET ?? null,
    smsOut,
    smsIn: { asgSigningKey: e.ASG_SIGNING_KEY ?? null, httpSmsSigningKey: e.HTTPSMS_SIGNING_KEY ?? null },
    rateFixed: e.RATE_FIXED_XOF_PER_BTC ?? null,
    trustProxy: e.TRUST_PROXY,
    stepBudgetMs: e.STEP_BUDGET_MS,
    logLevel: e.LOG_LEVEL,
  };
}
