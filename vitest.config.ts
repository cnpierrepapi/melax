import { defineConfig } from "vitest/config";

// Unit and property tests. No Docker, no network: money logic runs on PGlite (Postgres in-process).
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
