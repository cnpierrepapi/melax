import { describe, expect, it } from "vitest";
import { gsm7Septets, isGsm7, smsSegments } from "@melax/sms";
import { LANGS, type MessageKey, WOLOF_REVIEWED, clip, messages, placeholders, shortDate, t } from "../src/index.ts";

const keys = Object.keys(messages) as MessageKey[];

// The longest value each variable can take in practice. Screens are checked against these.
const WORST: Record<string, string> = {
  fcfa: "250 000 F", sats: "1 234 567 sats", name: "Abdoulaye-Karim.", masked: "77*****67", address: "kinkeliba-vaillant42@melax.sn", code: "K7MP-2XQR-9TWB-4HNC",
  receipt: "123456", balance: "1 250 000 F", rate: "61 850 000 F", agent: "Moussa Telecom 2", method: "Orange Money", number: "77 123 45 67", ref: "D-48213", shop: "Boutique Ndeye Fatou",
  label: "kora-brave42@melax.sn", list: "77*****67\n78*****12\n76*****03", url: "melax.sn/bon", ussd: "#2580#", tier: "2", tx: "250 000 F", day: "500 000 F", month: "2 000 000 F", premium: "1.5",
  methods: "Wave, Orange Money", min: "1 000 F", max: "250 000 F", state: "En pause.", count: "999", mcode: "12345", comment: 'Msg: "Joyeux anniversaire maman". ', reason: "Promesse de doubler votre argent.",
  hours: "24", minutes: "1440", left: "4", n: "3", allowed: "250 000 F",
};
// Variables whose value is the dial code, not a voucher code.
const fill = (key: MessageKey, lang: (typeof LANGS)[number]) => {
  const vars: Record<string, string> = {};
  for (const p of placeholders(key, lang)) {
    expect(WORST[p], `no worst case for {${p}} (${key})`).toBeDefined();
    vars[p] = WORST[p]!;
  }
  if ("code" in vars && !key.startsWith("vch.") && !key.startsWith("sms.voucher")) vars.code = "#2580#";
  return t(lang, key, vars);
};

describe("messages", () => {
  it("every message exists in French, Wolof and English", () => {
    for (const k of keys) for (const l of LANGS) if (k !== "scam.r.none") expect(messages[k][l].length, `${k}/${l}`).toBeGreaterThan(0);
  });
  it("every message is GSM-7: no accent or symbol that would switch an SMS to 70-character parts", () => {
    for (const k of keys) for (const l of LANGS) expect(isGsm7(messages[k][l]), `${k}/${l}: ${messages[k][l]}`).toBe(true);
  });
  it("the three languages ask for the same variables", () => {
    for (const k of keys) {
      const fr = placeholders(k, "fr");
      expect(placeholders(k, "wo"), k).toEqual(fr);
      expect(placeholders(k, "en"), k).toEqual(fr);
    }
  });
  it("no USSD message can pass 160 characters, even with the longest values", () => {
    for (const k of keys) {
      if (k.startsWith("sms.")) continue;
      for (const l of LANGS) {
        const text = fill(k, l);
        expect(gsm7Septets(text), `${k}/${l} is ${text.length}: ${text}`).toBeLessThanOrEqual(160);
      }
    }
  });
  it("no SMS needs more than two parts, and most fit in one", () => {
    let single = 0;
    let total = 0;
    for (const k of keys) {
      if (!k.startsWith("sms.")) continue;
      for (const l of LANGS) {
        const n = smsSegments(fill(k, l));
        expect(n, `${k}/${l}`).toBeLessThanOrEqual(2);
        total++;
        if (n === 1) single++;
      }
    }
    expect(single / total).toBeGreaterThan(0.6);
  });
  it("a missing variable is an error, never a screen with braces in it", () => {
    expect(() => t("fr", "send.done", { fcfa: "500 F" })).toThrow();
    expect(t("fr", "pin.locked", { minutes: 15 })).toBe("Code bloque pendant 15 min.");
  });
  it("Wolof is flagged as not yet reviewed by a native speaker", () => {
    expect(WOLOF_REVIEWED).toBe(false);
  });
});

describe("helpers", () => {
  it("clip folds accents, removes line breaks and shortens", () => {
    expect(clip("Aïssatou\nNdèye", 16)).toBe("Aissatou Ndèye");
    expect(clip("Abdoulaye-Karim Ndiaye", 16)).toBe("Abdoulaye-Karim.");
    expect(clip("😀", 5)).toBe("?");
  });
  it("shortDate is dd/mm", () => {
    expect(shortDate(Date.UTC(2026, 10, 14))).toBe("14/11");
  });
});
