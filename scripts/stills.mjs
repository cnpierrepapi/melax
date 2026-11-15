// Takes stills of the landing page and the simulator, at desktop width and at 360 px, in the three
// languages. They go to stills/ (git-ignored). Look at them before calling a page done.
// Needs: docker compose up, npx playwright install chromium.
// Run: node scripts/stills.mjs [base url]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://localhost:8787";
mkdirSync("stills", { recursive: true });
const browser = await chromium.launch();
const sizes = [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 360, height: 740 }],
];
for (const [name, viewport] of sizes) {
  for (const lang of ["en", "fr", "wo"]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: name === "mobile" ? 2 : 1 });
    await page.goto(`${base}/?lang=${lang}`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `stills/landing-${name}-${lang}.png`, fullPage: true });
    await page.screenshot({ path: `stills/landing-${name}-${lang}-top.png` });
    await page.goto(`${base}/demo?lang=${lang}`);
    await page.getByTestId("phone-a").waitFor();
    await page.waitForTimeout(1800);
    await page.screenshot({ path: `stills/demo-${name}-${lang}.png`, fullPage: true });
    await page.screenshot({ path: `stills/demo-${name}-${lang}-top.png` });
    // The guide two steps in (a ready account), with a menu open on the phone.
    await page.getByTestId("skip").click();
    await page.getByTestId("ok-a").click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `stills/demo-${name}-${lang}-step3.png`, fullPage: true });
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log(`${name} ${lang}: sideways overflow ${wide}px`);
    await page.close();
  }
}
await browser.close();
