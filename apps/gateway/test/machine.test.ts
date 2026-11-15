// The wallet menus as a pure machine: every path replayed with scripted effect results. No network, no database.
// French transcripts are written out by hand below. The same flows in all three languages are kept as
// golden files in test/golden/ (review the diff when one changes).
import { describe, expect, it } from "vitest";
import { FakeClock } from "@melax/core";
import { LANGS, type Lang } from "@melax/i18n";
import { gsm7Septets, isGsm7 } from "@melax/sms";
import { MemorySessions, UssdRuntime } from "@melax/ussd";
import { type Effect, type Res, type S, PIN_STEPS, createWalletMachine, runtimeTexts } from "../src/ussd/machine.ts";

const CODE = "#2580#";
const machine = createWalletMachine({ code: CODE });
const PHONE = "+221771234567";
const PIN = "48291";
const NEW_PIN = "73915";
const D = (day: number) => Date.UTC(2026, 10, day);

type Responder = (e: Effect) => Res;
type Over = { [K in Effect["t"]]?: Res | ((e: Extract<Effect, { t: K }>) => Res) };

/** What the services answer when nothing goes wrong. `over` replaces single answers. */
function world(over: Over = {}, lang: Lang = "fr", registered = true): Responder {
  return (e) => {
    const o = over[e.t] as Res | ((x: Effect) => Res) | undefined;
    if (o) return typeof o === "function" ? o(e) : o;
    switch (e.t) {
      case "profile":
        return registered ? { ok: true, registered: true, lang, name: "Awa", role: "user" } : { ok: true, registered: false };
      case "register":
        return { ok: true, address: "kora-brave42@melax.sn" };
      case "balance":
        return { ok: true, fcfa: 5000, sats: 12_500, rate: 40_000_000 };
      case "resolve":
        return { ok: true, toRef: "u_moussa", name: "Moussa", masked: "78*****33" };
      case "quote":
        return { ok: true, sats: 1250 };
      case "send":
        return { ok: true, receipt: 1001, balanceFcfa: 4500 };
      case "receiveInfo":
      case "address":
        return { ok: true, address: "kora-brave42@melax.sn" };
      case "receiveSms":
        return { ok: true };
      case "history":
        return e.page === 0
          ? { ok: true, more: true, items: [{ ts: D(14), fcfa: -500, who: "Moussa" }, { ts: D(13), fcfa: 5000, who: "Fatou" }, { ts: D(12), fcfa: -1500, who: "Boutique Ndeye" }, { ts: D(11), fcfa: 250, who: "Ibra" }] }
          : { ok: true, more: false, items: [{ ts: D(9), fcfa: -2000, who: "Moussa" }] };
      case "pinChange":
        return { ok: true };
      case "setLang":
        return { ok: true, lang: e.lang };
      case "setAlias":
        return { ok: true, address: e.alias + "@melax.sn" };
      case "limits":
        return { ok: true, tier: 0, perTxFcfa: 25_000, dayLeftFcfa: 49_500, monthLeftFcfa: 199_500 };
    }
  };
}

/** Drives the machine the way the runtime does, without the runtime. Records every effect and every resting state. */
function play(respond: Responder = world(), opts: { shortcut?: string[] } = {}) {
  const effects: Effect[] = [];
  const states: S[] = [];
  let s = machine.initial({ phone: PHONE, shortcut: opts.shortcut ?? [] });
  const settle = () => {
    for (let hop = 0; hop < 16; hop++) {
      const step = machine.enter(s);
      if ("screen" in step) {
        states.push(s);
        expect(isGsm7(step.screen.text), step.screen.text).toBe(true);
        expect(gsm7Septets(step.screen.text), step.screen.text).toBeLessThanOrEqual(160);
        return step.screen;
      }
      effects.push(step.effect);
      s = machine.onResult(s, respond(step.effect));
    }
    throw new Error("machine did not settle on a screen");
  };
  let screen = settle();
  return {
    effects,
    states,
    get text() {
      return screen.text;
    },
    get ended() {
      return screen.end;
    },
    get state() {
      return s;
    },
    type(input: string): string {
      if (screen.end) throw new Error("the session has already ended");
      s = machine.onInput(s, input);
      screen = settle();
      return screen.text;
    },
  };
}

