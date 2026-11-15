// End-to-end tests through a real browser, against the running compose stack.
// Needs: docker compose up (the `app` service on http://localhost:8787), npx playwright install chromium.
// Run: npm run test:e2e
// One worker, in order: the tests share the stack's database and its Lightning channels.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: process.env.MELAX_URL ?? "http://localhost:8787",
    browserName: "chromium",
    locale: "en-GB",
    trace: "retain-on-failure",
  },
});
