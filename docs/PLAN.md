# Melax: build plan and handover

Bitcoin for any phone in Senegal: USSD, SMS and voice on top of Lightning and Cashu ecash, with agent cash-in
and cash-out that never puts francs or the pot in the operator's hands.

Target: Dakar Bitcoin Hack 2026. Submissions close Fri 20 Nov 2026 at 20:00 UTC (21:00 in Malta).

Read this file before touching the code. It says what is done, what comes next, and which rules keep new work
from breaking old work. Whoever finishes a phase updates it before stopping.

Last updated: 15 Nov 2026, after phase 6.

## 1. How this build runs

1. One phase at a time. A phase is finished when its tests pass, its docs are updated, and it is committed and pushed. Then work stops until the owner says continue.
2. Tests come first. List the unhappy paths, write the tests, watch them fail, then write the code.
3. Money paths are tested against the real mint and real Lightning nodes on regtest. The mint is never mocked. Faults are injected at the network edge of the test process (see `packages/cashu/test/mint.itest.ts`, function `fault`).
4. Never write "enforced", "cannot" or "impossible" in code or docs before the test that proves it exists and passes.
5. At the end of every phase, update all of these:
   - the phase board in section 2 and the phase's notes in section 3 or 7 of this file;
   - section 4, if the phase created a rule later work must respect;
   - section 5, if files or exports moved;
   - `docs/status.md` (what is real, what is simulated, what is missing);
   - `docs/BUILD_LOG.md` (what was built, and every bug with its cause and fix, including tooling mistakes);
   - `docs/ARCHITECTURE.md` and `docs/DECISIONS.md` (new parts, new choices and what they cost);
   - `docs/threat-model.md` (new threats, and for each control the test that shows it or the phase that will);
   - `docs/LITEPAPER.md`, if a trade-off described there changed.
6. Nothing gets deployed and the repository stays private until the owner says otherwise.

## 2. Phase board

Order is by what a judge can see and check first. The owner can reorder the phases that are not started.

| # | Phase | State | Proof |
|---|---|---|---|
| 0 | Foundations: workspace, shared core, crypto primitives, ledger | Done | `npm test`: core 12, crypto 17, ledger 13. Ledger also ran 10,000 random sequences (152 s) |
| 1 | Regtest network and Lightning backends (LND, NWC) | Done | `node scripts/smoke.ts`; contract suite 10 of 10 on LND regtest and 10 of 10 on faucet.nwc.dev |
| 2 | Ecash client and vault | Done | `npm run test:int`: cashu 15, vault 21. Vault also ran 1,000 random sends (671 s) |
| 3 | Limits, SMS, USSD SDK, wording in three languages | Done | `npm test`: limits 10, sms 15, ussd 18, i18n 9 |
| 4 | Wallet core over USSD: accounts, PIN, balance, send, receive, history, account menu, receipts by SMS | Done | `npm test`: gateway 143 (machine 72, users 17, http 17, perform 13, smsout 9, rates 8, config 7). `npm run test:int`: wallet 15. Both on PGlite and on Postgres 17. `node scripts/mutate.mjs`: 9 of 9 caught. The server was started once on the regtest stack (section 3, "What phase 4 handed over") |
| 5 | Something to look at: web phone simulator, landing page with a demo button, one-command start, demo seed, a real top-up | Done | `npm test`: 282 in all (demo 22, config 8, page copy 7 are new). `npm run test:int`: 78 (demo 7). `npm run test:e2e`: 10. Gateway tests also on Postgres 17. `node scripts/mutate.mjs`: 15 of 15 caught. Clean `docker compose up`: 126 s. Stills looked at in three languages |
| 6 | Agents: cash-in and cash-out with hold-invoice escrow, bonds, disputes | Done | `npm test`: 350 in all (escrow 18, trade 7 are new; the menus went from 72 to 113). `npm run test:int`: 101 (escrow 19, NWC sandbox 3). `npm run test:e2e`: 12. Gateway tests also on Postgres 17 (234 and 45). `node scripts/mutate.mjs`: 25 of 25 caught. Clean `docker compose up`: 123 s. Probe: LND's default held a payment 65 blocks, 432 held one 414 |
| 7 | Vouchers and merchants | **Next** | See section 3 |
| 8 | Lightning address, pay codes, moving to a smartphone | Not started | Section 7 |
| 9 | Scam shield and account recovery | Not started | Section 7 |
| 10 | Public proof: Nostr offers and receipts, reserve snapshots, verify page | Not started | Section 7 |
| 11 | Operator console | Not started | Section 7 |
| 12 | Hardening: end-to-end and chaos tests, threat model sign-off, independent review, CI | Not started | Section 7 |
| 13 | Delivery: hosted demo, README, pitch, submission pack | Not started | Section 7 |
| 14 | Voice line and Wolof speech | Not started | Section 7 |
| 15 | Fiat rail adapters and the Mutinynet profile | Not started | Section 7 |

The scope rule from the first plan still holds: everything gets built. Phases 14 and 15 are last because they
carry the most risk for the least a judge can check, and phase 13 comes before them so a submission exists even
if time runs out.

## 3. Next phase in detail: phase 7, vouchers and merchants

### What it delivers

Two things that let money reach people who are not in Melax yet, and let a shop take it.

Vouchers. A user turns part of their balance into a code: 16 characters, in four groups. Whoever holds the code
can redeem it, by USSD, by SMS (`BON <code>`) or on a web page. A voucher nobody redeems goes back to the person who
made it after 30 days. Sending to a number with no account, which is refused today, becomes an SMS voucher to
that number.

Merchants. A shop gets a 5-digit merchant code. A customer presses 4, types the code and an amount, sees the shop's
name, types their code, and both get a receipt by SMS. The shop gets an evening summary. A poster with the dial
string for the shop's code.

Menu entries 4 (Payer marchand) and 7 (Bons) stop answering "Bientot disponible".

### Read first

- Rules 2, 6, 7, 9 (money), 21 and 23 (Cashu), 44 to 50 (gateway), 55, 59 and 62 (pages), and the new rules 69 to 80 from phase 6, in section 4.
- `packages/crypto/src/index.ts`: `newVoucherCode`, `normalizeVoucherCode`, `formatVoucherCode`, `voucherCodeHash`, `voucherKey` (scrypt, then a secp256k1 key), `newMerchantCode`. The code and its check character are already built and tested.
- `packages/vault/test/vault.itest.ts`, "locked ecash for vouchers": `Vault.transfer` with `lock` to a voucher owner, and with `privkey` to redeem. `Vault.liveProofs` hands the locked token to a page. `Vault.writeOffSpent` notices a voucher redeemed in another wallet.
- `packages/cashu/src/index.ts`: `P2PKOptions`, `planSwap(..., lock)`, `wireProofs`. Read `node_modules/@cashu/cashu-ts/lib/types/index.d.ts` for what a P2PK lock can carry (locktime, refund keys) in 4.13.1.
- `packages/sms/src/index.ts`: `parseCommand` already returns `{ cmd: "voucher", code }` for `BON` and `VOUCHER`. `apps/gateway/src/smsin.ts` answers it with help today.
- `packages/i18n/src/messages.ts`: `vch.*`, `send.confirm_voucher`, `send.voucher_done`, `sms.voucher_*`, `pay.*`, `merch.*`, `sms.merchant_paid`, `sms.merchant_summary` are written. Use them; add only what is missing, in three languages.
- `apps/gateway/src/escrow/engine.ts`: how a flow with several money steps is written: one row per flow, a state machine, a state-checked `UPDATE`, one idempotency key per step, settle handlers for history and SMS, a `sweep` on a timer. Vouchers need the same shape.
- `apps/gateway/src/static.ts` and gap 9 below: the voucher page is the first page that is not the demo.

### Measure before building (first task)

Write `scripts/probe/voucher-probe.ts` and put its numbers in the build log before any engine code:

1. Does our Nutshell mint honour a NUT-11 locktime and refund key? Lock proofs to key A with a locktime already in the past and refund key B. Show that B can spend them, and that with a locktime in the future B cannot. If the mint does not enforce one of these, the 30-day return cannot rest on the mint and has to be the gateway's own sweep. Say which in section 9.
2. How long does `voucherKey(code)` take on this machine, and in Chromium on a slow phone profile? It is scrypt on purpose. If the page needs more than about 3 s on a cheap phone, the redeem page has to say so while it works.
3. What does a browser bundle with scrypt, secp256k1 and a P2PK signature weigh, gzipped? Rule 62 and the page rule say under 30 KB and nothing from another server. If the bundle cannot fit, the first plan's "unlock in the browser" is in trouble: write down the numbers and the two roads (a bigger page as an exception, or redeeming through the gateway with the code) and ask the owner before building the page.

### Where the code goes

```
apps/gateway/src/vouchers.ts         Vouchers: create, redeem (USSD, SMS, page), refund after the locktime, write-off when redeemed elsewhere, sweep
apps/gateway/src/merchants.ts        Merchants: enrol, code, pay, summary, poster data
apps/gateway/src/schema.ts           gateway/003-vouchers: tables `vouchers` and `merchants`
apps/gateway/src/ussd/machine.ts     flows 4 (pay a shop) and 7 (create, redeem), send to a number with no account, the merchant's sales screen
apps/gateway/src/ussd/perform.ts     their effects
apps/gateway/src/smsin.ts            BON <code>
apps/gateway/src/http.ts             the voucher page's two calls (read a locked token by the code's hash, report a redeem), rate-limited
apps/gateway/src/main.ts             vouchers.sweep() on a timer, the evening summary on a timer
apps/simulator or apps/voucher-web   the redeem page (gap 9: decide first)
```

