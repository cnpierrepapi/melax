// The landing page and the phone simulator in a real browser, against the compose stack
// (docker compose up, then npm run test:e2e). Every payment here is real ecash on regtest.
// The phones are driven the way a visitor drives them: by pressing the keys on the page.
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";

const MOBILE = { width: 360, height: 740 };
const DESKTOP = { width: 1440, height: 900 };
/** The code shared by the seeded accounts. It is printed on the demo page. */
const DEMO_CODE = "27495";
const AWA = "770000101";
const MOUSSA = "780000102";

const screen = (page: Page, id: "a" | "b") => page.getByTestId(`screen-${id}`);
const ok = (page: Page, id: "a" | "b") => page.getByTestId(`ok-${id}`).click();

/** Press the keys of the phone one by one, then the green key. */
async function keys(page: Page, id: "a" | "b", digits: string): Promise<void> {
  for (const d of digits) await page.getByTestId(`phone-${id}`).locator(`[data-key="${d}"]`).click();
  await ok(page, id);
}

/**
 * Everything wider than the window, or sticking out of it, that is not cut off by a box of its own.
 * An empty list means nothing can be scrolled to sideways.
 */
async function sticksOut(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const cuts = (el: Element): boolean => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        const r = p.getBoundingClientRect();
        if (o !== "visible" && r.left >= -1 && r.right <= width + 1) return true;
      }
      return false;
    };
    const out: string[] = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if ((r.right > width + 1 || r.left < -1) && !cuts(el)) out.push(`${el.tagName.toLowerCase()}.${el.className} ${Math.round(r.left)}..${Math.round(r.right)} of ${width}`);
    }
    if (document.documentElement.scrollWidth > width) out.push(`the page is ${document.documentElement.scrollWidth} wide in a ${width} window`);
    return out;
  });
}

async function topUp(request: APIRequestContext, phone: string, fcfa: number): Promise<void> {
  const r = await request.post("/sim/fund", { data: { phone, fcfa } });
  expect(r.status(), "top-up through /sim/fund").toBe(200);
}

test.describe("the landing page", () => {
  test("says what Melax is, and its button opens the demo, on a 360 px screen", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto("/?lang=en");
    await expect(page.locator("h1")).toHaveText("Bitcoin on any phone.");
    await expect(page.locator(".lede")).toContainText("Melax is a bitcoin wallet. You dial #2580# and it opens.");
    await expect(page.locator(".kicker")).toHaveText("Test version. No real money.");

    // The button is in the first screen: no scrolling to find it.
    const cta = page.getByTestId("cta");
    const box = (await cta.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(MOBILE.height);
    expect(await sticksOut(page)).toEqual([]);

    await cta.click();
    await expect(page).toHaveURL(/\/demo$/);
    await expect(page.getByTestId("phone-a")).toBeVisible();
    await expect(page.getByTestId("step-1")).toContainText("Open your account");
  });

  test("reads in Wolof, French and English, and the demo opens in the language that was picked", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto("/?lang=en");
    await page.locator('[data-lang="wo"]').click();
    await expect(page.locator("h1")).toHaveText("Bitcoin ci bépp telefon.");
    await expect(page.locator("html")).toHaveAttribute("lang", "wo");
    // The Wolof has not been read by a native speaker, and the Wolof page says so.
    await expect(page.locator(".wolof-note")).toBeVisible();
    await expect(page.locator("#hero-screen")).toContainText("Sa xaalis");
    expect(await sticksOut(page)).toEqual([]);

    await page.locator('[data-lang="fr"]').click();
    await expect(page.locator("h1")).toHaveText("Le bitcoin sur n'importe quel téléphone.");
    await expect(page.locator(".wolof-note")).toBeHidden();
    await expect(page.locator("#hero-screen")).toContainText("Solde");
    expect(await sticksOut(page)).toEqual([]);

    await page.getByTestId("cta").click();
    await expect(page.getByTestId("step-1")).toContainText("Ouvrez votre compte");
    await expect(screen(page, "a")).toHaveText("Touche verte pour composer");
  });

  test("the words are in the page before any script runs, and each page weighs under 30 KB", async ({ request }) => {
    for (const [path, words] of [["/", "Bitcoin on any phone."], ["/demo", "Test network. No real money."]] as const) {
      const page = await request.get(path, { headers: { "accept-encoding": "gzip" } });
      const html = await page.text();
      expect(html).toContain(words);
      let bytes = Number(page.headers()["content-length"]);
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]!);
      expect(assets.length).toBeGreaterThan(1);
      for (const url of new Set(assets)) {
        const r = await request.get(url, { headers: { "accept-encoding": "gzip" } });
        expect(r.status(), url).toBe(200);
        expect(r.headers()["content-encoding"], url).toBe("gzip");
        bytes += Number(r.headers()["content-length"]);
      }
      expect(bytes, `${path} with its scripts and styles, gzipped`).toBeLessThan(30_000);
      expect(bytes).toBeGreaterThan(3000);
    }
  });
});