const HOME = "Melax\n1 Solde\n2 Envoyer\n3 Recevoir\n4 Payer marchand\n5 Depot\n6 Retrait\n0 Suite";
const HOME2 = "Melax\n7 Bons\n8 Historique\n9 Mon compte\n0 Retour";
const ACCOUNT = "Mon compte\n1 Code secret\n2 Langue\n3 Mon adresse\n4 Gardiens\n5 Limites\n6 Smartphone\n0 Retour";

describe("French transcripts", () => {
  it("a new number picks a language, sets a code, gives a name and gets an address", () => {
    const p = play(world({}, "fr", false));
    expect(p.text).toBe("Melax\n1 Francais\n2 Wolof\n3 English");
    expect(p.type("1")).toBe("Bienvenue sur Melax: du bitcoin sur ce telephone.\nChoisissez un code secret de 5 chiffres:");
    expect(p.type(PIN)).toBe("Retapez le code secret:");
    expect(p.type(PIN)).toBe("Votre prenom (montre a ceux qui vous envoient de l'argent):");
    expect(p.type("Awa")).toBe("Compte cree.\nVotre adresse: kora-brave42@melax.sn\nComposez #2580# pour l'utiliser.");
    expect(p.ended).toBe(true);
    expect(p.effects).toEqual([{ t: "profile" }, { t: "register", pin: PIN, name: "Awa", lang: "fr" }]);
  });

  it("home is two pages, and 7, 8 and 9 work from the first", () => {
    const p = play();
    expect(p.text).toBe(HOME);
    expect(p.type("0")).toBe(HOME2);
    expect(p.type("0")).toBe(HOME);
    expect(p.type("x")).toBe(HOME);
    expect(p.type("9")).toBe(ACCOUNT);
    expect(p.type("0")).toBe(HOME);
    expect(play().type("8")).toBe("Code secret:");
  });

  it("balance asks for the code, shows francs, sats and the rate, then goes back to the menu", () => {
    const p = play();
    expect(p.type("1")).toBe("Code secret:");
    expect(p.type(PIN)).toBe("Solde: 5 000 F\n(12 500 sats)\n1 BTC = 40 000 000 F\n0 Menu");
    expect(p.type("0")).toBe(HOME);
    expect(p.effects).toEqual([{ t: "profile" }, { t: "balance", pin: PIN }]);
  });

  it("send: number, amount, confirm with the name and both amounts, code last", () => {
    const p = play();
    expect(p.type("2")).toBe("Envoyer a:\nnumero (ex 771234567)\nou code de paiement (6 chiffres)");
    expect(p.type("781112233")).toBe("Montant en FCFA:");
    expect(p.type("500")).toBe("Envoyer 500 F (1 250 sats) a Moussa (78*****33)?\n1 Confirmer\n2 Annuler");
    expect(p.type("1")).toBe("Code secret:");
    expect(p.type(PIN)).toBe("Envoye: 500 F a Moussa.\nRecu no 1001\nSolde: 4 500 F");
    expect(p.ended).toBe(true);
    expect(p.effects).toEqual([
      { t: "profile" },
      { t: "resolve", to: "781112233" },
      { t: "quote", toRef: "u_moussa", fcfa: 500 },
      { t: "send", toRef: "u_moussa", fcfa: 500, sats: 1250, pin: PIN },
    ]);
  });

  it("receive shows the address and can text it", () => {
    const p = play();
    expect(p.type("3")).toBe("Pour recevoir, donnez votre numero, ou:\nkora-brave42@melax.sn\n1 Recevoir l'adresse par SMS\n0 Menu");
    expect(p.type("1")).toBe("Adresse envoyee par SMS.");
    expect(p.ended).toBe(true);
    expect(p.effects.map((e) => e.t)).toEqual(["profile", "receiveInfo", "receiveSms"]);
    const q = play();
    q.type("3");
    expect(q.type("0")).toBe(HOME);
  });

  it("history pages through the list and asks for the code once", () => {
    const p = play();
    expect(p.type("8")).toBe("Code secret:");
    expect(p.type(PIN)).toBe("14/11 -500 F Moussa\n13/11 +5 000 F Fatou\n12/11 -1 500 F Boutique Ndeye\n11/11 +250 F Ibra\n1 Suite\n0 Menu");
    expect(p.type("1")).toBe("09/11 -2 000 F Moussa\n0 Menu");
    expect(p.type("0")).toBe(HOME);
    expect(p.effects).toEqual([{ t: "profile" }, { t: "history", pin: PIN, page: 0 }, { t: "history", page: 1 }]);
  });

  it("an empty history says so and ends", () => {
    const p = play(world({ history: { ok: true, items: [], more: false } }));
    p.type("8");
    expect(p.type(PIN)).toBe("Aucune operation.");
    expect(p.ended).toBe(true);
  });

  it("changing the code asks the old one, then the new one twice", () => {
    const p = play();
    expect(p.type("9")).toBe(ACCOUNT);
    expect(p.type("1")).toBe("Code secret\n1 Changer le code\n2 Code oublie\n0 Retour");
    expect(p.type("1")).toBe("Ancien code secret:");
    expect(p.type(PIN)).toBe("Nouveau code (5 chiffres):");
    expect(p.type(NEW_PIN)).toBe("Retapez le nouveau code:");
    expect(p.type(NEW_PIN)).toBe("Code secret change.");
    expect(p.ended).toBe(true);
    expect(p.effects[1]).toEqual({ t: "pinChange", pin: PIN, newPin: NEW_PIN });
  });

  it("changing the language answers in the new language", () => {
    const p = play();
    p.type("9");
    expect(p.type("2")).toBe("Langue\n1 Francais\n2 Wolof\n3 English");
    expect(p.type("3")).toBe("Language: English.");
    expect(p.effects[1]).toEqual({ t: "setLang", lang: "en" });
  });

  it("the address can be read and renamed, with the code", () => {
    const p = play();
    p.type("9");
    expect(p.type("3")).toBe("Votre adresse:\nkora-brave42@melax.sn\n1 Changer le nom\n0 Menu");
    expect(p.type("1")).toBe("Nouveau nom (lettres, chiffres, tirets; 3 a 20):");
    expect(p.type("Awa-Dakar")).toBe("Code secret:");
    expect(p.type(PIN)).toBe("Nouvelle adresse:\nawa-dakar@melax.sn");
    expect(p.effects.at(-1)).toEqual({ t: "setAlias", alias: "awa-dakar", pin: PIN });
  });

  it("limits show the level and what is left", () => {
    const p = play();
    p.type("9");
    expect(p.type("5")).toBe("Niveau 0\nPar operation: 25 000 F\nReste aujourd'hui: 49 500 F\nReste ce mois: 199 500 F\n0 Menu");
    expect(p.type("0")).toBe(HOME);
  });

  it("entries that belong to later phases say so and end", () => {
    const soon = "Bientot disponible sur Melax.";
    for (const path of [["4"], ["5"], ["6"], ["7"], ["0", "7"], ["9", "4"], ["9", "6"], ["9", "1", "2"], ["2", "123456"]]) {
      const p = play();
      let last = "";
      for (const k of path) last = p.type(k);
      expect(last, path.join(">")).toBe(soon);
      expect(p.ended).toBe(true);
    }
  });
});

