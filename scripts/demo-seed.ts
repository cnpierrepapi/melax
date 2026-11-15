// Seeds the demo by hand: six accounts at a market in Dakar, each topped up with a real regtest
// payment, then a few payments between them. The server does the same on an empty database when
// DEMO_SEED=1; this script is for a database that was emptied while the server was not running.
// Needs the same environment as the server (docs/PLAN.md section 6), with MELAX_DEMO=1 and the three
// DEMO_WORLD_LND_* variables. Does nothing when a user already exists.
// Run: node scripts/demo-seed.ts   (stop the server first: both would hold the per-user send queue)
import { boot } from "../apps/gateway/src/boot.ts";
import { seedDemo } from "../apps/gateway/src/demo.ts";

const { app, config, close } = await boot(process.env);
if (!config.demo) {
  console.error("demo-seed: MELAX_DEMO=1 is required");
  await close();
  process.exit(1);
}
await app.vault.recover();
const result = await seedDemo(app);
const audit = await app.vault.auditAll();
console.log(JSON.stringify({ ...result, topUp: app.world !== undefined, ledgerSat: audit.ledgerSat, ecashSat: audit.proofsSat, booksMatch: audit.ok }));
await close();
process.exit(result.seeded && !result.funded && app.world ? 1 : 0);
