// The menus through the real runtime and the real services, for everything that does not move money:
// an in-process database, no mint, no Lightning. Sends are in wallet.itest.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Db, truncateAll } from "@melax/ledger";
import { type TestApp, dial, inbox, newDb, signUp, testApp } from "./helpers.ts";

const AWA = "+221771234567";
const MOUSSA = "+221781112233";
const PIN = "48291";
const HOME = "Melax\n1 Solde\n2 Envoyer\n3 Recevoir\n4 Payer marchand\n5 Depot\n6 Retrait\n0 Suite";

let db: Db;
let T: TestApp;

beforeAll(async () => {
  db = await newDb();
});
beforeEach(async () => {
  await truncateAll(db);
  T = testApp(db);
});
afterAll(async () => {
  await db?.close();
});

async function open(phone: string, ...inputs: string[]) {
  const s = dial(T.app, phone);
  const first = await s.open();
  const last = inputs.length ? await s.run(...inputs) : first;
  return { s, first, last };
}

describe("opening an account through the menus", () => {
  it("a new number is asked its language first, and comes back to the menu in that language", async () => {
    const s = dial(T.app, AWA);
    expect(await s.open()).toBe("Melax\n1 Francais\n2 Wolof\n3 English");
    expect(await s.run("3", PIN, PIN, "Awa")).toMatch(/^Account created\.\nYour address: [a-z]+-[a-z]+\d\d@melax\.sn\nDial #2580# to use it\.$/);
    expect((await open(AWA)).first).toBe("Melax\n1 Balance\n2 Send\n3 Receive\n4 Pay a shop\n5 Cash in\n6 Cash out\n0 More");
    expect((await inbox(T.app, AWA))[0]).toMatch(/^Melax: account created\./);
  });

  it("a code made of digits of the phone number is refused by the server, and the user is asked for another", async () => {
    const s = dial(T.app, AWA);
    await s.open();
    expect(await s.run("1", "71234", "71234", "Awa")).toBe("Code trop facile a deviner.\nChoisissez un autre code de 5 chiffres:");
    expect(await T.app.users.findByPhone(AWA)).toBeNull();
    expect(await s.run(PIN, PIN, "Awa")).toMatch(/^Compte cree\./);
  });

  it("two sessions opening the same number at once make one account", async () => {
    const a = dial(T.app, AWA);
    const b = dial(T.app, AWA);
    await a.open();
    await b.open();
    await a.run("1", PIN, PIN);
    await b.run("1", PIN, PIN);
    const results = await Promise.all([a.type("Awa"), b.type("Awa")]);
    expect(results.filter((r) => r.startsWith("Compte cree."))).toHaveLength(1);
    expect(results.filter((r) => r === "Service indisponible. Reessayez.")).toHaveLength(1);
    expect(await db.query("SELECT 1 FROM users")).toHaveLength(1);
  });
});

describe("what needs the code", () => {
  beforeEach(async () => {
    await signUp(T.app, AWA, PIN, "Awa");
  });

  it("balance: a wrong code is refused by the real check and counted", async () => {
    const { s, last } = await open(AWA, "1", "00000");
    expect(last).toBe("Code faux. Essais restants: 4.\nCode secret:");
    expect(await s.type(PIN)).toBe("Solde: 0 F\n(0 sats)\n1 BTC = 40 000 000 F\n0 Menu");
  });

  it("history: a wrong code shows nothing, and locks like anywhere else", async () => {
    const { s, last } = await open(AWA, "8", "00000");
    expect(last).toBe("Code faux. Essais restants: 4.\nCode secret:");
    for (let i = 0; i < 3; i++) await s.type("00000");
    expect(await s.type("00000")).toBe("Code bloque pendant 15 min.");
    expect((await open(AWA, "1", PIN)).last).toBe("Code bloque pendant 15 min.");
  });

  it("history with the right code and nothing in it says so", async () => {
    expect((await open(AWA, "8", PIN)).last).toBe("Aucune operation.");
  });

  it("renaming the address: wrong code refused, right code renames, a taken name is refused", async () => {
    await signUp(T.app, MOUSSA, "73915", "Moussa");
    const { s, last } = await open(AWA, "9", "3", "1", "awa-dakar", "00000");
    expect(last).toBe("Code faux. Essais restants: 4.\nCode secret:");
    expect(await s.type(PIN)).toBe("Nouvelle adresse:\nawa-dakar@melax.sn");
    expect((await open(MOUSSA, "9", "3", "1", "awa-dakar", "73915")).last).toBe("Nom invalide ou deja pris.\nNouveau nom:");
    expect((await open(AWA, "3")).last).toContain("awa-dakar@melax.sn");
  });

  it("changing the code: the old one stops working, the new one works, and an SMS says it changed", async () => {
    expect((await open(AWA, "9", "1", "1", PIN, "73915", "73915")).last).toBe("Code secret change.");
    expect((await open(AWA, "1", PIN)).last).toBe("Code faux. Essais restants: 4.\nCode secret:");
    expect((await open(AWA, "1", "73915")).last).toContain("Solde: 0 F");
    expect((await inbox(T.app, AWA)).at(-1)).toBe("Melax: votre code secret a ete change. Si ce n'est pas vous, allez chez un agent.");
  });

  it("changing the code with a wrong old code changes nothing", async () => {
    expect((await open(AWA, "9", "1", "1", "00000", "73915", "73915")).last).toBe("Code faux. Essais restants: 4.\nCode secret:");
    // She hangs up there. The next dial offers to continue, at the account menu and not at the code prompt.
    const again = dial(T.app, AWA);
    expect(await again.open()).toBe("Reprendre ou vous en etiez?\n1 Oui\n2 Non");
    expect(await again.type("1")).toMatch(/^Mon compte\n1 Code secret/);
    expect(await again.run("0", "1", "73915")).toBe("Code faux. Essais restants: 3.\nCode secret:");
    expect(await again.type(PIN)).toContain("Solde: 0 F");
  });
});

describe("what does not need the code", () => {
  beforeEach(async () => {
    await signUp(T.app, AWA, PIN, "Awa");
  });

  it("the language change is kept: the next session and the next SMS are in it", async () => {
    expect((await open(AWA, "9", "2", "2")).last).toBe("Lakk: Wolof.");
    expect((await open(AWA)).first).toBe("Melax\n1 Sa xaalis\n2 Yonnee\n3 Jot\n4 Fey jaaykat\n5 Dugal xaalis\n6 Genne xaalis\n0 Yeneen");
    const { last } = await open(AWA, "3", "1");
    expect(last).toBe("Adres bi yonnee nanu ko ci SMS.");
    expect((await inbox(T.app, AWA)).at(-1)).toMatch(/^Melax: ngir fey la ci bitcoin: [a-z]+-[a-z]+\d\d@melax\.sn$/);
  });

  it("limits of a new account", async () => {
    expect((await open(AWA, "9", "5")).last).toBe("Niveau 0\nPar operation: 25 000 F\nReste aujourd'hui: 50 000 F\nReste ce mois: 200 000 F\n0 Menu");
  });

  it("after a week the level rises on its own", async () => {
    T.clock.advance(7 * 24 * 3600 * 1000);
    expect((await open(AWA, "9", "5")).last).toBe("Niveau 1\nPar operation: 100 000 F\nReste aujourd'hui: 200 000 F\nReste ce mois: 1 000 000 F\n0 Menu");
  });

  it("when no exchange rate can be had, the balance screen says the service is down instead of guessing", async () => {
    // A second app on the same database with the same server secret, no fixed rate, and a source that is down.
    const down = testApp(db, {
      env: { MELAX_PEPPER: T.app.config.pepper.toString("hex"), RATE_FIXED_XOF_PER_BTC: "" },
      clock: T.clock,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(down.app.config.rateFixed).toBeNull();
    const s = dial(down.app, AWA);
    expect(await s.open()).toBe(HOME);
    expect(await s.run("1", PIN)).toBe("Service indisponible. Reessayez.");
    // limits are in francs and need no rate: they still answer
    const l = dial(down.app, AWA);
    await l.open();
    expect(await l.run("9", "5")).toContain("Niveau 0");
  });
});