describe("the secret code", () => {
  it("a wrong code returns to the prompt with the tries left, and the right one then works", () => {
    let n = 0;
    const p = play(world({ balance: () => (n++ === 0 ? { ok: false, err: "PIN_WRONG", left: 4 } : { ok: true, fcfa: 5000, sats: 12_500, rate: 40_000_000 }) }));
    p.type("1");
    expect(p.type("00000")).toBe("Code faux. Essais restants: 4.\nCode secret:");
    expect(JSON.stringify(p.state)).not.toContain("00000");
    expect(p.type(PIN)).toContain("Solde: 5 000 F");
  });

  it("a locked code ends the session", () => {
    const p = play(world({ send: { ok: false, err: "PIN_LOCKED", minutes: 15 } }));
    for (const k of ["2", "781112233", "500", "1"]) p.type(k);
    expect(p.type("00000")).toBe("Code bloque pendant 15 min.");
    expect(p.ended).toBe(true);
  });

  it("a wrong code on a send goes back to the code prompt, not to the start", () => {
    let n = 0;
    const p = play(world({ send: () => (n++ === 0 ? { ok: false, err: "PIN_WRONG", left: 3 } : { ok: true, receipt: 1002, balanceFcfa: 4500 }) }));
    for (const k of ["2", "781112233", "500", "1"]) p.type(k);
    expect(p.type("11111")).toBe("Code faux. Essais restants: 3.\nCode secret:");
    expect(p.type(PIN)).toContain("Recu no 1002");
    expect(p.effects.filter((e) => e.t === "send")).toHaveLength(2);
  });

  it("onboarding refuses two different codes and codes that are easy to guess", () => {
    const p = play(world({}, "fr", false));
    p.type("1");
    expect(p.type("12345")).toBe("Code trop facile a deviner.\nChoisissez un autre code de 5 chiffres:");
    expect(p.type("1234")).toBe("Code trop facile a deviner.\nChoisissez un autre code de 5 chiffres:");
    expect(p.type("abcde")).toBe("Code trop facile a deviner.\nChoisissez un autre code de 5 chiffres:");
    expect(p.type(PIN)).toBe("Retapez le code secret:");
    expect(p.type("48292")).toBe("Les deux codes sont differents.\nChoisissez un code secret de 5 chiffres:");
    expect(JSON.stringify(p.state)).not.toContain(PIN);
    expect(p.effects.map((e) => e.t)).toEqual(["profile"]);
  });

  it("onboarding goes back to the code when the server finds it weak (digits of the phone number)", () => {
    const p = play(world({ register: { ok: false, err: "BAD_INPUT", why: "weak" } }, "fr", false));
    for (const k of ["1", "71234", "71234"]) p.type(k);
    expect(p.type("Awa")).toBe("Code trop facile a deviner.\nChoisissez un autre code de 5 chiffres:");
    expect(JSON.stringify(p.state)).not.toContain("71234");
  });

  it("a name must be 2 to 16 letters", () => {
    const p = play(world({}, "fr", false));
    for (const k of ["1", PIN, PIN]) p.type(k);
    const bad = "Prenom: 2 a 16 lettres.\nVotre prenom:";
    expect(p.type("A")).toBe(bad);
    expect(p.type("Awa123")).toBe(bad);
    expect(p.type("Abdoulaye-Karim Ndiaye")).toBe(bad);
    expect(p.type("Aïssatou")).toContain("Compte cree.");
    expect(p.effects.at(-1)).toMatchObject({ t: "register", name: "Aissatou" });
  });

  it("changing the code: mismatch, weak, wrong old code", () => {
    const p = play(world({ pinChange: { ok: false, err: "PIN_WRONG", left: 2 } }));
    for (const k of ["9", "1", "1", PIN]) p.type(k);
    expect(p.type("11111")).toBe("Code trop facile a deviner.\nChoisissez un autre code de 5 chiffres:");
    expect(p.type(NEW_PIN)).toBe("Retapez le nouveau code:");
    expect(p.type("73916")).toBe("Les deux codes sont differents.\nChoisissez un code secret de 5 chiffres:");
    expect(p.type(NEW_PIN)).toBe("Retapez le nouveau code:");
    expect(p.type(NEW_PIN)).toBe("Code faux. Essais restants: 2.\nCode secret:");
    expect(JSON.stringify(p.state)).not.toContain(PIN);
    expect(JSON.stringify(p.state)).not.toContain(NEW_PIN);
  });

  it("no state holds a code once its effect has run, in any flow", () => {
    const flows = [["1", PIN, "0"], ["2", "781112233", "500", "1", PIN], ["8", PIN, "1", "0"], ["9", "1", "1", PIN, NEW_PIN, NEW_PIN], ["9", "3", "1", "awa-dakar", PIN]];
    for (const flow of flows) {
      const p = play();
      for (const k of flow) p.type(k);
      expect(JSON.stringify(p.state), flow.join(">")).not.toContain(PIN);
      expect(JSON.stringify(p.state), flow.join(">")).not.toContain(NEW_PIN);
    }
  });
});