test.describe("the guide, on a 360 px screen", () => {
  test("a new visitor opens an account, adds money, sends 500 F, and each step unlocks only when the one before really happened", async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize(MOBILE);
    await page.goto("/demo?lang=en");
    const step = (n: number) => page.getByTestId(`step-${n}`);

    // Step 1 is open, the others are not, and there is no top-up button yet.
    await expect(step(1)).toHaveClass(/now/);
    await expect(step(2)).toHaveClass(/later/);
    await expect(page.getByTestId("fund")).toHaveCount(0);
    expect(await sticksOut(page)).toEqual([]);
    const myNumber = ((await page.getByTestId("num-a").textContent()) ?? "").replace(/\s/g, "");
    expect(myNumber).toMatch(/^7[05678]\d{7}$/);

    // Open the account through the phone's own menus.
    await ok(page, "a");
    await expect(screen(page, "a")).toHaveText("Melax\n1 Francais\n2 Wolof\n3 English");
    await keys(page, "a", "3");
    await expect(screen(page, "a")).toContainText("Choose a 5-digit secret code:");
    // A code that is too easy is refused by the wallet, and the guide does not move.
    await keys(page, "a", "12345");
    await expect(screen(page, "a")).toContainText("That code is too easy to guess.");
    await expect(step(1)).toHaveClass(/now/);
    await keys(page, "a", "48291");
    await expect(screen(page, "a")).toHaveText("Type the secret code again:");
    await keys(page, "a", "48291");
    await expect(screen(page, "a")).toContainText("Your first name");
    await page.getByTestId("phone-a").locator(".key-abc").click();
    await page.getByTestId("input-a").fill("Judge");
    await ok(page, "a");
    await expect(screen(page, "a")).toContainText("Account created.");

    // The welcome SMS arrived, so step 1 is ticked and step 2 opens.
    await expect(step(1)).toHaveClass(/done/);
    await expect(step(2)).toHaveClass(/now/);
    await expect(page.getByTestId("sms-a")).toContainText("Melax: account created.");

    // The page followed the keypad down, so the guide is out of view. The step in hand stays pinned
    // at the bottom, and a tap on it brings the guide back.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.getByTestId("hint")).toBeVisible();
    await expect(page.getByTestId("hint")).toContainText("2/4");
    await expect(page.getByTestId("hint")).toContainText("Add test money");
    await page.getByTestId("hint").click();
    await expect(page.getByTestId("hint")).toBeHidden();
    await expect(page.getByTestId("fund")).toBeInViewport();

    // Step 2: real sats over Lightning. Step 3 opens only when the deposit SMS is there.
    await expect(step(3)).toHaveClass(/later/);
    await page.getByTestId("fund").click();
    await expect(step(3)).toHaveClass(/now/, { timeout: 45_000 });
    await expect(page.getByTestId("sms-a").locator("li").first()).toHaveText(/Melax: received 5 000 F over Lightning\. Balance: 5 000 F\./);
    await expect(step(3)).toContainText("Send 500 F to Moussa");
    await expect(step(3)).toContainText("78 000 01 02");

    // Step 3: the send. The name is shown before the code is asked.
    await ok(page, "a");
    await expect(screen(page, "a")).toContainText("1 Balance\n2 Send");
    await keys(page, "a", "2");
    await expect(screen(page, "a")).toContainText("Send to:");
    await keys(page, "a", MOUSSA);
    await expect(screen(page, "a")).toHaveText("Amount in FCFA:");
    await keys(page, "a", "500");
    await expect(screen(page, "a")).toHaveText("Send 500 F (1 250 sats) to Moussa (78*****02)?\n1 Confirm\n2 Cancel");
    await keys(page, "a", "1");
    await expect(screen(page, "a")).toHaveText("Secret code:");
    await expect(step(3)).toHaveClass(/now/); // nothing is ticked before the money has moved
    await keys(page, "a", "48291");
    await expect(screen(page, "a")).toHaveText(/^Sent: 500 F to Moussa\.\nReceipt no \d+\nBalance: 4 500 F$/);
    const receipt = /Receipt no (\d+)/.exec((await screen(page, "a").textContent()) ?? "")![1]!;

    await expect(step(3)).toHaveClass(/done/);
    await expect(step(4)).toHaveClass(/now/);
    await expect(page.getByTestId("sms-a").locator("li").first()).toHaveText(new RegExp(`Melax: sent 500 F to Moussa\\. Balance: 4 500 F\\. Receipt no ${receipt}`));

    // Step 4: Moussa's phone got the same receipt number, in his language.
    await expect(page.getByTestId("guide-end")).toHaveCount(0);
    await page.getByTestId("show-b").click();
    await expect(page.getByTestId("tab-b")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("sms-b").locator("li").first()).toHaveText(new RegExp(`Melax: jot nga 500 F ci Judge\\..*Resi no ${receipt}`));
    await expect(page.getByTestId("guide-end")).toContainText("That was real ecash.");

    // The books show the movement under first names, and the totals agree.
    await expect(page.getByTestId("books-match")).toHaveClass(/sum-ok/);
    const first = page.getByTestId("books").locator("li.entry").first();
    await expect(first).toContainText("Ecash changed hands");
    await expect(first).toContainText("Judge, locked");
    await expect(first).toContainText("-1 250 sats");
    await expect(first).toContainText("Moussa");
    await expect(first).toContainText("+1 250 sats");
    await expect(page.getByTestId("books")).not.toContainText(myNumber);
    await expect(page.getByTestId("books")).not.toContainText(MOUSSA);
    expect(await sticksOut(page)).toEqual([]);

    // The account belongs to this browser: a reload comes back to the finished guide's phone.
    await page.reload();
    await expect(page.getByTestId("num-a")).toHaveText(`${myNumber.slice(0, 2)} ${myNumber.slice(2, 5)} ${myNumber.slice(5, 7)} ${myNumber.slice(7)}`);
    await expect(step(3)).toHaveClass(/done/);
  });
});

