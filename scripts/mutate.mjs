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