describe("sending: what can go wrong before and after the code", () => {
  it("refuses a recipient that is not a number, without asking the server", () => {
    const p = play();
    p.type("2");
    expect(p.type("abc")).toBe("Numero ou code invalide.\nNumero ou code de paiement:");
    expect(p.type("77 12")).toBe("Numero ou code invalide.\nNumero ou code de paiement:");
    expect(p.effects.map((e) => e.t)).toEqual(["profile"]);
  });

  it("names the three ways a number can be refused by the server", () => {
    const answers: Array<[Res, string]> = [
      [{ ok: false, err: "BAD_INPUT" }, "Numero ou code invalide.\nNumero ou code de paiement:"],
      [{ ok: false, err: "BAD_INPUT", why: "self" }, "C'est votre propre numero.\nNumero ou code de paiement:"],
      [{ ok: false, err: "NOT_FOUND" }, "Ce numero n'a pas de compte Melax.\nNumero ou code de paiement:"],
    ];
    for (const [res, text] of answers) {
      const p = play(world({ resolve: res }));
      p.type("2");
      expect(p.type("771234567")).toBe(text);
      expect(p.ended).toBe(false);
    }
  });

  it("refuses an amount of 0, with letters, negative or absurdly long", () => {
    const p = play();
    p.type("2");
    p.type("781112233");
    const bad = "Montant invalide.\nMontant en FCFA:";
    for (const a of ["0", "5oo", "-5", "000", "12345678", "1.5", ""]) expect(p.type(a), a).toBe(bad);
    expect(p.type("1 500")).toContain("Envoyer 1 500 F");
    expect(p.effects.filter((e) => e.t === "quote")).toEqual([{ t: "quote", toRef: "u_moussa", fcfa: 1500 }]);
  });

  it("an amount above a limit says which limit and lets the user type another", () => {
    const cases: Array<[Res, string]> = [
      [{ ok: false, err: "LIMIT", reason: "PER_TX", allowedFcfa: 25_000 }, "Maximum par operation: 25 000 F.\nMontant en FCFA:"],
      [{ ok: false, err: "LIMIT", reason: "PER_DAY", allowedFcfa: 1200 }, "Limite du jour atteinte. Reste: 1 200 F.\nMontant en FCFA:"],
      [{ ok: false, err: "LIMIT", reason: "PER_MONTH", allowedFcfa: 0 }, "Limite du mois atteinte. Reste: 0 F.\nMontant en FCFA:"],
      [{ ok: false, err: "LIMIT", reason: "NEW_RECIPIENT", allowedFcfa: 10_000 }, "Premier envoi a ce numero: maximum 10 000 F.\nMontant en FCFA:"],
      [{ ok: false, err: "INSUFFICIENT_FUNDS", balanceFcfa: 300 }, "Solde insuffisant.\nSolde: 300 F\nMontant en FCFA:"],
    ];
    for (const [res, text] of cases) {
      let n = 0;
      const p = play(world({ quote: () => (n++ === 0 ? res : { ok: true, sats: 250 }) }));
      p.type("2");
      p.type("781112233");
      expect(p.type("30000")).toBe(text);
      expect(p.type("100")).toContain("Envoyer 100 F (250 sats)");
    }
  });

  it("cancel at the confirm screen ends without a send; any other key shows the screen again", () => {
    const p = play();
    for (const k of ["2", "781112233", "500"]) p.type(k);
    const confirm = p.text;
    expect(p.type("7")).toBe(confirm);
    expect(p.type("2")).toBe("Annule.");
    expect(p.ended).toBe(true);
    expect(p.effects.some((e) => e.t === "send")).toBe(false);
  });

  it("every refusal after the code has its own closing screen", () => {
    const cases: Array<[Res, string]> = [
      [{ ok: false, err: "INSUFFICIENT_FUNDS", balanceFcfa: 300 }, "Solde insuffisant.\nSolde: 300 F"],
      [{ ok: false, err: "LIMIT", reason: "PER_DAY", allowedFcfa: 0 }, "Limite du jour atteinte. Reste: 0 F."],
      [{ ok: false, err: "BUSY" }, "Une operation est deja en cours. Reessayez dans une minute."],
      [{ ok: false, err: "PAUSED" }, "Service en pause. Votre argent est en securite. Reessayez plus tard."],
      [{ ok: false, err: "FROZEN", hours: 24 }, "Envois bloques 24 h apres le changement de code. Votre argent est en securite."],
      [{ ok: false, err: "PENDING" }, "Operation en cours. Vous recevrez un SMS."],
      [{ ok: false, err: "REPORTED" }, "Attention: ce destinataire a ete signale pour arnaque. Envoi refuse."],
      [{ ok: false, err: "NOT_FOUND" }, "Service indisponible. Reessayez."],
      [{ ok: false, err: "GENERIC" }, "Service indisponible. Reessayez."],
    ];
    for (const [res, text] of cases) {
      const p = play(world({ send: res }));
      for (const k of ["2", "781112233", "500", "1"]) p.type(k);
      expect(p.type(PIN), res.err).toBe(text);
      expect(p.ended).toBe(true);
      expect(JSON.stringify(p.state)).not.toContain(PIN);
    }
  });

  it("a server failure on a harmless step ends with the generic message", () => {
    for (const [t, keys] of [["receiveInfo", ["3"]], ["limits", ["9", "5"]], ["address", ["9", "3"]]] as const) {
      const p = play(world({ [t]: { ok: false, err: "GENERIC" } }));
      let last = "";
      for (const k of keys) last = p.type(k);
      expect(last).toBe("Service indisponible. Reessayez.");
      expect(p.ended).toBe(true);
    }
    const first = play(world({ profile: { ok: false, err: "GENERIC" } }));
    expect(first.text).toBe("Service indisponible. Reessayez.");
  });

  it("a name that is taken or malformed goes back to the name prompt", () => {
    const p = play(world({ setAlias: { ok: false, err: "BAD_INPUT", why: "taken" } }));
    for (const k of ["9", "3", "1"]) p.type(k);
    const bad = "Nom invalide ou deja pris.\nNouveau nom:";
    expect(p.type("a")).toBe(bad);
    expect(p.type("awa dakar")).toBe(bad);
    expect(p.type("-awa")).toBe(bad);
    expect(p.type("awa-dakar")).toBe("Code secret:");
    expect(p.type(PIN)).toBe(bad);
  });
});

