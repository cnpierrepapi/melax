// Builds every web front end that has a Vite config. Skips quietly when none exist yet.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const apps = readdirSync(join(root, "apps")).filter((d) => existsSync(join(root, "apps", d, "vite.config.ts")));
for (const app of apps) {
  console.log(`building apps/${app}`);
  const r = spawnSync("npx", ["vite", "build"], { cwd: join(root, "apps", app), stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
console.log(apps.length ? `built ${apps.length} front end(s)` : "no front ends to build yet");
