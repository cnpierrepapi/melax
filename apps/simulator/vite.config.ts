// Builds the two pages (index.html, demo.html) into dist/, which the gateway serves in demo mode.
// One thing happens here that is not stock Vite: every element marked data-t="key" gets its English
// sentence written into the HTML at build time, taken from src/copy.ts. So the page reads fine before
// its script runs (or without it), and the words live in one file only.
// Dev: `npx vite` in this folder, with the gateway on 8787 (the proxy below forwards the API calls).
import { defineConfig } from "vite";
import { type CopyKey, copy } from "./src/copy.ts";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export default defineConfig({
  build: {
    target: "es2022",
    modulePreload: { polyfill: false },
    rollupOptions: { input: { index: "index.html", demo: "demo.html" } },
  },
  server: { proxy: { "/ussd": "http://127.0.0.1:8787", "/sim": "http://127.0.0.1:8787" } },
  plugins: [
    {
      // The gateway serves the simulator at /demo. Make the dev server and `vite preview` do the same.
      name: "melax-demo-path",
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === "/demo" || req.url?.startsWith("/demo?")) req.url = req.url.replace("/demo", "/demo.html");
          next();
        });
      },
    },
    {
      name: "melax-fill-copy",
      transformIndexHtml(html: string) {
        return html.replace(/(<[a-z0-9]+\b[^>]*\bdata-t="([^"]+)"[^>]*>)(<\/)/g, (whole, open: string, key: string, close: string) => {
          if (!(key in copy)) throw new Error(`data-t="${key}" is not in src/copy.ts`);
          return open + escapeHtml(copy[key as CopyKey].en) + close;
        });
      },
    },
  ],
});
