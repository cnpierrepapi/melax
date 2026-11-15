// Serves the built web pages (the landing page and the phone simulator) from memory.
// Contract:
//   - the files are read once, when the server starts, into a map from URL path to bytes. A request
//     is answered from that map or gets the usual 404. No request path ever reaches the disk, so there
//     is nothing for "../" to climb out of;
//   - only regular files with a known extension are loaded. Hidden files and links are skipped;
//   - pages are sent with a policy that allows scripts, styles and requests from this server only.
// Callers: main.ts (loadStatic), http.ts (mountStatic, in demo mode only).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { FastifyInstance } from "fastify";

export interface StaticFile {
  body: Buffer;
  /** Present when the file is text and gzip made it smaller. */
  gzip: Buffer | null;
  type: string;
  html: boolean;
  /** True for files whose name carries a content hash (everything under /assets/). */
  immutable: boolean;
}
export type StaticFiles = Map<string, StaticFile>;

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  png: "image/png",
  ico: "image/x-icon",
  woff2: "font/woff2",
};
const COMPRESSIBLE = new Set(["html", "js", "css", "svg", "json", "txt"]);
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Read every servable file under `dir`. A folder that does not exist gives an empty map. */
export function loadStatic(dir: string): StaticFiles {
  const files: StaticFiles = new Map();
  if (!existsSync(dir)) return files;
  const walk = (folder: string, prefix: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const url = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(folder, entry.name), url);
        continue;
      }
      const ext = entry.name.includes(".") ? entry.name.slice(entry.name.lastIndexOf(".") + 1).toLowerCase() : "";
      const type = TYPES[ext];
      if (!entry.isFile() || !type || !SAFE_PATH.test(url)) continue;
      const body = readFileSync(join(folder, entry.name));
      const zipped = COMPRESSIBLE.has(ext) ? gzipSync(body, { level: 9 }) : null;
      const file: StaticFile = { body, gzip: zipped && zipped.length < body.length ? zipped : null, type, html: ext === "html", immutable: url.startsWith("/assets/") };
      files.set(url, file);
      // index.html is the site root; any other page also answers without its extension (/demo).
      if (ext === "html" && prefix === "") files.set(entry.name === "index.html" ? "/" : url.slice(0, -".html".length), file);
    }
  };
  walk(dir, "");
  return files;
}

export function mountStatic(http: FastifyInstance, files: StaticFiles): void {
  for (const [url, file] of files) {
    http.get(url, async (req, reply) => {
      reply.header("content-type", file.type);
      reply.header("x-content-type-options", "nosniff");
      reply.header("cache-control", file.immutable ? "public, max-age=31536000, immutable" : "no-cache");
      if (file.html) {
        reply.header("content-security-policy", CSP);
        reply.header("referrer-policy", "no-referrer");
      }
      if (file.gzip) {
        reply.header("vary", "accept-encoding");
        if (/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
          reply.header("content-encoding", "gzip");
          return reply.send(file.gzip);
        }
      }
      return reply.send(file.body);
    });
  }
}
