// The words on the web pages: complete in three languages, the same variables in each, no em dashes,
// and the phone screens the landing page plays are the ones the gateway really sends.
import { describe, expect, it } from "vitest";
import { fcfa, sats, t } from "@melax/i18n";
import { type CopyKey, LANGS, copy, say, screens } from "../src/copy.ts";

const keys = Object.keys(copy) as CopyKey[];
const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe("page copy", () => {
  it("every sentence exists in English, French and Wolof", () => {
    for (const k of keys) {
      for (const l of LANGS) {
        if (k === "wolof.note" && l !== "wo") continue; // the note about the Wolof is only shown in Wolof
        expect(copy[k][l].trim().length, `${k}/${l}`).toBeGreaterThan(0);
      }
    }
  });

  it("the three languages ask for the same variables", () => {
    for (const k of keys) {
      expect(vars(copy[k].fr), k).toEqual(vars(copy[k].en));
      expect(vars(copy[k].wo), k).toEqual(vars(copy[k].en));
    }
  });

  it("no em dash, no en dash, no curly quote, no exclamation mark", () => {
    for (const k of keys) for (const l of LANGS) expect(copy[k][l], `${k}/${l}`).not.toMatch(/[—–‘’“”!]/);
  });

  it("sentences stay short: nothing a small screen has to scroll through", () => {
    for (const k of keys) for (const l of LANGS) expect(copy[k][l].length, `${k}/${l}`).toBeLessThanOrEqual(190);
  });

  it("the Wolof page says its Wolof has not been reviewed", () => {
    expect(copy["wolof.note"].wo.length).toBeGreaterThan(20);
    expect(copy["not.7"].en).toMatch(/native speaker/);
  });

  it("say() fills variables and leaves an unknown one visible", () => {
    expect(say("en", "g3.t", { name: "Moussa" })).toBe("Send 500 F to Moussa");
    expect(say("fr", "guide.step", { n: 2 })).toBe("Étape 2 sur 4");
    expect(say("en", "g3.t")).toBe("Send 500 F to {name}");
  });
});

describe("the screens the landing page plays", () => {
  it("are the gateway's own words, in each language", () => {
    for (const l of LANGS) {
      const menu = [t(l, "home.title"), `1 ${t(l, "m.balance")}`, `2 ${t(l, "m.send")}`, `3 ${t(l, "m.receive")}`, `4 ${t(l, "m.pay")}`, `5 ${t(l, "m.deposit")}`, `6 ${t(l, "m.withdraw")}`, `0 ${t(l, "m.more")}`].join("\n");
      expect(screens[l]).toEqual([
        menu,
        t(l, "send.confirm", { fcfa: fcfa(500), sats: sats(1250), name: "Moussa", masked: "78*****02" }),
        t(l, "pin.ask"),
        t(l, "send.done", { fcfa: fcfa(500), name: "Moussa", receipt: 1006, balance: fcfa(12_500) }),
      ]);
    }
  });
});
