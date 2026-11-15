// Configuration: what must be set, what is refused, and that a refusal never repeats a secret.
import { describe, expect, it } from "vitest";
import { AppError } from "@melax/core";
import { loadConfig } from "../src/config.ts";

const PEPPER = "ab".repeat(32);
const base = { MELAX_PEPPER: PEPPER, MELAX_DEMO: "1" };

describe("configuration", () => {
  it("starts in demo mode from a pepper alone, with nothing optional mounted", () => {
    const c = loadConfig(base);
    expect(c.pepper).toHaveLength(32);
    expect(c).toMatchObject({ demo: true, port: 8787, ussdCode: "#2580#", at: null, ussdHttpSecret: null, smsOut: { adapter: "memory" }, smsIn: { asgSigningKey: null, httpSmsSigningKey: null }, rateFixed: null, stepBudgetMs: 12_000 });
  });

  it("the escrow's block delta must hold a cash-in past the 3 hour cap on the network in use", () => {
    // bitcoin: LND's default of 80 blocks at 10 minutes a block is far past 3 hours
    expect(loadConfig(base).escrow).toEqual({ cltvBlocks: 80, blockSeconds: 600 });
    // regtest at 30 s a block: 80 blocks lasted 32.5 minutes (scripts/probe/hold-cltv-probe.ts). Refused.
    expect(() => loadConfig({ ...base, ESCROW_BLOCK_SECONDS: "30" })).toThrow(/ESCROW_CLTV_BLOCKS/);
    // 381 blocks: (381 - 22) * 30 s is 2 h 59 min 30 s. One block more covers it.
    expect(() => loadConfig({ ...base, ESCROW_BLOCK_SECONDS: "30", ESCROW_CLTV_BLOCKS: "381" })).toThrow(/ESCROW_CLTV_BLOCKS/);
    expect(loadConfig({ ...base, ESCROW_BLOCK_SECONDS: "30", ESCROW_CLTV_BLOCKS: "382" }).escrow).toEqual({ cltvBlocks: 382, blockSeconds: 30 });
    expect(loadConfig({ ...base, ESCROW_BLOCK_SECONDS: "30", ESCROW_CLTV_BLOCKS: "432" }).escrow.cltvBlocks).toBe(432);
    // above what a payer's node accepts (the probe's world node did not pay at 2100)
    expect(() => loadConfig({ ...base, ESCROW_CLTV_BLOCKS: "2100" })).toThrow(/ESCROW_CLTV_BLOCKS/);
  });

  it("the arbiter's secret is optional, and short ones are refused without being repeated", () => {
    expect(loadConfig(base).operatorSecret).toBeNull();
    expect(loadConfig({ ...base, OPERATOR_SECRET: "o".repeat(24) }).operatorSecret).toBe("o".repeat(24));
    expect(() => loadConfig({ ...base, OPERATOR_SECRET: "letmein" })).toThrow(/OPERATOR_SECRET/);
    try {
      loadConfig({ ...base, OPERATOR_SECRET: "letmein" });
    } catch (e) {
      expect((e as Error).message).not.toContain("letmein");
    }
  });

  it("refuses to start without a pepper, or with a short one", () => {
    expect(() => loadConfig({})).toThrow(AppError);
    expect(() => loadConfig({ MELAX_PEPPER: "abcd" })).toThrow(/MELAX_PEPPER/);
    expect(() => loadConfig({ MELAX_PEPPER: "zz".repeat(32) })).toThrow(/MELAX_PEPPER/);
  });

  it("never repeats a secret in the error it throws", () => {
    const secrets = { MELAX_PEPPER: "12".repeat(20), AT_SECRET: "short-secret", USSD_HTTP_SECRET: "tiny", ASG_SIGNING_KEY: "k" };
    let message = "";
    try {
      loadConfig(secrets);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("MELAX_PEPPER");
    expect(message).toContain("AT_SECRET");
    for (const v of Object.values(secrets)) expect(message).not.toContain(v);
  });

  it("outside demo mode an SMS has to leave for real", () => {
    expect(() => loadConfig({ MELAX_PEPPER: PEPPER })).toThrow(/SMS_ADAPTER=memory/);
    expect(() => loadConfig({ MELAX_PEPPER: PEPPER, SMS_ADAPTER: "asg" })).toThrow(/ASG_URL/);
    const c = loadConfig({ MELAX_PEPPER: PEPPER, SMS_ADAPTER: "asg", ASG_URL: "http://192.168.1.10:8080", ASG_USER: "u", ASG_PASSWORD: "p" });
    expect(c.smsOut).toEqual({ adapter: "asg", url: "http://192.168.1.10:8080", user: "u", password: "p" });
    expect(c.demo).toBe(false);
  });

  it("the unsigned Africa's Talking route needs an allow-list outside demo mode", () => {
    const live = { MELAX_PEPPER: PEPPER, SMS_ADAPTER: "asg", ASG_URL: "http://x", ASG_USER: "u", ASG_PASSWORD: "p", AT_SECRET: "a".repeat(32) };
    expect(() => loadConfig(live)).toThrow(/AT_ALLOW_IPS/);
    expect(loadConfig({ ...live, AT_ALLOW_IPS: "196.201.214.200, 196.201.214.206" }).at).toEqual({ secret: "a".repeat(32), serviceCode: undefined, allowIps: ["196.201.214.200", "196.201.214.206"] });
    expect(loadConfig({ ...base, AT_SECRET: "a".repeat(32) }).at?.allowIps).toEqual([]);
  });

  it("a variable that is set but empty counts as not set", () => {
    const c = loadConfig({ ...base, RATE_FIXED_XOF_PER_BTC: "", PORT: " ", AT_SECRET: "", USSD_CODE: "" });
    expect(c).toMatchObject({ rateFixed: null, port: 8787, at: null, ussdCode: "#2580#" });
    expect(() => loadConfig({ MELAX_PEPPER: "" })).toThrow(/MELAX_PEPPER/);
  });

  it("the regtest top-up node needs all three of its settings, and exists in demo mode only", () => {
    const world = { DEMO_WORLD_LND_REST_URL: "https://lnd-world:8080", DEMO_WORLD_LND_MACAROON_PATH: "/keys/lnd-world/admin.macaroon", DEMO_WORLD_LND_TLS_CERT_PATH: "/keys/lnd-world/tls.cert" };
    expect(loadConfig(base)).toMatchObject({ demoWorld: null, demoSeed: false, webDir: null });
    expect(loadConfig({ ...base, ...world, DEMO_SEED: "1", WEB_DIR: "/app/apps/simulator/dist" })).toMatchObject({
      demoWorld: { restUrl: "https://lnd-world:8080", macaroonPath: "/keys/lnd-world/admin.macaroon", tlsCertPath: "/keys/lnd-world/tls.cert" },
      demoSeed: true,
      webDir: "/app/apps/simulator/dist",
    });
    expect(() => loadConfig({ ...base, DEMO_WORLD_LND_REST_URL: world.DEMO_WORLD_LND_REST_URL })).toThrow(/DEMO_WORLD_LND_MACAROON_PATH/);
    const live = { MELAX_PEPPER: PEPPER, SMS_ADAPTER: "asg", ASG_URL: "http://x", ASG_USER: "u", ASG_PASSWORD: "p" };
    expect(() => loadConfig({ ...live, ...world })).toThrow(/DEMO_WORLD_LND_REST_URL is only allowed with MELAX_DEMO=1/);
    expect(() => loadConfig({ ...live, DEMO_SEED: "1" })).toThrow(/DEMO_SEED is only allowed with MELAX_DEMO=1/);
  });

  it("refuses values that would break a screen or the books", () => {
    expect(() => loadConfig({ ...base, USSD_CODE: "2580" })).toThrow(/USSD_CODE/);
    expect(() => loadConfig({ ...base, ADDRESS_DOMAIN: "melax sn" })).toThrow(/ADDRESS_DOMAIN/);
    expect(() => loadConfig({ ...base, RATE_FIXED_XOF_PER_BTC: "0" })).toThrow(/RATE_FIXED_XOF_PER_BTC/);
    expect(() => loadConfig({ ...base, RATE_FIXED_XOF_PER_BTC: "abc" })).toThrow(/RATE_FIXED_XOF_PER_BTC/);
    expect(() => loadConfig({ ...base, PORT: "99999" })).toThrow(/PORT/);
    expect(loadConfig({ ...base, RATE_FIXED_XOF_PER_BTC: "40000000", PORT: "9000" })).toMatchObject({ rateFixed: 40_000_000, port: 9000 });
  });
});
