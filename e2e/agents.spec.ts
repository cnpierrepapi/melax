// A cash-in between two phones in a real browser, against the compose stack: the visitor's phone asks
// an agent for sats, the agent's phone confirms the francs arrived, the visitor's phone shows the SMS.
// The hold invoice, the settle and the ecash are real, on regtest. The francs are pretend.
// The phones are driven by pressing their keys, as a visitor would.
import { type Page, expect, test } from "@playwright/test";

const MOBILE = { width: 360, height: 740 };
const DESKTOP = { width: 1440, height: 900 };
const DEMO_CODE = "27495";

const screen = (page: Page, id: "a" | "b") => page.getByTestId(`screen-${id}`);
const ok = (page: Page, id: "a" | "b") => page.getByTestId(`ok-${id}`).click();
async function keys(page: Page, id: "a" | "b", digits: string): Promise<void> {
  for (const d of digits) await page.getByTestId(`phone-${id}`).locator(`[data-key="${d}"]`).click();
  await ok(page, id);
}

/** Dial, and if a cash-in from an earlier run is still open on this phone, cancel it first. */
async function dialFresh(page: Page, id: "a" | "b"): Promise<void> {
  await ok(page, id);
  await expect(screen(page, id)).toContainText("Melax");
  await keys(page, id, "5");
  await expect(screen(page, id)).toContainText(/Montant en FCFA:|Litige|SMS/);
  if ((await screen(page, id).textContent())?.includes("Montant en FCFA:")) return;
  if ((await screen(page, id).textContent())?.includes("2 Annuler")) await keys(page, id, "2");
  test.skip(true, "an earlier run left a trade on this phone that a visitor cannot close: wait 45 minutes or restart the stack");
}

test.describe("a cash-in with an agent", () => {
  test("Awa asks Ndeye for sats, Ndeye confirms on her phone, Awa's SMS and the guide show it", async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize(DESKTOP);
    await page.goto("/demo?lang=en");
    await page.getByTestId("skip").click();
    await expect(page.getByTestId("num-a")).toHaveText("77 000 01 01");

    // The second phone becomes Ndeye's, the agent. Her walk-through opens at step 1.
    await page.getByTestId("pick-b").selectOption("Ndeye");
    await expect(page.getByTestId("tab-b")).toHaveText("Ndeye's phone (agent)");
    const guide = page.getByTestId("agent-guide");
    await expect(guide).toBeVisible();
    await expect(page.getByTestId("agent-step-1")).toHaveClass(/now/);
    await expect(page.getByTestId("agent-step-2")).toHaveClass(/later/);

    // Awa: 5, an amount, the list of agents, Ndeye, confirm. No code is asked.
    await dialFresh(page, "a");
    await keys(page, "a", "2000");
    await expect(screen(page, "a")).toContainText("Choisir un agent:\n1 Ndeye (Wave) 4 950 sats");
    await keys(page, "a", "1");
    await expect(screen(page, "a")).toHaveText("Depot de 2 000 F chez Ndeye par Wave. Vous recevrez 4 950 sats.\n1 Confirmer\n2 Annuler");
    await keys(page, "a", "1");
    await expect(screen(page, "a")).toHaveText(/^Envoyez 2 000 F par Wave au 77 666 55 44 \(Ndeye\)\.\nRef D[0-9A-F]{5}\. Details par SMS\.$/);
    const ref = /Ref (D[0-9A-F]{5})/.exec((await screen(page, "a").textContent()) ?? "")![1]!;

    // Step 1 is ticked from Awa's SMS, not from the click.
    await expect(page.getByTestId("agent-step-1")).toHaveClass(/done/);
    await expect(page.getByTestId("agent-step-2")).toHaveClass(/now/);
    await expect(page.getByTestId("sms-a").locator("li.sms").first()).toContainText(`Melax depot ${ref}: envoyez 2 000 F par Wave au 77 666 55 44 (Ndeye).`);
    await expect(page.getByTestId("sms-b").locator("li.sms").first()).toContainText(`Melax ${ref}: 77*****01 va vous envoyer 2 000 F par Wave.`);

    // Ndeye: the desk, the cash-in to confirm, her code.
    await ok(page, "b");
    await keys(page, "b", "0");
    await expect(screen(page, "b")).toContainText("4 Espace agent");
    await keys(page, "b", "4");
    await expect(screen(page, "b")).toContainText("1 Depots a confirmer (");
    await keys(page, "b", "1");
    await expect(screen(page, "b")).toHaveText(new RegExp(`^${ref}: avez-vous recu 2 000 F de 77\\*{5}01 par Wave\\?`));
    await keys(page, "b", "1");
    await expect(screen(page, "b")).toHaveText("Code secret:");
    await keys(page, "b", DEMO_CODE);
    await expect(screen(page, "b")).toHaveText(`Depot ${ref} confirme. 4 950 sats livres au client.`);

    // Awa's SMS says the sats arrived, and the walk-through is done.
    await expect(page.getByTestId("sms-a").locator("li.sms").first()).toContainText(new RegExp(`Melax: depot ${ref} recu, \\+2 000 F\\. Solde: [\\d ]+ F\\.`));
    await expect(guide).toHaveAttribute("data-step", "3");
    await expect(page.getByTestId("agent-step-2")).toHaveClass(/done/);
    await expect(page.getByTestId("books-match")).toHaveClass(/sum-ok/);
  });

  test("the walk-through fits a 360 px screen in three languages", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    for (const lang of ["en", "fr", "wo"]) {
      await page.goto(`/demo?lang=${lang}`);
      await expect(page.getByTestId("phone-a")).toBeVisible();
      await page.getByTestId("tab-b").click(); // on a small screen the second phone and its picker are behind this tab
      await page.getByTestId("pick-b").selectOption("Ousmane");
      await expect(page.getByTestId("agent-guide")).toBeVisible();
      const overflow = await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        return [...document.querySelectorAll("[data-testid=agent-guide] *")].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.right > width + 1 || r.left < -1);
        }).length;
      });
      expect(overflow, lang).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), lang).toBe(true);
    }
  });
});