test.describe("two phones side by side, on a wide screen", () => {
  test("Awa pays Moussa 500 F with one dial string, Moussa's phone shows the SMS, the books show the lines", async ({ page, request }) => {
    await topUp(request, AWA, 500); // keeps Awa's balance level however often this runs
    await page.setViewportSize(DESKTOP);
    await page.goto("/demo?lang=en");
    await expect(page.getByTestId("phone-a")).toBeVisible();
    await expect(page.getByTestId("phone-b")).toBeVisible();
    await page.getByTestId("skip").click();
    await expect(page.getByTestId("num-a")).toHaveText("77 000 01 01");
    await expect(page.getByTestId("step-3")).toHaveClass(/now/);
    const before = await page.getByTestId("sms-b").locator("li.sms").count();

    // The whole payment in one line. The code is still asked, on its own screen.
    await page.getByTestId("input-a").fill(`#2580*2*${MOUSSA}*500#`);
    await ok(page, "a");
    await expect(screen(page, "a")).toHaveText("Envoyer 500 F (1 250 sats) a Moussa (78*****02)?\n1 Confirmer\n2 Annuler");
    await keys(page, "a", "1");
    await expect(screen(page, "a")).toHaveText("Code secret:");
    await keys(page, "a", DEMO_CODE);
    await expect(screen(page, "a")).toHaveText(/^Envoye: 500 F a Moussa\.\nRecu no \d+\nSolde: [\d ]+ F$/);
    const receipt = /Recu no (\d+)/.exec((await screen(page, "a").textContent()) ?? "")![1]!;

    await expect(page.getByTestId("sms-b").locator("li.sms").first()).toHaveText(new RegExp(`Melax: jot nga 500 F ci Awa\\..*Resi no ${receipt}`));
    expect(await page.getByTestId("sms-b").locator("li.sms").count()).toBeGreaterThanOrEqual(Math.min(before + 1, 12));
    await expect(page.getByTestId("phone-b").locator(".lcd-sms")).toBeVisible();
    // Both phones are in view on a wide screen, so the guide finishes without a tap.
    await expect(page.getByTestId("guide-end")).toBeVisible();

    const first = page.getByTestId("books").locator("li.entry").first();
    await expect(first).toContainText("Ecash changed hands");
    await expect(first).toContainText("Awa, locked");
    await expect(first).toContainText("-1 250 sats");
    await expect(first).toContainText("+1 250 sats");
    await expect(page.getByTestId("books-match")).toHaveClass(/sum-ok/);
    expect(await sticksOut(page)).toEqual([]);

    // Moussa can read his own balance on the second phone with the shared code.
    await ok(page, "b");
    await expect(screen(page, "b")).toContainText("1 Sa xaalis");
    await keys(page, "b", "1");
    await expect(screen(page, "b")).toHaveText("Sa kod:");
    await keys(page, "b", DEMO_CODE);
    await expect(screen(page, "b")).toHaveText(/^Li nga am: [\d ]+ F\n/);
  });

  test("a wrong code shows the tries left and moves nothing; the right code then works", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/demo?lang=en");
    await page.getByTestId("skip").click();
    await expect(page.getByTestId("num-a")).toHaveText("77 000 01 01");
    const entry = async () => (await page.getByTestId("books").locator("li.entry .entry-hash").first().textContent()) ?? "";
    await expect(page.getByTestId("books").locator("li.entry").first()).toBeVisible();
    const lastEntry = await entry();

    await ok(page, "a");
    await keys(page, "a", "2");
    await keys(page, "a", MOUSSA);
    await keys(page, "a", "500");
    await keys(page, "a", "1");
    await expect(screen(page, "a")).toHaveText("Code secret:");
    await keys(page, "a", "00000");
    await expect(screen(page, "a")).toHaveText("Code faux. Essais restants: 4.\nCode secret:");
    await page.waitForTimeout(2500); // two rounds of the page's polling
    expect(await entry()).toBe(lastEntry);
    await expect(page.getByTestId("step-3")).toHaveClass(/now/);

    // Hanging up and dialling again offers to pick the payment up. It never comes back at the code prompt.
    await page.getByTestId("end-a").click();
    await ok(page, "a");
    await expect(screen(page, "a")).toHaveText("Reprendre ou vous en etiez?\n1 Oui\n2 Non");
    await keys(page, "a", "2");
    await expect(screen(page, "a")).toContainText("1 Solde\n2 Envoyer");
    // The right code clears the count, so this test can run any number of times.
    await keys(page, "a", "1");
    await keys(page, "a", DEMO_CODE);
    await expect(screen(page, "a")).toHaveText(/^Solde: [\d ]+ F\n/);
  });

  test("a code that is not ours is answered the way a network would", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/demo?lang=en");
    await page.getByTestId("input-a").fill("*123#");
    await ok(page, "a");
    await expect(screen(page, "a")).toHaveText("This phone only knows #2580#");
    await expect(page.getByTestId("input-a")).toHaveValue("#2580#");
  });
});

test.describe("nothing scrolls sideways", () => {
  for (const [name, size] of [["360 px", MOBILE], ["320 px", { width: 320, height: 640 }], ["1440 px", DESKTOP]] as const) {
    test(`both pages, three languages, at ${name}`, async ({ page }) => {
      await page.setViewportSize(size);
      for (const lang of ["en", "fr", "wo"]) {
        await page.goto(`/?lang=${lang}`);
        await expect(page.locator("h1")).not.toBeEmpty();
        expect(await sticksOut(page), `landing ${lang}`).toEqual([]);
        await page.goto(`/demo?lang=${lang}`);
        await expect(page.getByTestId("phone-a")).toBeVisible();
        await expect(page.getByTestId("books").locator("li.entry").first()).toBeVisible();
        expect(await sticksOut(page), `demo ${lang}`).toEqual([]);
        if (size.width < 900) {
          await page.getByTestId("tab-b").click();
          await expect(page.getByTestId("phone-b")).toBeVisible();
          expect(await sticksOut(page), `demo ${lang}, second phone`).toEqual([]);
        }
      }
    });
  }
});
