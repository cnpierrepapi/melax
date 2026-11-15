// Lint rules for the whole repository. Run: npm run lint
// Beyond the recommended sets, three rules guard things the build depends on (docs/PLAN.md section 4):
//   - no console in packages or apps: logs go through createLogger, which redacts (rule 29);
//   - no Date.now() in the gateway's service code: time comes from the injected Clock (rule 30);
//   - type-only imports are written as such, because Node runs these files without compiling them (rule 24).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const nodeGlobals = Object.fromEntries(
  ["process", "console", "Buffer", "fetch", "Response", "Request", "URL", "URLSearchParams", "AbortSignal", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "globalThis", "TextEncoder", "TextDecoder"].map((name) => [name, "readonly"]),
);

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "coverage/**", "**/test/golden/**", ".keys/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: nodeGlobals } },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports", fixStyle: "inline-type-imports" }],
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
  {
    files: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
    rules: { "no-console": "error" },
  },
  {
    // Holds a function that Playwright runs inside the page.
    files: ["scripts/stills.mjs"],
    languageOptions: { globals: { document: "readonly" } },
  },
  {
    files: ["apps/gateway/src/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: "Service code takes the time from the injected Clock, so tests can move it." }],
    },
  },
);