describe("dial strings", () => {
  it("#2580*2*781112233*500# lands on the confirm screen", () => {
    const p = play(world(), { shortcut: ["2", "781112233", "500"] });
    expect(p.text).toBe("Envoyer 500 F (1 250 sats) a Moussa (78*****33)?\n1 Confirmer\n2 Annuler");
    expect(p.effects.map((e) => e.t)).toEqual(["profile", "resolve", "quote"]);
  });

  it("a queued input is never fed to a code prompt: the rest of the dial string is dropped there", () => {
    const p = play(world(), { shortcut: ["2", "781112233", "500", "1", PIN] });
    expect(p.text).toBe("Code secret:");
    expect(p.effects.some((e) => e.t === "send")).toBe(false);
    expect(p.state.q).toEqual([]);
    expect(JSON.stringify(p.state)).not.toContain(PIN);

    const b = play(world(), { shortcut: ["1", PIN] });
    expect(b.text).toBe("Code secret:");
    expect(b.effects.some((e) => e.t === "balance")).toBe(false);
    expect(JSON.stringify(b.state)).not.toContain(PIN);

    const c = play(world(), { shortcut: ["9", "1", "1", PIN, NEW_PIN, NEW_PIN] });
    expect(c.text).toBe("Ancien code secret:");
    expect(JSON.stringify(c.state)).not.toContain(PIN);
  });

  it("an input that does not fit drops the rest of the dial string", () => {
    const p = play(world(), { shortcut: ["2", "abc", "500"] });
    expect(p.text).toBe("Numero ou code invalide.\nNumero ou code de paiement:");
    expect(p.state.q).toEqual([]);
  });

  it("a number with no account is taken to onboarding whatever it dialled", () => {
    const p = play(world({}, "fr", false), { shortcut: ["2", "781112233", "500"] });
    expect(p.text).toBe("Melax\n1 Francais\n2 Wolof\n3 English");
    expect(p.state.q).toEqual([]);
  });

  it("a very long dial string is cut, not followed", () => {
    const p = play(world(), { shortcut: Array.from({ length: 40 }, () => "0") });
    expect([HOME, HOME2]).toContain(p.text);
  });
});