### The flows

Create (7, 1): amount, confirm, code. The vault moves the sats from `user:<id>` to `voucher:<voucherId>` with a P2PK
lock to `voucherKey(code).pubHex`, the locktime 30 days out and the creator's refund key if probe 1 says the mint
honours it. The row stores `voucherCodeHash(code)`, never the code. The code goes to the creator on the screen and
by SMS (`sms.voucher_self`) and is then forgotten by the gateway.

Send to a number with no account (2, number, amount): `send.confirm_voucher` instead of a refusal. The same create,
then `sms.voucher_to` to that number. This is the first SMS to a number that has not asked for anything (rule 50
says a number with no account gets no reply). Cap it: one voucher to a new number per sender per day, and the
first-payment limit applies. Write the test for the cap before the code.

Redeem by USSD (7, 2, code) or SMS (`BON <code>`): normalise the code (typos are caught by the check character
before any lookup), find the voucher by its hash, derive the key, `Vault.transfer` from `voucher:<id>` to the
redeemer with `privkey`. One redeem wins; the second gets `vch.gone`. Every attempt counts toward a per-number and a
global rate limit, because the check character makes a random code fail fast but a stolen list of hashes does not
exist and must not be needed.

Redeem on the page: the page asks the gateway for the locked token by the code's hash (never the code), derives the
key in the browser, and either swaps at the mint itself or hands the signed proofs back. Probe 3 decides which.
`Vault.writeOffSpent` notices a voucher spent outside and closes it.

Refund: after the locktime, the sweep moves an unredeemed voucher back to its creator (`sms.voucher_refund`).

Pay a shop (4, merchant code, amount): the shop's name on the confirm screen, then the code, then a send to the
merchant's account the way `Wallet.send` does it, with `sms.merchant_paid` to the shop and the receipt to the
customer. A merchant's evening summary at 20:00 Dakar time (`sms.merchant_summary`), once a day, from the history.

### Tests to write first

Unit: the voucher state machine like `trade.test.ts`; a code with a typo is refused before any database read; a code
is in no log, no row and no `/sim/state` (add its pattern to the log tests; `redact` already has one, check it); the
redeem rate limits; a voucher to a new number is capped; the merchant code is refused when it is not 5 digits or
unknown, before the amount is asked; the new code prompts in `PIN_STEPS` and in the two lists of `machine.test.ts`;
golden files for flows 4 and 7 in three languages.

Integration (`apps/gateway/test/vouchers.itest.ts`): create then redeem by USSD, by SMS and through the page's two
calls, each ending with `expectConsistent()`; two redeems of one voucher at the same moment, from two processes:
one wins; a voucher redeemed in another wallet is written off; a voucher past its locktime goes back to its creator,
once; the mint's reply lost during a redeem; a send to a number with no account becomes a voucher and that number
can open an account and redeem it; a payment to a shop with both receipts; the evening summary is sent once a day.

End to end (`e2e/vouchers.spec.ts`): a visitor makes a voucher on one phone and redeems it on the other. A customer
pays a seeded shop.

Add to `scripts/mutate.mjs`: the redeem rate limit, the check that the voucher is not already spent, the cap on
vouchers to new numbers, the code check on a shop payment.

### Not in this phase

Paper vouchers printed by agents. Publishing vouchers to Nostr (phase 10). Offline acceptance by a merchant's web
app: the first plan caps it at 2,000 F because a double spend cannot be ruled out offline. It needs its own page
with cached mint keys; build it only if the owner wants it before phase 13, and say so in the report. Auto cash-out
of a merchant's day to an agent.

### Done when

Flows 4 and 7 run between two phones in the simulator. `npm test`, `npm run test:int` and `npm run test:e2e` pass,
the gateway tests pass with `TEST_DATABASE_URL`, `npm run typecheck` and `npm run lint` are clean, and
`node scripts/mutate.mjs` catches every line. The probe's numbers are in the build log. The items in section 1
point 5 are updated, and section 3 holds the brief for phase 8.

### What phase 6 handed over

Cash-in and cash-out through an agent, with the agent's sats held in a Lightning payment during a cash-in and the
user's ecash in `escrow:<tradeId>` during a cash-out. Bonds, disputes, the arbiter's route. Two seeded agents
(Ndeye on Wave, Ousmane on Orange Money) whose wallet is the regtest world node. On the demo page the second phone
can be an agent's, and a two-step walk-through follows the cash-in from the SMS.

- `apps/gateway/src/escrow/`: `trade.ts`, `agents.ts`, `engine.ts`. Migration `gateway/002-agents`.
- `POST /ops/escrow/decide` behind `OPERATOR_SECRET`, `POST /sim/decide` in demo mode.
- `ESCROW_CLTV_BLOCKS` and `ESCROW_BLOCK_SECONDS`, checked against the 3 hour cap at start. 432 and 30 on the stack.
- `scripts/probe/hold-cltv-probe.ts` and its numbers in the build log.

Gaps that are known and not closed. Do not describe any of these as done:

1. The demo routes, `/sim/decide` among them, have no rate limit. A hosted demo needs one first (phase 13).
2. A deposit through the top-up button whose payment to the mint fails for good is still not retried (phase 8). A cash-in's credit is retried under a new key (decision 59).
3. The Lightning address on the screens is not payable until phase 8.
4. Sessions, the per-user send queue and the per-trade queue of the escrow live in the memory of one process. Phase 12. Trades between two processes were tested (the state check holds), but sends were not.
5. A send that runs past the step budget and is then refused sends no SMS. Phase 12.
6. Nothing limits how many numbers one caller can look up on the send screen. Phase 9.
7. All Wolof, in the menus and on the pages, is unreviewed.
8. The pages were opened in Chromium only.
9. `static.ts` serves one folder. The voucher page is the first page that is not the demo: decide in this phase whether it is a page of `apps/simulator` or its own app with a second mount, and write it down. It must be served outside demo mode, which nothing is today.
10. Browser and integration tests do not run in CI (phase 12). GitHub warns that `actions/checkout@v4` and `actions/setup-node@v4` were written for Node 20.
11. No decision of the arbiter is signed (phase 10). There is no console (phase 11): a decision is a call to `/ops/escrow/decide`.
12. An agent's wallet linked by NWC was tested for the Lightning leg only, on the public sandbox. The whole trade runs on regtest with the world node as every agent's wallet.
13. The engine refuses an invoice from the agent's wallet for another amount. No test sends such an invoice yet (phase 12).
14. On regtest the helper mines six blocks at once when it opens a channel. A held cash-in can reach its block limit before the 3 hour cap when that happens; the engine then treats it as expired, or as released in a dispute.
15. No francs move in the demo. The agent's confirmation is a button press.
16. LND's `pay` answers "pending" for a payment it refuses for an over-long block delta (the probe's 2,100 blocks), instead of "failed". Safe, because a pending payment is looked up, but imprecise.
17. The regtest mint logs a balance mismatch instead of stopping (decision 67). Its watchdog stopped it on a normal deposit. Phase 10's reserve check must count paid quotes not yet collected; a real deployment needs the question answered again.

## 4. Rules that keep the build from breaking

Each rule exists because something depends on it. The file or test that guards it is named.

### Money

1. Amounts are whole sats as JavaScript numbers, checked with `Number.isSafeInteger`. FCFA are whole numbers too. Millisats exist only inside the Lightning adapters. Use `toSafeInt` on anything read from the database.
2. All ecash movement goes through the `Vault` methods: `mintFor`, `transfer`, `exportToken`, `importToken`, `melt`, `writeOffSpent`. Never insert, update or delete rows in `proofs`, `ops`, `accounts`, `postings` or `journal` from anywhere else.
3. All ledger writes go through `post()` in `packages/ledger/src/ledger.ts`. Only accounts starting with `ext:` may go negative.
4. Account names: every vault owner `X` has `X:spendable` and `X:locked`. Owners so far: `user:<id>`, `voucher:<id>`. Planned: `bond:<agentUserId>`, `escrow:<tradeId>`. Fixed accounts: `float:node`, `float:minting`, `ext:lightning`, `ext:ecash`, `ext:mintfees`, `ext:lnfees`, `ext:operator`, and `fees:income` for later.
5. The invariant: for every owner, ledger (spendable + locked) equals the sum of its live and reserved proofs. `Vault.auditAll()` checks it. Every new money flow gets a test that ends with `expectConsistent()` as in `vault.itest.ts`.
6. Every operation that calls the mint stores its plan first, in the same transaction that reserves the funds. The order is always: reserve and store, network call, settle or release.
7. An unknown outcome is never retried by hand. `pending` means: leave the funds locked and call `vault.resume(opId)` or `vault.recover()`. The mint is asked what happened (proof states, restore, quote state). The Lightning node is asked with `lookupPayment`.
8. One outgoing operation per owner at a time. A second one gets `BUSY`. Do not work around it.
9. An idempotency key applies once. A replay with the same key returns the first operation, even a failed one. A new attempt needs a new key.
10. The vault's first failure throws an `AppError`. A replay of that key returns a view with `status: "failed"`. Callers must handle both.
11. A sealing key is derived from the server pepper and the owner's salt. `ensureOwners` commits the salt before the money transaction starts. Never create an owner row inside a money transaction (defect 12 in the build log).
12. `Vault.melt` refuses when the mint's fee reserve is above `feeCapSat(amount)`, which is 5 sats or 0.5 %. Measured with `scripts/probe/fee-reserve-probe.ts`: when the mint's node knows a route, the reserve is 3 to 4 sats for any amount from 100 to 500,000 sats. When it knows none (its channels are down), Nutshell falls back to 1 % with a 2 sat floor, and every pay-out of 1,000 sats or more is refused. On regtest that refusal is right. On a public network with far destinations the fallback may be common: phase 8 decides, with a test, whether the cap becomes configurable. Do not loosen it silently.
13. `Vault.melt` does not support mints that charge input fees yet (it throws). The pilot keyset has no input fee.

