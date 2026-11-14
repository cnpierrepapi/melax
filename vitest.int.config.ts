import { defineConfig } from "vitest/config";

// Integration tests. They need the regtest stack (docker compose up) or the public NWC sandbox.
// Files end in .itest.ts so the unit run never picks them up.
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.itest.ts", "apps/*/test/**/*.itest.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    pool: "forks",
    fileParallelism: false,
  },
});
