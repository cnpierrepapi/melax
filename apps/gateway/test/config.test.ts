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

  it("refuses values that would break a screen or the books", () => {
    expect(() => loadConfig({ ...base, USSD_CODE: "2580" })).toThrow(/USSD_CODE/);
    expect(() => loadConfig({ ...base, ADDRESS_DOMAIN: "melax sn" })).toThrow(/ADDRESS_DOMAIN/);
    expect(() => loadConfig({ ...base, RATE_FIXED_XOF_PER_BTC: "0" })).toThrow(/RATE_FIXED_XOF_PER_BTC/);
    expect(() => loadConfig({ ...base, RATE_FIXED_XOF_PER_BTC: "abc" })).toThrow(/RATE_FIXED_XOF_PER_BTC/);
    expect(() => loadConfig({ ...base, PORT: "99999" })).toThrow(/PORT/);
    expect(loadConfig({ ...base, RATE_FIXED_XOF_PER_BTC: "40000000", PORT: "9000" })).toMatchObject({ rateFixed: 40_000_000, port: 9000 });
  });
});