### Lightning

14. `LightningBackend.pay` never throws for a payment that may have left. It returns `pending`. Resolve with `lookupPayment(hash)`.
15. `cancel(hash)` returns a boolean. False means the wallet had nothing to cancel: on the NWC sandbox an unpaid hold invoice cannot be cancelled and stays payable until it expires. The escrow engine must keep watching a cancelled trade's invoice until expiry and cancel a late payment on sight.
16. A channel balance read can land mid-update. For exact comparisons read until two reads agree (`quietBalance` in `packages/lightning/test/contract.ts`).
17. LND path parameters holding bytes need URL-safe base64 with padding (`b64url` in `lnd.ts`).
18. A new backend must pass `runContract` unchanged.

### Cashu library

19. `@cashu/cashu-ts` is pinned to 4.13.1. Its API is builder style and differs from older tutorials. Read `node_modules/@cashu/cashu-ts/lib/types/index.d.ts`, not a blog post.
20. The library retries network errors on the mint's cached endpoints by itself, up to 9 times. A single injected fault is invisible. The request timeout is capped at 15 s in `packages/cashu/src/index.ts`; the library default is 5 minutes.
21. Signed inputs must go through `wireProofs` so the witness is a JSON string.
22. A melt needs inputs worth exactly amount plus fee reserve. The vault swaps to exact proofs first.
23. Swaps are always real swaps, even when the inputs already add up. Two owners never hold the same secret.

### Code and tooling

24. Node 24 runs the TypeScript sources directly. Use only erasable syntax: no `enum`, no parameter properties, no namespaces. Import with the `.ts` extension. Use `import type` for types.
25. TypeScript stays on 6.x until typescript-eslint accepts 7.
26. Database access is the `Db` interface in `packages/ledger/src/db.ts`: plain SQL, `$1` parameters. JSON parameters are passed as `JSON.stringify(x)` with a `::jsonb` cast. The same SQL must run on Postgres 17 and on PGlite.
27. Never call `db.query` on the root handle from inside a `db.tx` callback. PGlite deadlocks. Use the `tx` handle.
28. Migrations are append-only. Each package exports its list (`ledgerMigrations`, `vaultMigrations`, later `gatewayMigrations`).
29. Logs go through `createLogger` from `@melax/core`, which redacts. No `console.log` in packages or apps. Never log a phone number, PIN, voucher code, invoice, token or SMS body. If a new kind of secret appears, add its pattern to `redact` and a case to `packages/core/test/core.test.ts`.
30. Time comes from an injected `Clock`. No `Date.now()` in service code, so tests can move time.
31. Edits are made with an editor. Not with sed, not with an inline one-liner, and not with a script written through a shell heredoc: the shell on this Windows machine eats backslashes on the way in. It mangled a regex in phase 1 (defect 5) and three more edits in phase 4 (defect 19). A script that only moves whole files or lines around is fine.

### USSD and SMS

32. A `Screen` is only built with `con`, `end` or `menu`. They enforce 160 GSM-7 characters and 7 options.
33. Every word shown to a user is in `packages/i18n/src/messages.ts`, in French, Wolof and English, GSM-7 only: no ç, ê, ô, ë, ŋ. The i18n test fails otherwise. `WOLOF_REVIEWED` stays false until a native speaker has read the Wolof.
34. Every SMS goes through `assertGsm7`. Text typed by users goes through `toGsm7` or `clip` first.
35. No inbound SMS command may move money out. `parseCommand` has a test for it. Sender numbers can be spoofed.
36. A webhook is trusted only after its signature and timestamp are checked (`parseAsgWebhook`, `parseHttpSmsWebhook`, `genericHttp`). Africa's Talking does not sign: its route sits behind a secret path and an IP allow-list.

### Tests

37. Unit tests end in `.test.ts` and need nothing running. Integration tests end in `.itest.ts` and need the stack.
38. Do not replace an integration test with a mock of the mint or of Lightning. If a test is slow, make it shorter.
39. Fixtures of third-party shapes come from that party's documentation or from a recorded call, with the source named in the test. Not from memory.
40. Gateway tests build their app with `testApp()` in `apps/gateway/test/helpers.ts`. A test that restarts the app must keep the same `MELAX_PEPPER`, as a real restart does (defect 20).
41. `TEST_DATABASE_URL` runs the gateway tests on a real Postgres server instead of PGlite. Run both before finishing a phase that adds SQL (section 6).
42. The golden files in `apps/gateway/test/golden/` change only on purpose. `npx vitest run apps/gateway -u` rewrites them; read the diff before committing it.
43. `node scripts/mutate.mjs` breaks one guarded line at a time and checks that a test fails. When a phase adds a control, add its line there.

### Gateway (from phase 4)

44. A secret code is compared in one place: `Users.checkPin` in `apps/gateway/src/users.ts`. Every effect that spends or shows something private calls it first. Nothing else reads `pin_hash` or writes `pin_fail_count` and `pin_locked_until`, except `changePin`.
45. In the menu machine a code lives in `v` only between the prompt that read it and the result of the effect that used it. A new step that reads a code goes into `PIN_STEPS`, and its flow goes into the lists in `machine.test.ts` ("no state holds a code once its effect has run", "never resumes at a code prompt").
46. An effect and its result can carry a code. Never log either. `perform.ts` logs the effect's name only.
47. The idempotency key of a USSD money effect is `ussd:<sessionId>:<effect name>`. The order inside `Wallet.send` is fixed: code, then an earlier operation under the same key, then limits, then the vault.
48. The vault has one settle hook and `SettleRouter` (`apps/gateway/src/settle.ts`) owns it. A new money flow puts `t: "<name>"` in its operation's meta and registers `settle.on("<name>", handler)`. Never call `vault.onSettled` again. A handler uses only the `tx` it is given, makes no network call, and builds its SMS through `Wallet.text` or the same pattern: a sentence that cannot be built is logged and skipped, because a handler that throws leaves the money locked.
49. A route with no authentication exists only behind `if (config.demo)`. Every other route mounts only when its secret is configured. Bodies are read as raw text so signatures are checked over the bytes received. An error answers one word.
50. An SMS is queued with `outbox.queue(tx, ...)` inside the transaction of the change it reports. Nothing calls an adapter directly. A number with no account gets no reply.
51. The server pepper becomes three keys in `app.ts`: `deriveKey(pepper, "pin")`, `"phone"`, `"data"`. Changing a label orphans every account. Sealed columns carry a purpose tag: `user:phone:<id>`, `sms:to`, `sms:body`.
52. Sends are serialised per user inside one process (`Wallet.serial`), and sessions are in memory (`MemorySessions`). Do not run two gateway processes until both have moved to the database (phase 12).
53. The sats of a send are the ones the confirm screen showed. `Wallet.send` refuses when they are more than 5 % away from the current rate. Screens that show francs get the rate from `Rates.get()` and from nowhere else.
54. A variable that is set but empty is treated as not set (`loadConfig`). A failed configuration check names the variable and the rule, never the value.

### Deposits, the demo and the pages (from phase 5)

55. Sats that arrive over Lightning become a user's ecash through `Wallet.deposit` or in the same order: ask the gateway's own node, go on only for a settled invoice, credit the amount the node reports, post under `recv:<paymentHash>`, mint under `mint:<paymentHash>`. Never credit an amount a caller supplied.
56. What only makes sense in a demo is refused outside demo mode by `loadConfig` (`DEMO_SEED`, `DEMO_WORLD_LND_*`). Demo routes live in `apps/gateway/src/demo.ts` and are mounted by `mountDemo`, behind the same `if (config.demo)` as `/ussd/sim`.
57. The node that pays top-ups reaches the app only through `regtestWorld`, which hands it over when both nodes report regtest. Do not build it anywhere else.
58. `/sim/state` shows first names in place of user ids and nothing else about a person. A new field there goes through the test that dumps the page and searches it (`demo.test.ts`, `demo.itest.ts`).
59. Pages are served from the map `loadStatic` fills at start. No handler may build a file path from a request.
60. The simulator's guide and the browser tests read the `kind` of four SMS: `welcome`, `deposit`, `sent`, `received`. Those names are an interface now. Renaming one breaks the guide.
61. The seeded people, their numbers (`+22177000010x` and so on, in `DEMO_PEOPLE`) and `DEMO_PIN` are used by the browser tests. Add people at the end of the list.
62. The pages allow scripts, styles and requests from this server only (`CSP` in `static.ts`). So: no inline script, no inline style attribute set from markup, nothing from a CDN, no web font. The pages write text with `textContent`, never markup.
63. Every word on a page is in `apps/simulator/src/copy.ts`, in English, French and Wolof, and reaches the HTML through `data-t`. The words on the phone's own screen come from the gateway. The one exception, `screens`, is checked against `packages/i18n` by `apps/simulator/test/copy.test.ts`.
64. `boot.ts` is the only place that connects the database, the mint and the nodes. `main.ts` adds the port, the timers and the signals. A script that needs an `App` calls `boot()`.
65. Browser code has its own type-check configs (`apps/simulator/tsconfig.json`, `e2e/tsconfig.json`). The root one has no DOM types, so server code cannot use them by accident. `npm run typecheck` runs all three.
66. The browser tests run against the `app` container. After any change under `apps/gateway`, `apps/simulator` or `packages`, run `docker compose up -d --build --wait app` before `npm run test:e2e`.
67. Until cash-out exists, test money flows one way: world node, gateway node, mint. The regtest helper adds a channel when a side runs low. If top-ups start failing, run `node scripts/probe/balances.ts` first.
68. A page is not done until its stills have been looked at: `node scripts/stills.mjs`, then open the files in `stills/` at 1440 and 360 px in each language. Sideways overflow is measured by element boxes (`sticksOut` in `e2e/demo.spec.ts`), because a page can hide it from `scrollWidth`.

