// Break one line at a time, run the tests that should notice, put the line back.
// A mutation "survives" when the tests still pass: that would mean nothing checks the line.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const unit = (file) => `npx vitest run apps/gateway/test/${file}`;
const int = (name) => `npx vitest run --config vitest.int.config.ts apps/gateway -t "${name}"`;

const mutations = [
  {
    name: "dial-string queue is fed to a code prompt",
    file: "apps/gateway/src/ussd/machine.ts",
    from: "      if (PIN_STEPS.has(s.at)) return { ...s, q: [] };\n",
    to: "",
    run: unit("machine.test.ts"),
  },
  {
    name: "a dropped session resumes at the code prompt",
    file: "apps/gateway/src/ussd/machine.ts",
    from: 'return at("send.confirm", { toRef: s.v.toRef, name: s.v.name, masked: s.v.masked, fcfa: s.v.fcfa, sats: s.v.sats });',
    to: "return { ...s, q: [] };",
    run: unit("machine.test.ts"),
  },
  {
    name: "a locked code is still compared",
    file: "apps/gateway/src/users.ts",
    from: '      if (isPinLocked(state, now)) return { ok: false, err: "PIN_LOCKED", minutes: minutesLeft(state.lockedUntil) };\n',
    to: "",
    run: unit("users.test.ts"),
  },
  {
    name: "the Africa's Talking allow-list is not checked",
    file: "apps/gateway/src/http.ts",
    from: "at.allowIps.length > 0 && !at.allowIps.includes(req.ip)",
    to: "false",
    run: unit("http.test.ts"),
  },
  {
    name: "history opens without the code",
    file: "apps/gateway/src/ussd/perform.ts",
    from: "if (e.page === 0 || e.pin !== undefined) {",
    to: "if (false) {",
    run: unit("perform.test.ts"),
  },
  {
    name: "SMS replies are not rate limited",
    file: "apps/gateway/src/smsin.ts",
    from: "if (recent.length >= MAX_REPLIES) {",
    to: "if (false) {",
    run: unit("http.test.ts"),
  },
  {
    name: "sends of one user are not serialised",
    file: "apps/gateway/src/wallet.ts",
    from: "const next = prev.then(fn, fn);",
    to: "const next = fn();",
    run: int("same headroom"),
  },
  {
    name: "a send does not check the code",
    file: "apps/gateway/src/wallet.ts",
    from: "    if (!pin.ok) return pin;\n\n    return this.serial(",
    to: "    return this.serial(",
    run: int("someone else"),
  },
  {
    name: "the limit is only checked at the quote, not after the code",
    file: "apps/gateway/src/wallet.ts",
    from: 'if (!limit.ok) return { ok: false, err: "LIMIT", reason: limit.reason, allowedFcfa: limit.allowedFcfa } as Refusal;',
    to: "void limit;",
    run: int("same headroom"),
  },
  // ----- phase 5: the demo surface and deposits -----
  {
    name: "the demo routes are mounted outside demo mode",
    file: "apps/gateway/src/http.ts",
    from: "  if (config.demo) {\n    const sim = simulator(app.runtime);",
    to: "  if (config.demo || true) {\n    const sim = simulator(app.runtime);",
    run: unit("demo.test.ts"),
  },
  {
    name: "a top-up has no upper limit",
    file: "apps/gateway/src/demo.ts",
    from: " || fcfa > FUND_CAP_FCFA)",
    to: ")",
    run: unit("demo.test.ts"),
  },
  {
    name: "the top-up node is used on any network",
    file: "apps/gateway/src/demo.ts",
    from: 'if (mine.network === "regtest" && theirs.network === "regtest") return world;',
    to: "if (mine.network && theirs.network) return world;",
    run: unit("demo.test.ts"),
  },
  {
    name: "a deposit is credited for an invoice that is not settled",
    file: "apps/gateway/src/wallet.ts",
    from: 'if (!inv || inv.state !== "settled" || ',
    to: "if (!inv || ",
    run: unit("demo.test.ts"),
  },
  {
    name: "the state page shows user ids instead of first names",
    file: "apps/gateway/src/demo.ts",
    from: 'if (parts[0] === "user") return `${names.get(parts[1]!) ?? "?"}:${last}`;',
    to: "if (parts[0] === \"user\") return account;",
    run: unit("demo.test.ts"),
  },
  {
    name: "the seed runs on a database that already has users",
    file: "apps/gateway/src/demo.ts",
    from: '  if ((await app.db.query("SELECT 1 FROM users LIMIT 1")).length > 0) return { seeded: false, funded: false };\n',
    to: "",
    run: unit("demo.test.ts"),
  },
  // ----- phase 6: agents, escrow, bonds, disputes -----
  {
    name: "a cash-in may pass the agent's bond",
    file: "apps/gateway/src/escrow/engine.ts",
    from: 'if ((await this.d.agents.bondedSats(a.agentId, tx)) + a.sats > (await this.d.agents.bondSats(a.agentId, tx))) return { ok: false, err: "BOND" };',
    to: "void 0;",
    run: unit("escrow.test.ts"),
  },
  {
    name: "an agent confirms a cash-in without the code",
    file: "apps/gateway/src/escrow/engine.ts",
    from: '    if (!pin.ok) return pin;\n    return this.serial(r.id, async () => {\n      const cur = await this.row(r.id);\n      const moved = cur && (await this.move(this.d.db, cur, "agentConfirm"',
    to: '    return this.serial(r.id, async () => {\n      const cur = await this.row(r.id);\n      const moved = cur && (await this.move(this.d.db, cur, "agentConfirm"',
    run: unit("escrow.test.ts"),
  },
  {
    name: "a user confirms a cash-out without the code",
    file: "apps/gateway/src/escrow/engine.ts",
    from: '    if (!pin.ok) return pin;\n    return this.serial(r.id, async () => {\n      const cur = await this.row(r.id);\n      const moved = cur && (await this.move(this.d.db, cur, "userConfirm"',
    to: '    return this.serial(r.id, async () => {\n      const cur = await this.row(r.id);\n      const moved = cur && (await this.move(this.d.db, cur, "userConfirm"',
    run: unit("escrow.test.ts"),
  },
  {
    name: "a trade moves whatever state it is in now (no state check in the UPDATE)",
    file: "apps/gateway/src/escrow/engine.ts",
    from: " WHERE id = $1 AND state = $2 RETURNING *`",
    to: " WHERE id = $1 AND $2::text IS NOT NULL RETURNING *`",
    run: unit("escrow.test.ts"),
  },
  {
    name: "the arbiter's route does not check its secret",
    file: "apps/gateway/src/http.ts",
    from: 'if (!auth.startsWith("Bearer ") || !constantTimeEqual(auth.slice(7), secret))',
    to: "if (false)",
    run: unit("escrow.test.ts"),
  },
  {
    name: "the agent desk is in everyone's menu",
    file: "apps/gateway/src/ussd/machine.ts",
    from: 's.profile?.role === "agent" ? [["4", t(L, "m.agent")]] : []',
    to: '[["4", t(L, "m.agent")]]',
    run: unit("machine.test.ts"),
  },
  {
    name: "the escrow's block delta is not checked against the hard cap",
    file: "apps/gateway/src/config.ts",
    from: "if ((e.ESCROW_CLTV_BLOCKS - ESCROW_LND_MARGIN_BLOCKS) * e.ESCROW_BLOCK_SECONDS < ESCROW_HARD_CAP_SEC) {",
    to: "if (false) {",
    run: unit("config.test.ts"),
  },
  {
    name: "a cash-out does not count toward the limits",
    file: "apps/gateway/src/escrow/engine.ts",
    from: "receipt: await this.receiptNo(tx), ref: op.id, spend: true });\n    const number = localPhone",
    to: "receipt: await this.receiptNo(tx), ref: op.id, spend: false });\n    const number = localPhone",
    run: int("sats leave the user for escrow"),
  },
  {
    name: "a payment held on a closed trade is left held (rule 15)",
    file: "apps/gateway/src/escrow/engine.ts",
    from: 'if (inv.state === "accepted" || inv.state === "open") {',
    to: 'if (inv.state === "open") {',
    run: int("rule 15"),
  },
  {
    name: "a disputed cash-in is held past the hard cap",
    file: "apps/gateway/src/escrow/engine.ts",
    from: 'if (now >= toSafeInt(r.hard_cap_at ?? r.deadline_at) || inv?.state === "cancelled") {',
    to: 'if (inv?.state === "cancelled") {',
    run: int("hard cap comes first"),
  },
];

const only = process.argv[2];
let survived = 0;
for (const m of mutations) {
  if (only && !m.name.includes(only)) continue;
  const original = readFileSync(m.file, "utf8");
  if (!original.includes(m.from)) {
    console.log(`SKIPPED  ${m.name}: line not found`);
    survived++;
    continue;
  }
  writeFileSync(m.file, original.replace(m.from, m.to));
  let caught = false;
  try {
    execSync(m.run, { stdio: "pipe", timeout: 300_000 });
  } catch {
    caught = true;
  } finally {
    writeFileSync(m.file, original);
  }
  if (!caught) survived++;
  console.log(`${caught ? "caught  " : "SURVIVED"} ${m.name}`);
}
console.log(survived === 0 ? "every mutation was caught" : `${survived} not caught`);