describe("picking up a dropped session", () => {
  const flows = [
    ["1", PIN, "0"],
    ["2", "781112233", "500", "1", "00000"],
    ["3", "0"],
    ["8", PIN, "1"],
    ["9", "1", "1", PIN, NEW_PIN],
    ["9", "2"],
    ["9", "3", "1", "awa-dakar"],
    ["9", "5"],
    ["0"],
  ];

  it("never resumes at a code prompt, and never with a code in the state", () => {
    let checked = 0;
    const responders = [world(), world({ send: { ok: false, err: "PIN_WRONG", left: 4 } }), world({}, "fr", false)];
    for (const respond of responders) {
      for (const flow of [...flows, ["1", PIN, PIN, "Awa"]]) {
        const p = play(respond);
        for (const k of flow) if (!p.ended) p.type(k);
        for (const s of p.states) {
          const rp = machine.resumePoint!(s);
          checked++;
          if (rp === null) continue;
          expect(PIN_STEPS.has(rp.at), `${s.at} -> ${rp.at}`).toBe(false);
          const dump = JSON.stringify(rp);
          for (const secret of [PIN, NEW_PIN, "00000"]) expect(dump, `${s.at} -> ${rp.at}`).not.toContain(secret);
          expect(rp.q).toEqual([]);
          // the point named must be a screen, not an effect
          expect("screen" in machine.enter(rp), rp.at).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  it("maps each code prompt to the step above it", () => {
    const at = (flow: string[]) => {
      const p = play();
      for (const k of flow) p.type(k);
      return machine.resumePoint!(p.state)?.at ?? null;
    };
    expect(at(["2", "781112233", "500", "1"])).toBe("send.confirm");
    expect(at(["2", "781112233", "500"])).toBe("send.confirm");
    expect(at(["2", "781112233"])).toBe("send.amount");
    expect(at(["1"])).toBe(null);
    expect(at(["8"])).toBe(null);
    expect(at(["1", PIN])).toBe(null); // a balance already on screen is not shown again without the code
    expect(at(["8", PIN])).toBe(null);
    expect(at(["9", "1", "1"])).toBe("acct");
    expect(at(["9", "1", "1", PIN])).toBe("acct");
    expect(at(["9", "3", "1", "awa-dakar"])).toBe("acct");
    expect(at(["9"])).toBe("acct");
    expect(at([])).toBe(null); // the first menu is where a fresh dial starts anyway
  });

  it("through the runtime: a session dropped at the code prompt is offered again at the confirm screen", async () => {
    const clock = new FakeClock();
    const respond = world();
    const rt = new UssdRuntime<S, Effect, Res>({ machine, perform: async (e) => respond(e), sessions: new MemorySessions<S>(), texts: runtimeTexts(CODE), clock });
    const go = (sessionId: string, input: string) => rt.handle({ sessionId, phone: PHONE, input, shortcut: [] }).then((s) => s.text);
    await go("a", "");
    for (const k of ["2", "781112233", "500", "1"]) await go("a", k);
    clock.advance(30_000);
    expect(await go("b", "")).toBe("Reprendre ou vous en etiez?\n1 Oui\n2 Non");
    expect(await go("b", "1")).toBe("Envoyer 500 F (1 250 sats) a Moussa (78*****33)?\n1 Confirmer\n2 Annuler");
    expect(await go("b", "1")).toBe("Code secret:");
    expect(await go("b", PIN)).toBe("Envoye: 500 F a Moussa.\nRecu no 1001\nSolde: 4 500 F");
    // a finished session leaves nothing to pick up
    expect(await go("c", "")).toBe(HOME);
  });

  it("through the runtime: the closing texts follow the user's language", async () => {
    const clock = new FakeClock();
    const respond = world({}, "en");
    const rt = new UssdRuntime<S, Effect, Res>({ machine, perform: async (e) => respond(e), sessions: new MemorySessions<S>(), texts: runtimeTexts(CODE), clock });
    await rt.handle({ sessionId: "x", phone: PHONE, input: "", shortcut: [] });
    clock.advance(121_000);
    expect((await rt.handle({ sessionId: "x", phone: PHONE, input: "1", shortcut: [] })).text).toBe("Session expired. Dial #2580# again.");
  });

  it("through the runtime: a slow send says an SMS will follow, a slow lookup does not promise one", async () => {
    const slow = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const respond = world();
    const rt = new UssdRuntime<S, Effect, Res>({
      machine,
      perform: async (e) => {
        if (e.t === "send" || e.t === "limits") await slow(120);
        return respond(e);
      },
      sessions: new MemorySessions<S>(),
      texts: runtimeTexts(CODE),
      stepBudgetMs: 30,
    });
    const go = (sessionId: string, input: string) => rt.handle({ sessionId, phone: PHONE, input, shortcut: [] }).then((s) => s.text);
    await go("s", "");
    for (const k of ["2", "781112233", "500", "1"]) await go("s", k);
    expect(await go("s", PIN)).toBe("Operation en cours. Vous recevrez un SMS.");
    await go("l", "");
    await go("l", "9");
    expect(await go("l", "5")).toBe("Service indisponible. Reessayez.");
    await slow(150);
  });
});

describe("every screen fits a phone in all three languages", () => {
  const LANG_KEY: Record<Lang, string> = { fr: "1", wo: "2", en: "3" };
  const flows: Record<string, { inputs: (l: Lang) => string[]; registered?: boolean }> = {
    onboarding: { inputs: (l) => [LANG_KEY[l], PIN, PIN, "Awa"], registered: false },
    home: { inputs: () => ["0", "0"] },
    balance: { inputs: () => ["1", PIN, "0"] },
    send: { inputs: () => ["2", "781112233", "500", "1", PIN] },
    receive: { inputs: () => ["3", "1"] },
    history: { inputs: () => ["8", PIN, "1", "0"] },
    "pin-change": { inputs: () => ["9", "1", "1", PIN, NEW_PIN, NEW_PIN] },
    language: { inputs: (l) => ["9", "2", LANG_KEY[l]] },
    address: { inputs: () => ["9", "3", "1", "awa-dakar", PIN] },
    limits: { inputs: () => ["9", "5", "0"] },
    "coming-soon": { inputs: () => ["4"] },
  };

  for (const [name, flow] of Object.entries(flows)) {
    for (const lang of LANGS) {
      it(`${name} in ${lang} matches its golden file`, async () => {
        const p = play(world({}, lang, flow.registered ?? true));
        const lines = [`dial ${CODE}`, p.text];
        for (const k of flow.inputs(lang)) {
          // codes are written as stars in the golden files, the way a careful person would copy them
          lines.push("", `> ${k === PIN || k === NEW_PIN ? "*****" : k}`, p.type(k));
        }
        await expect(lines.join("\n") + "\n").toMatchFileSnapshot(`./golden/${name}.${lang}.txt`);
      });
    }
  }

  it("the longest values a user can produce still fit on every screen", () => {
    const long = "Abdoulaye-Karim.";
    const worst = (lang: Lang) =>
      world(
        {
          balance: { ok: true, fcfa: 99_999_999, sats: 999_999_999, rate: 99_999_999 },
          resolve: { ok: true, toRef: "u_x", name: long, masked: "+2250*******89" },
          quote: { ok: true, sats: 9_999_999 },
          send: { ok: true, receipt: 99_999_999, balanceFcfa: 99_999_999 },
          receiveInfo: { ok: true, address: "kinkeliba-vaillant42@pay.melax.example" },
          address: { ok: true, address: "kinkeliba-vaillant42@pay.melax.example" },
          setAlias: { ok: true, address: "abcdefghijklmnopqrst@pay.melax.example" },
          history: { ok: true, more: true, items: Array.from({ length: 6 }, () => ({ ts: D(28), fcfa: -9_999_999, who: "Boutique Ndeye Fatou Diop" })) },
          limits: { ok: true, tier: 2, perTxFcfa: 250_000, dayLeftFcfa: 500_000, monthLeftFcfa: 2_000_000 },
        },
        lang,
      );
    for (const lang of LANGS) {
      for (const inputs of [["1", PIN], ["2", "781112233", "9999999", "1", PIN], ["3"], ["8", PIN, "1"], ["9", "3", "1", "abcdefghijklmnopqrst", PIN], ["9", "5"]]) {
        const p = play(worst(lang));
        for (const k of inputs) p.type(k); // play() checks GSM-7 and 160 characters on every screen
        expect(p.text.length).toBeGreaterThan(0);
      }
      for (const res of [
        { ok: false, err: "INSUFFICIENT_FUNDS", balanceFcfa: 99_999_999 },
        { ok: false, err: "LIMIT", reason: "NEW_RECIPIENT", allowedFcfa: 250_000 },
        { ok: false, err: "PIN_LOCKED", minutes: 1440 },
        { ok: false, err: "FROZEN", hours: 24 },
      ] as Res[]) {
        const p = play(world({ send: res, quote: res.err === "PIN_LOCKED" || res.err === "FROZEN" ? { ok: true, sats: 1 } : res }, lang));
        for (const k of ["2", "781112233", "9999999"]) p.type(k);
        if (!p.ended && p.text.includes("1 ")) {
          p.type("1");
          if (!p.ended) p.type(PIN);
        }
      }
    }
  });
});