### Agents and the escrow (from phase 6)

69. A trade's state changes only through `move()` in `apps/gateway/src/escrow/engine.ts`: the next state comes from `next()` in `escrow/trade.ts`, and the `UPDATE` carries `AND state = <the state it was read in>`. A move that changed no row lost a race and does nothing more. Nothing else writes `trades.state`. Guarded by `trade.test.ts` and "a move made from a stale read of a trade changes nothing" in `escrow.test.ts`.
70. A cash-in's preimage is sealed under `trade:preimage:<id>` and opened in one function, `settleHeld()`. Never read it anywhere else, never log it.
71. A cash-in is credited the way a deposit is (rule 55): the node says settled, for the trade's amount, `post()` under `recv:<paymentHash>`, then `Vault.mintFor` under `cashin:<id>:credit`. A failed credit is asked again under `cashin:<id>:credit:<n>`, never under the same key.
72. The idempotency keys of a trade: `cashin:<id>:credit[:n]`, `slash:<id>[:n]`, `cashout:<id>:lock`, `cashout:<id>:pay:<n>`, `cashout:<id>:change[:n]`, `cashout:<id>:refund[:n]`. The settle flow names `cashin`, `slash`, `cashout_lock`, `cashout_pay`, `cashout_change`, `cashout_refund`, `bond_in` and `bond_out` are taken. History rows and SMS of a trade come from those handlers only.
73. An agent's open cash-ins (`BONDED_STATES`: open, held, settling, disputed, released, bonding) never add up to more than the bond. The check runs inside the transaction that inserts the trade, after `Agents.lock()` on the agent's row. A bond is withdrawn whole, only with no open trade, and the offer is paused in the same transaction.
74. A closed cash-in keeps `watch` until its invoice has expired. `watchStep()` cancels any payment held on it (rule 15). Do not clear `watch` anywhere else.
75. `ESCROW_CLTV_BLOCKS` and `ESCROW_BLOCK_SECONDS` must hold a payment for the 3 hour cap plus 22 blocks, or `loadConfig` refuses to start. A new network sets both. The 22 is measured (`scripts/probe/hold-cltv-probe.ts`); re-measure on a new LND version.
76. A cash-out is a spend: the code, then the limits through `Wallet.limitCheck` (first payment to the agent included), then the balance, all inside `Wallet.serial` for that user. Its history row has `spend` set from the moment it locks, and a refund writes a `+` row with `spend` set, which gives the room back.
77. Log fields must not be named `event` (it overwrites the event's name), `from` or `to` (the logger hides them, phone numbers live there). Defect 42.
78. The agent desk is shown only to a user whose role is `agent`, and every desk effect in `perform.ts` starts with `Agents.get()`. Somebody else's trade answers `NOT_FOUND`, the same as no trade.
79. The demo's agents are the entries of `DEMO_PEOPLE` that carry `agent`. `seedDemo` never touches them; `seedAgents` adds whatever is missing on every start. Their wallet is the world node (`wallet_kind = 'world'`).
80. An integration test that compares the world node's balance reads only the channels it had at the start (`worldChannels` in `escrow.itest.ts`): the regtest helper opens a channel from the world node whenever it runs low. Defect 41.

## 5. Code map

| Path | What it is | Main exports | Tests |
|---|---|---|---|
| `packages/core` | Errors, ids, clock, phone numbers, FCFA and sats, log redaction | `AppError`, `newId`, `FakeClock`, `normalizePhone`, `maskPhone`, `fcfaToSats`, `createLogger`, `redact` | `core.test.ts` |
| `packages/crypto` | Wrappers over node:crypto | `hashPin`, `verifyPin`, `isWeakPin`, `seal`, `open`, `deriveUserKey`, `deriveKey`, `phoneLookupKey`, `newVoucherCode`, `normalizeVoucherCode`, `voucherKey`, `randomAlias` | `crypto.test.ts` |
| `packages/ledger` | Database handle, migrations, the journal | `createPgDb`, `createMemoryDb`, `migrate`, `truncateAll`, `post`, `balance`, `allBalances`, `verifyLedger` | `ledger.test.ts` |
| `packages/lightning` | One interface, two adapters, invoice checks | `LightningBackend` (`makeHoldInvoice` takes `cltvExpiry`, LND only), `LndBackend`, `NwcBackend`, `decodeInvoice`, `checkInvoice`, `feeCapSat` | `invoice.test.ts`, `contract.ts` run by `lnd.itest.ts` and `nwc.itest.ts` |
| `packages/cashu` | Mint client: plan, run, recover | `MintClient` (`planSwap`, `runSwap`, `recoverSwap`, `mintQuote`, `planMint`, `runMint`, `recoverMint`, `meltQuote`, `planMelt`, `runMelt`, `checkMelt`, `states`, `encodeToken`, `decodeToken`, `verifyOffline`) | `mint.itest.ts` |
| `packages/vault` | Sealed proofs plus ledger plus recovery | `Vault` (`mintFor`, `transfer`, `exportToken`, `importToken`, `melt`, `writeOffSpent`, `findOp`, `resume`, `recover`, `audit`, `auditAll`, `liveProofs`, `verifyHoldingsWithMint`, `onSettled`), `vaultMigrations`, `FLOAT_NODE` | `vault.itest.ts` |
| `packages/limits` | Spend tiers, PIN lockout, delays | `TIERS`, `tierFor`, `checkSpend`, `onPinFailure`, `onPinSuccess`, `isPinLocked`, `withdrawalDelayMs` | `limits.test.ts` |
| `packages/sms` | GSM-7, inbound commands, phone-gateway adapters | `assertGsm7`, `toGsm7`, `smsSegments`, `parseCommand`, `AndroidSmsGateway`, `HttpSms`, `MemorySms`, `parseAsgWebhook`, `parseHttpSmsWebhook` | `sms.test.ts` |
| `packages/ussd` | Menu SDK | `con`, `end`, `menu`, `Machine`, `UssdRuntime`, `MemorySessions`, `africasTalking`, `genericHttp`, `simulator` | `ussd.test.ts` |
| `packages/i18n` | Wording | `t`, `clip`, `messages`, `LANGS`, `methodName`, `WOLOF_REVIEWED` | `i18n.test.ts` |
| `packages/nostr`, `packages/fiat-rails` | Empty. Phases 10 and 15 | | |
| `apps/gateway/src/config.ts` | The environment, checked once. Refuses an escrow block delta that cannot cover the 3 hour cap | `loadConfig`, `Config`, `ESCROW_HARD_CAP_SEC`, `ESCROW_LND_MARGIN_BLOCKS` | `config.test.ts` |
| `apps/gateway/src/schema.ts` | Tables: `users`, `txlog`, `sms_outbox`, `price_cache`, `audit_log`, `flags`, sequence `receipt_no`; from `gateway/002-agents`: `agents`, `trades` | `gatewayMigrations` | every gateway test |
| `apps/gateway/src/rules.ts` | What a first name and an address name may look like | `NAME_RE`, `ALIAS_RE`, `isReservedAlias` | `users.test.ts`, `machine.test.ts` |
| `apps/gateway/src/users.ts` | Accounts and the secret code | `Users` (`register`, `findByPhone`, `byId`, `phoneOf`, `addressOf`, `checkPin`, `changePin`, `setLang`, `setAlias`) | `users.test.ts` |
| `apps/gateway/src/rates.ts` | FCFA per bitcoin, cached | `Rates.get`, `RATE_URL` | `rates.test.ts` |
| `apps/gateway/src/smsout.ts` | SMS outbox, sealed, retried | `SmsOutbox` (`queue`, `flush`, `list`) | `smsout.test.ts` |
| `apps/gateway/src/smsin.ts` | Inbound SMS commands | `SmsInbound.handle` | `http.test.ts` |
| `apps/gateway/src/settle.ts` | Routes the vault's settle hook by flow | `SettleRouter` (`on`, `dispatch`) | `wallet.itest.ts` |
| `apps/gateway/src/wallet.ts` | Balance, resolve, quote, send, deposit, history, limits. Writes history and receipts when a send or a deposit settles | `Wallet` (`limitCheck`, `serial` and `text` are also used by the escrow) | `wallet.itest.ts`, `perform.test.ts`, `demo.test.ts`, `demo.itest.ts` |
| `apps/gateway/src/ussd/machine.ts` | The menus as a pure machine | `createWalletMachine`, `runtimeTexts`, `PIN_STEPS`, types `S`, `Effect`, `Res` | `machine.test.ts`, `test/golden/` |
| `apps/gateway/src/ussd/perform.ts` | Runs effects by calling the services | `createPerform` | `perform.test.ts`, `wallet.itest.ts` |
| `apps/gateway/src/http.ts` | Fastify routes, `/ops/escrow/decide` when `OPERATOR_SECRET` is set | `buildHttp` | `http.test.ts`, `wallet.itest.ts` |
| `apps/gateway/src/app.ts` | Wires everything from injected parts | `buildApp`, `App` | all, through `test/helpers.ts` |
| `apps/gateway/src/boot.ts` | Connects everything and returns an `App`. Opens no port | `boot` | every start of the `app` service |
| `apps/gateway/src/main.ts` | The server: boot, recover, sweep the trades, seed if asked (people, then agents), listen, timers (recover, SMS, escrow sweep every 5 s), the node's invoice stream, clean stop | | `docker compose up`, `docker compose stop app` (timed in the build log) |
| `apps/gateway/src/demo.ts` | Demo mode only: `/sim/*` routes (`/sim/decide` among them), the top-up, the seed, the two agents | `mountDemo`, `fundAccount`, `seedDemo`, `seedAgents`, `regtestWorld`, `DEMO_PEOPLE`, `DEMO_AGENT_RANGE`, `DEMO_PIN`, `FUND_CAP_FCFA` | `demo.test.ts`, `demo.itest.ts` |
| `apps/gateway/src/escrow/trade.ts` | The trade state machine, pure | `next`, `STATES`, `EVENTS`, `TERMINAL`, `OPEN_STATES`, `BONDED_STATES`, `ACTORS` | `trade.test.ts` |
| `apps/gateway/src/escrow/agents.ts` | Agents: offer, sealed mobile-money number, wallet, bond balance, prices | `Agents` (`enroll`, `get`, `lock`, `momoOf`, `wallet`, `setActive`, `bondSats`, `bondedSats`, `active`, `close`), `cashinSats`, `cashoutSats`, `bondOwner`, `METHODS` | `escrow.test.ts`, `escrow.itest.ts` |
| `apps/gateway/src/escrow/engine.ts` | Cash-in, cash-out, disputes, bonds, the sweep | `Escrow` (`offers`, `startCashin`, `startCashout`, `agentConfirm`, `agentDecline`, `agentSent`, `userConfirm`, `cancel`, `dispute`, `decide`, `bondAdd`, `bondOut`, `openTradeOf`, `nextFor`, `deskCounts`, `agentNumberFor`, `userNumberFor`, `get`, `byRef`, `step`, `sweep`, `watchInvoices`, `escrowBalance`), `WINDOW_MS`, `HARD_CAP_MS`, `OPEN_TTL_MS` | `escrow.test.ts`, `escrow.itest.ts`, `escrow.nwc.itest.ts`, `e2e/agents.spec.ts` |
| `apps/gateway/src/static.ts` | The built pages, served from memory | `loadStatic`, `mountStatic` | `demo.test.ts` |
| `apps/simulator` | Landing page (`index.html`) and simulator (`demo.html`). `src/copy.ts` words, `src/lang.ts` language switch, `src/api.ts` the five calls, `src/phone.ts` one phone, `src/demo.ts` the guide, the inboxes and the books, `src/landing.ts`, four CSS files | built into `dist/` by `npm run build:web` | `test/copy.test.ts`, `e2e/demo.spec.ts` |
| `e2e/`, `playwright.config.ts` | Browser tests against the running stack: `demo.spec.ts`, `agents.spec.ts` | | `npm run test:e2e` |
| `infra/` | `compose.yml` (gateway side), `compose.mint.yml` (mint side), `compose.regtest.yml` (test chain), `regtest-init/init.ts` | | `scripts/smoke.ts` |
| `scripts/` | `smoke.ts`, `dev-creds.sh`, `build-web.mjs`, `mutate.mjs`, `demo-seed.ts`, `stills.mjs`, `probe/` (`balances.ts` shows what each node can send; `hold-cltv-probe.ts` measures how long LND holds a payment) | | |
| `eslint.config.js`, `.github/workflows/ci.yml` | Lint rules. Type check, lint and unit tests on every push | | |
| `docs/threat-model.md` | Each threat, its control, and the test that shows it | | |

## 6. Running it

```
docker compose up -d --wait     # chain, three LND nodes, mint, Postgres, relay, and the gateway on http://localhost:8787. About 2 minutes
bash scripts/dev-creds.sh       # copies the regtest nodes' certificates and macaroons into .keys/ (git-ignored)
node scripts/smoke.ts           # mint, swap and melt with real payments
npm test                        # unit tests, no stack needed
npm run test:int                # integration tests, need the stack and .keys/
npm run typecheck               # server code, browser code and browser tests, each with its own config
npm run lint
npm run test:e2e                # browser tests against the app container (first time: npx playwright install chromium)
node scripts/stills.mjs         # stills of both pages into stills/, to look at
node scripts/mutate.mjs         # breaks fifteen guarded lines one at a time; each must make a test fail
docker compose up -d --build --wait app   # after changing the gateway or the pages, before the browser tests
docker compose stop             # keeps the volumes
```

The gateway tests on a real Postgres server (they empty every table, so use a database made for them):

```
docker compose exec -T postgres psql -U melax -d melax -c "CREATE DATABASE melax_test"
export TEST_DATABASE_URL=postgres://melax:melax@127.0.0.1:54329/melax_test
npx vitest run apps/gateway --no-file-parallelism
npx vitest run --config vitest.int.config.ts apps/gateway
unset TEST_DATABASE_URL
```

The gateway itself, on the host, against the stack. The pepper is at least 32 random bytes in hex; a new one
cannot read what an older one sealed, so keep one per database.

```
export MELAX_PEPPER=<64 or more hex characters>
export MELAX_DEMO=1                 # mounts /ussd/sim, keeps SMS texts, allows the in-memory SMS adapter
node apps/gateway/src/main.ts       # listens on 127.0.0.1:8787
curl -s -X POST localhost:8787/ussd/sim -H 'content-type: application/json' \
  -d '{"sessionId":"s1","phone":"771234567","input":"","dial":"#2580#"}'
```

Every variable is listed with its rule in `apps/gateway/src/config.ts`. The ones that matter: `DATABASE_URL`,
`MINT_URL`, `LND_REST_URL`, `LND_MACAROON_PATH`, `LND_TLS_CERT_PATH` (defaults fit the stack and `.keys/`),
`USSD_CODE`, `ADDRESS_DOMAIN`, `RATE_FIXED_XOF_PER_BTC` (unset means the live rate), `AT_SECRET` with
`AT_ALLOW_IPS`, `USSD_HTTP_SECRET`, `SMS_ADAPTER` with its keys, `ASG_SIGNING_KEY`, `HTTPSMS_SIGNING_KEY`,
`OPERATOR_SECRET` (mounts the arbiter's route), `ESCROW_CLTV_BLOCKS` with `ESCROW_BLOCK_SECONDS` (on the local chain
432 and 30, as `compose.yaml` sets them; a gateway started by hand against the stack needs both, or it refuses).
On Windows, stop the server with Task Manager or `taskkill`: a signal sent from Git Bash does not reach it.

Host ports, all on 127.0.0.1: gateway and pages 8787, mint 3338, Postgres 54329, LND REST gateway 18081, world 18082, mint node 18083, relay 7447, bitcoind RPC 18443.

Long campaigns: `PROPERTY_RUNS=10000 npx vitest run packages/ledger -t invariants` and
`VAULT_SENDS=1000 npx vitest run --config vitest.int.config.ts packages/vault -t "random sends"`.

If an integration run is aborted, a hold invoice can stay locked on the gateway node:
`node scripts/probe/lnd-cancel-held.ts` clears them.

After the stack has been stopped for hours, wait for `regtest-init` to report healthy before running anything:
it mines a fresh block and reconnects the nodes (defects 17 and 18 in the build log).

The build machine's Docker has 3.1 GB of RAM and 2 CPUs. Keep the stack under about 2.5 GB.

## 7. Later phases

Each gets a full "next phase in detail" section, like section 3, written when the phase before it ends.

**Phase 6, agents.** Done. Its brief is in git history (`docs/PLAN.md` at commit `db23379`), its record in the build log.

**Phase 7, vouchers and merchants.** Now section 3.

**Phase 8, Lightning address and pay codes.** `apps/lnurl`: `/.well-known/lnurlp/<alias>`, description-hash invoices on the gateway node, settle listener that credits through `vault.mintFor`. Pay codes (6 digits, 10 minutes) so a USSD user can pay any invoice. Resolver for outgoing addresses that refuses private ranges and redirects. Moving to a smartphone: sweep to an address, or a voucher for the full balance. Rule 12 is decided here.

**Phase 9, scam shield and recovery.** Guardians (2 of 3), PIN reset with a 24 hour freeze, withdrawal delay with cancel by SMS, reports checked before each send, the `ARNAQUE` checker (rules first, a small language model second, works with the model off), kill switch.

**Phase 10, public proof.** `packages/nostr`: NIP-69 offers with `f=XOF`, signed trade receipts, NIP-56 reports, NIP-98 login. Hourly reserve snapshots from the gateway and from a mint-side auditor, signed, published, anchored with OpenTimestamps. `apps/verify` recomputes everything in the visitor's browser. Circuit breaker pauses spending if liabilities pass reserves.

**Phase 11, operator console.** Users (masked), agents and bonds, live escrows, disputes, limits, liquidity, reserve history, flags, kill switch, audit log. Roles: operator, arbiter, read-only auditor.

**Phase 12, hardening.** Playwright suite through the simulator for every flow. Chaos tests: dropped sessions, lost Lightning replies, mint down. Every row of the threat model has a passing test. A test proves no personal data reaches the logs. A reviewer with no build context audits the money paths; findings land with tests. CI runs the integration job.

**Phase 13, delivery.** Hosted demo on Railway (the owner's choice, 15 Nov 2026. Not Vercel, not a plain server), with a runbook. README with the architecture diagram, constraints, metrics and next iteration, the 3 minute pitch script, Devpost text, logo.

What Railway changes, read from its docs on 15 Nov 2026 (`docs.railway.com/guides/docker-compose`, `/reference/volumes`, `/networking/private-networking`). Check each again when the phase starts:

- Railway does not import a compose file. Each of our nine containers becomes its own Railway service.
- A service has one volume, and the docs describe no way for two services to mount the same one. Our stack shares volumes in three places: `regtest-init` reads all three nodes' volumes, the mint reads its node's volume for the certificate and the macaroon, and the gateway reads `demo-keys`. Each of these needs another way to hand over credentials, or the test network has to run inside one service for the hosted demo. Pick one, test it, and write down what it costs. Running everything in one service would put both trust domains on one machine: say so on the page if that is the choice.
- There is no `depends_on`. `main.ts` and `regtest-init` must wait and retry on their own. `regtest-init` already does. The gateway does not: today it exits if the mint or the node is not up.
- Services reach each other at `<service>.railway.internal` over plain HTTP. LND's certificate must carry that name (`--tlsextradomain`), and the gateway must listen on IPv6 as well as IPv4 (`HOST=::`).
- An image that runs as a non-root user can be refused by its volume. Railway's fix is `RAILWAY_RUN_UID=0`.
- Volumes are 5 GB on the Hobby plan, 0.5 GB on a trial.
- Before anything public: the rate limit on the demo routes (gap 1 in section 3).

**Phase 14, voice.** Asterisk container, ARI app, keypad flows for amounts and PIN, recorded prompts, browser softphone. Wolof and French speech recognition for menu words only, with an accuracy report on recorded phrases.

**Phase 15, fiat rails and Mutinynet.** Bitnob, PayDunya and Wave adapters against recorded fixtures, off by default. A public test network profile.

## 8. What only the owner can supply

- A Railway project for the hosted demo, and a domain if wanted. The deploy itself is the owner's step, or needs his go each time.
- An Android phone with a SIM, for one real SMS round trip.
- An Anthropic API key if the scam checker's model step is to be tried live. The checker works without it.
- A native Wolof speaker to read the strings and, later, record the voice prompts.
- The decision to make the repository public and to submit.
- Optional sandbox accounts: Africa's Talking, Bitnob, PayDunya, Wave Business.

## 9. What changed from the first plan

| First plan | Now | Why |
|---|---|---|
| Name Jokko | Melax | Jokkolabs is a known hub in Dakar |
| Drizzle ORM | Plain SQL behind a 40-line `Db` interface | Money paths are easier to audit as SQL, and the same SQL runs in-process for tests |
| Two LND nodes | Three: world, gateway, mint | The gateway needs its own node for hold invoices and description-hash invoices, and something has to play the outside world |
| Compiled TypeScript | Node 24 runs the sources | One less step between a file and a running service |
| 16 random voucher characters, 79 bits | 15 random plus a check character, 73.6 bits | The plan asked for both 79 bits and a checksum; the checksum catches every typo and swap |
| Persisted library preview | Our own stored plan of outputs | Lets recovery use the mint's restore endpoint with no dependence on library internals |
| One work package per session, in waves | Numbered phases, one at a time, stop after each | The owner's call on 15 Nov |
| Balance and history open from the menu | Both ask for the secret code | A phone gets lent, and a balance is private |
| Sats worked out again when the code is typed | The sats on the confirm screen are the sats sent | What the user agreed to is what moves. A send between users exposes nobody to the rate |
| One server pepper used everywhere | Three keys derived from it, plus the vault's per-owner keys | The code hashes, the phone lookups and the sealed columns never share key bytes |
| An SMS from an unknown number gets "dial to open an account" | It gets no answer | Otherwise a forged sender makes the server text any phone |
| `sms_outbox` without retry columns | `attempts` and `next_at` added | A phone gateway that is off for a minute must not lose receipts |
| Gateway files as listed in the phase 4 brief | Three more: `rules.ts`, `settle.ts`, `smsin.ts` | Shared name rules, one owner for the vault's settle hook, inbound SMS kept apart from the routes |
| The demo seed has 6 users, 3 merchants, 2 agents | 6 users. Agents join in phase 6, merchants in phase 7 | A seeded agent or merchant that cannot do anything would be a prop |
| The simulator shows two phones side by side | Side by side on a wide screen, one at a time with a switch on a small one | It has to work with one thumb at 360 px |
| `scripts/demo-seed.ts` holds the seed | The seed is `seedDemo` in `apps/gateway/src/demo.ts`. The script calls it | The server runs the same code on an empty database |
| `apps/escrow` as its own app | A module inside the gateway (phase 6) | One process until sessions and the send queue move to the database |
| Both agent flows pass on the NWC sandbox | The Lightning leg of the escrow is tested on the sandbox, the whole flow on regtest | A sandbox wallet cannot pay the regtest mint |
| Disputes are decided within 24 hours while the payment stays locked | A cash-in dispute outlives its Lightning payment: the invoice is cancelled at the 3 hour cap and a decision for the user is paid from the agent's bond | A Lightning payment cannot be held for a day |
| Escrow window 45 min, hard cap 3 h, as plain numbers | The block delta of the hold invoice is a setting, checked at start against the cap | LND's default held a payment 32.5 minutes on the 30 s test chain. Measured in phase 6 (decision 52) |
| The cash-out pays "the agent's Lightning address" | The engine asks the agent's wallet (a `LightningBackend`) for an invoice of exactly the trade's sats | One interface for the regtest node and for an NWC wallet; no address resolver before phase 8 |
| Agent bond tiers set trade sizes | Each agent has a range in francs; the bond caps the sum of open cash-ins | A tier table is a decision for the console (phase 11); the cap is what protects users now |
| Both sides submit the mobile-money reference in a dispute | The user opens a dispute from the menu; the reference is given to the arbiter outside Melax (the SMS says to keep it) | A 160 character screen is a poor place to type a transfer reference. The console can take it |
| Agent web app for confirming | The desk in the menu (0, 4) | Same as the brief: the page can come with the console |

The design the build follows is below, kept from the first plan and corrected where the table above says so.

## Appendix A: the design this build follows

### A.1 Dependency audit (run 14 Nov 2026 from this machine)

Probe scripts live in `scripts/probe/` (`nwc-probe.mjs`, `cashu-probe.mjs`).

#### A.1.1 Tested live and working

| Dependency | What was tested | Result | Consequence for the design |
|---|---|---|---|
| Lightning hold invoices over NWC (`@getalby/sdk` 9.0.0, faucet.nwc.dev) | Created 2 sandbox wallets, plain pay, hold then settle, hold then cancel | All passed. State reads `accepted` while locked, payer balance drops by amount + 20 sat fee reserve, cancel refunds in full, `hold_invoice_accepted` notification exists | Agent escrow is buildable exactly as designed. Budget a fee reserve on the payer side |
| NWC faucet wallet | One POST, no signup, 10,000 fake sats, comes with a working Lightning address (LNURL-pay returned 200) | Works | Free payer/agent wallets for hosted demos and CI |
| Cashu mint (`cashubtc/nutshell:0.22.1`, FakeWallet) | Ran in Docker, minted, swapped, redeemed | Works. NUTs 4,5,7,8,9,10,11,12,14,17,19,20,29 advertised | Mint is a stock container, no fork needed |
| Cashu client (`@cashu/cashu-ts` 4.13.1) | `wallet.ops.mintBolt11`, `.send().asP2PK()`, `.receive().privkey()`, `checkProofsStates` | Works. v4 API is builder-style (`wallet.ops.*`), older tutorials are wrong | Pin 4.13.1, use `prepare()` + persisted preview before every swap |
| Bearer token size | Encoded tokens for 64 / 1,000 / 5,000 / 37,219 sats | 366 / 1,841 / 1,548 / 2,136 characters = 3 to 14 SMS segments | **A raw Cashu token cannot travel by SMS.** Designed around, see next row |
| Short-code voucher | 16-char code (30-symbol alphabet, 79 bits) -> scrypt (N=2^15, 70 ms) -> secp256k1 key -> token P2PK-locked to that key with a 30-day refund locktime | Redeem without code rejected, with code returned 5,000 sats, second redeem rejected, state check shows SPENT | Voucher = 16 characters by SMS or on paper. The locked token is stored by the gateway and mirrored to Nostr. It is useless without the code |
| NIP-69 order events (kind 38383) | Read from nos.lol, relay.primal.net, relay.mostro.network | Live orders with `f` (fiat), `pm` (payment method), `premium`, `rating` tags | Agent offers are published as standard NIP-69 with `f=XOF`, `pm=Wave / Orange Money`. Mostro-compatible clients can read them |
| Price feed | CoinGecko simple price | Returns BTC in XOF directly | Primary feed. mempool.space `/prices` returned empty here, so fallback is BTC/EUR x 655.957 (fixed peg) |
| Mutinynet | Faucet page 200, chain tip 3,588,991 | Alive | Public test-network profile is possible |
| Local toolchain | Node 24.14, npm 11, Python 3.12, Docker 29.9 + Compose 5.6, git | Present. Docker Desktop was stopped and has 3.1 GB RAM. No Rust, no Go | Whole stack is TypeScript + stock containers. No component may require a local Rust/Go build. Keep the compose stack under about 2.5 GB |

#### A.1.2 Exists but not in the shape needed: designed around

| Need | Finding | Replacement |
|---|---|---|
| USSD short code in Senegal | Africa's Talking does not list Senegal for USSD. Codes come from the regulator ARTP as `#2xxx#` plus an operator or aggregator contract | Melax speaks the Africa's Talking callback protocol (the de facto standard: `sessionId`, `serviceCode`, `phoneNumber`, `text`, reply `CON`/`END`) behind a `UssdProvider` interface. Ships with: our own web phone simulator, an AT adapter, and a generic HTTP adapter for a Senegalese aggregator |
| Africa's Talking simulator | Needs an account (docs returned 403 to scripts) | Own simulator, no account. AT adapter is tested against recorded fixtures of the documented request shape |
| Real SMS without a telco contract | Aggregators need contracts | `capcom6/android-sms-gateway` (Apache-2.0, 6k stars, pushed today): an Android phone with a local SIM becomes the gateway, with `sms:received` webhooks, multi-SIM, private server mode. `httpSMS` (AGPL) is the second adapter |
| Hold invoices in the NIP-47 spec | Not in the main spec text. They are an Alby extension that works on Alby Hub | `LightningBackend` interface with two implementations: LND (native hold invoices, used by the local stack) and NWC/Alby Hub. `getInfo` capability check at boot, refuse to start agent escrow without hold support |
| Mint Lightning backend | Nutshell supports FakeWallet, LndRest, LndRPC, CLNRest, Strike, SparkL2. No NWC, no LNbits | Mint runs on LND (`LndRestWallet`). Fallback container: `cashubtc/mintd:0.18-ldk-node` (mint with embedded LDK node) |
| Mobile money APIs (Wave, Orange Money, Bitnob, PayDunya) | All account-gated. Wave payouts unconfirmed in Bitnob docs | The fiat leg is never automated by default: the agent and the user confirm it by PIN, the sats sit in a hold invoice meanwhile. `FiatRail` adapters (Bitnob, PayDunya, Wave) are built against their documented shapes with recorded fixtures and switch on when keys exist |
| Proof of liabilities for a Cashu mint | No finished standard | Own scheme: per-keyset issued and redeemed totals from the mint database vs Lightning balance, signed snapshot published to Nostr and timestamped. Monthly keyset rotation closes each epoch. Nutshell's built-in "shut down if issued > backend balance" check is switched on |
| Wolof speech | Ungated: `CAYTU/whosper-large-v2` (Apache), `M9and2M/whisper-small-wolof` (MIT), `KhayaAI/w2v-bert-wol` (Apache), `BuzzASR/wolof` (MIT). TTS: `CONCREE/Adia_TTS` (Apache), `bilalfaye/speecht5_tts-wolof` (MIT). Gated: Kiriku ASR, galsenai xTTS. `facebook/mms-tts-wol` not found | Voice line uses whisper-small-wolof on CPU by default, whosper-large-v2 when a GPU is present. Money amounts and PIN are always keyed (DTMF), never spoken. Fixed prompts are pre-rendered audio files, TTS only for dynamic text |
| Phone line for voice | No Senegal voice API confirmed | Asterisk container (`andrius/asterisk`, pushed yesterday) with a browser softphone for the demo and a SIP trunk setting for production |
| A phone cannot hold keys | True for USSD | Stated openly: the gateway is custodial for USSD balances. Mitigated by gateway/mint separation, vouchers that exit the system, one-step sweep to self-custody, caps, and reserve proofs |

#### A.1.3 Not yet run (first tasks of the build)

- Done in phase 1: bitcoind regtest + LND nodes + Nutshell on `LndRestWallet` end to end (images confirmed: `btcpayserver/bitcoin:32.1`, `lightninglabs/lnd:v0.21.8-beta`).
- Wolof ASR accuracy on spoken menu words (measure on 50 recorded phrases before trusting it).
- A real SMS round trip through an Android phone.

#### A.1.4 Needs you (accounts and hardware)

An Anthropic API key (optional, only for the scam checker), a VPS (2 vCPU / 4 GB) and a domain, an Android phone with a SIM for the SMS gateway,
optional sandbox accounts (Africa's Talking, Bitnob, PayDunya, Wave Business), a Hugging Face token if
Kiriku is wanted.

### A.2 What gets built

1. **USSD wallet**: balance, send, receive, pay merchant, cash in, cash out, vouchers, history, PIN, language.
2. **SMS channel**: notifications, receipts, voucher redemption, balance, scam check. No spending by SMS.
3. **Voice line** in Wolof and French: balance, last payments, confirm incoming, guided send with keyed amount and PIN.
4. **Cashu mint** on Lightning, operated separately from the gateway.
5. **Short-code vouchers**: SMS and printable paper, redeemable in USSD, SMS, or the web app.
6. **Agent network**: cash-in and cash-out against Wave / Orange Money with hold-invoice escrow, bonds, disputes.
7. **Agent directory and reputation on Nostr** (NIP-69 offers, signed trade receipts).
8. **Lightning address per user** (`alias@domain`), LNURL-pay, so the diaspora can pay in from any wallet.
9. **Merchant mode**: merchant code, printed poster with QR + USSD string, SMS receipts, daily summary.
10. **Graduation path**: sweep to a self-custodial wallet (Lightning address, Cashu token, NWC).
11. **Scam shield**: recipient name before send, limits, delays, PIN lockout, guardian recovery, SMS scam checker.
12. **Operator console**: users, agents, disputes, limits, liquidity, reserve proofs, kill switch. Login by Nostr key.
13. **Public verify page**: reserves vs liabilities, checked in the visitor's browser.
14. **Open gateway SDK**: `@melax/ussd` so other Lightning apps can add a USSD front end.
15. **Web phone simulator** for judges, plus seeded demo data.
16. **Docs and submission**: README, architecture diagram, threat model, status table, pitch video.

### A.3 Architecture

```
 feature phone ──USSD──▶ aggregator ─┐
 feature phone ──SMS───▶ Android gw ─┼─▶ channel-gateway ─▶ core API ─▶ ledger (Postgres)
 any phone ─────voice──▶ Asterisk ───┘        │                 │
 web simulator ───────────────────────────────┘                 ├─▶ vault (ecash proofs per user)
                                                                ├─▶ mint client ─▶ Nutshell mint ─▶ LND-mint
 diaspora wallet ──LNURL-pay──▶ lnurl server ───────────────────┤
 agent wallet ◀──hold invoice── escrow engine ──────────────────┼─▶ LightningBackend (LND | NWC)
 Nostr relays ◀── offers, receipts, reserve proofs ─────────────┘
```

Two trust domains, two compose projects, two key sets:
- **Gateway** (channels, ledger, vault, escrow, LNURL): knows phone numbers, holds user proofs.
- **Mint** (Nutshell + its LND): sees blinded tokens only, cannot link payer to payee.

Stack: Node 24, TypeScript strict, Fastify, zod, Postgres 17, plain SQL (see section 9), vitest, fast-check, Playwright.
Front ends (simulator, voucher page, console, verify page): Vite + vanilla TS, target under 30 KB gzip each.
Containers: bitcoind, lnd-world, lnd-gw, lnd-mint, nutshell, postgres, nostr-rs-relay, asterisk, asr (optional profile), app.

### A.4 Component design

#### A.4.1 Ledger (the source of truth)
- Double-entry, append-only, hash-chained journal. Every money movement is one balanced transaction with an idempotency key.
- Accounts: user spendable, user locked, escrow, fees, mint float, agent bond.
- Invariant checked after every write and in property tests: sum of user balances = value of proofs in the vault.
- Outgoing payments use reserve -> attempt -> settle/release. A lost answer keeps funds reserved and is resolved by payment-hash lookup, never by retry.

#### A.4.2 Vault and custody
- User balance is a set of Cashu proofs, encrypted at rest with a per-user key = HKDF(server pepper from env/KMS, user salt). The PIN gates use; it is not the encryption key (a 4 to 6 digit PIN is brute-forceable, so claiming otherwise would be false).
- PIN: 5 digits, Argon2id + pepper, weak PINs refused, lockout 5 tries then 15 min -> 24 h.
- Phone numbers stored as HMAC for lookup plus an encrypted copy. No number, PIN, code or invoice in logs.

#### A.4.3 Lightning
- `LightningBackend`: `makeInvoice`, `makeHoldInvoice`, `settle`, `cancel`, `pay`, `lookup`, `subscribe`, `capabilities`.
- LND implementation over REST (invoicesrpc, routerrpc). NWC implementation over `@getalby/sdk`. Both built in phase 1.
- Every invoice decoded and checked (amount, hash, expiry, network) before it is trusted or paid. Fee cap max(5 sat, 0.5%).

#### A.4.4 Mint
- Nutshell 0.22.1 on `LndRestWallet`, input fee 0 for the pilot keyset, `MINT_MAX_BALANCE`, per-mint and per-melt caps, rate limits on.
- Keysets rotate monthly; each closed keyset is one audit epoch.
- Gateway talks to it only over the public Cashu API, so any standard mint can be swapped in.

#### A.4.5 USSD engine (`@melax/ussd`)
- Pure state machine: `(state, input) -> (state, screen)`. No I/O inside, so every menu path is a golden-file test.
- Hard limits enforced by the type system: 160 characters per screen, at most 7 options, session budget 20 s per step, 120 s total.
- Session resume: a dropped session reopens at the last confirmed step for 3 minutes.
- Languages: French, Wolof, English. Wolof strings flagged `needs-native-review` until signed off.
- Providers: simulator, Africa's Talking, generic HTTP. Signature/IP allow-list checks per provider, replay protection on `sessionId`.

Menu tree:
```
1 Solde            2 Envoyer           3 Recevoir          4 Payer marchand
5 Dépôt (agent)    6 Retrait (agent)   7 Bons (vouchers)   8 Historique
9 Mon compte: PIN, langue, alias, gardiens, limites, passer au smartphone
```
Every spend shows recipient name + amount in FCFA and sats, then asks for the PIN.

#### A.4.6 SMS channel
- Outbound: receipts, incoming-payment notices, voucher delivery, escrow prompts, security alerts.
- Inbound commands: `SOLDE`, `BON <code>`, `AIDE`, `ARNAQUE <texte>`. Nothing that moves money out.
- Adapters: android-sms-gateway (webhook HMAC verified), httpSMS, console (tests).
- GSM-7 only, single segment where possible; the encoder rejects text that would silently switch to UCS-2.

#### A.4.7 Voice line
- Asterisk + ARI app. Flow: language pick -> PIN by keypad -> spoken menu.
- ASR only for menu intent (a closed list of about 20 words per language) with keypad fallback after one miss.
- Amounts, phone numbers and PIN are keypad only. Every action is read back and confirmed with `1`.
- Prompts: recorded files per language; TTS (Adia_TTS) only for names and amounts.

#### A.4.8 Vouchers
- Create (USSD 7 > 1): amount -> PIN -> gateway swaps user proofs into proofs P2PK-locked to the code-derived key, locktime 30 days, refund key = issuer.
- Code: 16 characters in 4 groups (`K7MP-2XQR-9TWB-4HNC`), alphabet without lookalikes, last character is a checksum.
- Locked token stored by gateway under `sha256(code)` and mirrored to Nostr as an encrypted-to-nobody blob (it is safe to publish).
- Redeem: USSD (7 > 2), SMS (`BON <code>`), or web page that unlocks in the browser and offers "add to my Melax", "pay a Lightning address", or "export standard Cashu token".
- Paper vouchers: agent prints a sheet (QR + code + USSD string). Unclaimed vouchers return to the issuer after the locktime.
- Offline acceptance for merchants: web app verifies DLEQ + lock offline against cached mint keys and queues the swap; capped at 2,000 FCFA per voucher because double-spend cannot be ruled out offline.

#### A.4.9 Agents: cash-in and cash-out
Cash-in (user buys sats with Wave/Orange Money):
1. User: USSD 5 -> amount in FCFA -> picks an agent (nearest by commune, best rate, rating).
2. Escrow engine creates a hold invoice; the agent's own wallet pays it. Sats are locked, not delivered.
3. User sends francs to the agent's number outside Melax. SMS shows the exact number, name and amount.
4. Agent confirms receipt (USSD or agent web app, with PIN) -> engine settles -> user is credited through the mint.
5. No confirmation within 45 min -> cancel -> agent refunded automatically. Either side can open a dispute before that.

Cash-out is the mirror: the user's sats are locked in the ledger, the agent sends francs, the user confirms with PIN, the engine pays the agent's Lightning address.

Rules:
- Escrow window 45 min, hard cap 3 h (hold invoices tie up route liquidity, so long locks are not allowed).
- Agent bond: sats locked with the gateway, slashed on a lost dispute. Tiers set trade size limits.
- Disputes: both sides submit the mobile-money reference; arbiter (operator role) decides; decision is a signed ledger event.
- `FiatRail` adapters can auto-confirm step 4 where an API exists; default is human confirmation.
- The operator never receives or sends francs.

#### A.4.10 Nostr
- Agent offers: NIP-69 kind 38383 with `f=XOF`, `pm`, `premium`, `fa` range, geohash at commune precision.
- Trade receipts: signed by agent and gateway after settlement, no phone numbers, used for rating.
- Reserve snapshots and voucher blobs. Own relay in compose, optional publish to public relays behind a flag.
- Operator and agent login by Nostr key (NIP-98 HTTP auth); agent payouts and wallet linking via NWC.

#### A.4.11 Lightning address and LNURL
- `alias@domain` by default (random two-word alias). Phone-number addresses are opt-in, because a public address that is a phone number invites scams.
- LNURL-pay with description-hash invoices; payer comment delivered in the SMS receipt; amounts shown in FCFA.
- Pay codes: a smartphone payee turns an invoice or address into a 6-digit code valid 10 minutes, so a USSD user can pay any Lightning invoice.

#### A.4.12 Merchants
- Merchant code (5 digits), poster generator (QR for smartphones, `#2xxx*4*code#` for feature phones).
- SMS receipt to both sides with a receipt number; preimage kept as proof.
- Evening summary by SMS in the merchant's language; optional auto cash-out to a chosen agent.

#### A.4.13 Scam shield
- Recipient name shown before every send; first payment to a new recipient capped.
- Limits: per transaction, per day, per month; raised by account age and guardian setup.
- Large withdrawals wait 30 minutes with an SMS that lets the owner cancel.
- SIM-swap defence: a PIN reset needs 2 of 3 guardians (numbers chosen by the user) or an agent visit; reset freezes spending for 24 h.
- `ARNAQUE <texte>`: forwards a suspicious message; rules engine first, Claude second (`claude-haiku-5-5`, text only, no account data); reply is a one-line verdict in the user's language. Works with the model switched off.
- Reported numbers and addresses published as NIP-56 reports and checked before each send.

#### A.4.14 Reserves and verification
- Hourly snapshot: issued minus redeemed per keyset, Lightning balance (local + pending), ledger total, vault total.
- Signed, published to Nostr, anchored with OpenTimestamps (direct calendar HTTP calls; the npm client is stale).
- Verify page recomputes the hash chain and signature in the browser and shows one line: covered or not covered.
- Circuit breaker: if liabilities exceed reserves, spending pauses and the console alerts.

#### A.4.15 Operator console
Users (masked), agents and bonds, live escrows, disputes, limits, liquidity and channel health, reserve history,
feature flags, kill switch, audit log. Roles: operator, arbiter, read-only auditor.

#### A.4.16 AI use (kept narrow)
Scam-message verdicts, Wolof/French intent normalisation for the voice line, plain-language daily summaries for
merchants and the operator. The model never sees PINs, codes, full numbers or balances tied to a person, and has
no tools and no authority over money. Every feature has a rules-only fallback.

### A.5 Security plan

Threat model written first (`docs/threat-model.md`), one test per listed threat:

| Threat | Control |
|---|---|
| SIM swap | PIN on every spend, guardian reset, 24 h freeze, withdrawal delay |
| Stolen phone | PIN lockout, limits |
| USSD/SMS spoofing | Provider signatures, allow-lists, session replay protection |
| Database leak | Encrypted proofs and numbers, hashed lookups, pepper outside the database |
| Operator theft | Reserve proofs, mint/gateway separation, caps, public audit epochs |
| Agent fraud | Hold invoices, bonds, disputes, ratings |
| Voucher guessing | 79-bit codes, scrypt, rate limits on redeem endpoints |
| Double pay / lost reply | Idempotency keys, reserve-then-settle, lookup by hash |
| SSRF via Lightning addresses | Resolver that pins the checked IP, refuses redirects and private ranges |
| Prompt injection via SMS text | Model has no tools; output constrained to an enum + one sentence |
| Stuck HTLCs | Short escrow windows, CLTV margin check, sweeper |

### A.6 Repository layout

```
melax/
  apps/        gateway/  lnurl/  escrow/  voice/  console/  simulator/  voucher-web/  verify/
  packages/    ussd/  ledger/  vault/  lightning/  cashu/  sms/  nostr/  fiat-rails/  i18n/  limits/  crypto/
  infra/       compose.yml  compose.mint.yml  compose.voice.yml  regtest-init/  deploy/
  docs/        PLAN.md  ARCHITECTURE.md  DECISIONS.md  LITEPAPER.md  BUILD_LOG.md  status.md  threat-model.md  runbook.md
  scripts/     demo-seed.ts  smoke.ts  probe/
```

### A.8 Definition of done

- `docker compose up` on a clean machine gives a working wallet in the simulator in under 5 minutes.
- Every flow in section 2 runs on regtest with real Lightning payments and real ecash; the hosted demo runs the same stack.
- `docs/status.md` lists, per feature: real on regtest / real on Mutinynet / real with a physical phone / simulated.
- Threat model has a passing test per row. No PII in logs (tested).
- Public repo, MIT licence, CI green.

### A.9 Open items that code cannot close

- A real `#2xxx#` code needs ARTP and an operator; the build proves the protocol, not the contract.
- Wolof copy and voice prompts need a native speaker's review before they are called finished.
- BCEAO has no crypto framework and a Senegalese exchange case went to prosecutors in 2025. The design keeps the operator out of fiat for that reason; a pilot with real money still needs legal advice.
