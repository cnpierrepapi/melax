# Melax: build plan and handover

Bitcoin for any phone in Senegal: USSD, SMS and voice on top of Lightning and Cashu ecash, with agent cash-in
and cash-out that never puts francs or the pot in the operator's hands.

Target: Dakar Bitcoin Hack 2026. Submissions close Fri 20 Nov 2026 at 20:00 UTC (21:00 in Malta).

Read this file before touching the code. It says what is done, what comes next, and which rules keep new work
from breaking old work. Whoever finishes a phase updates it before stopping.

Last updated: 15 Nov 2026, after phase 5.

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
| 6 | Agents: cash-in and cash-out with hold-invoice escrow, bonds, disputes | **Next** | See section 3 |
| 7 | Vouchers and merchants | Not started | Section 7 |
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

## 3. Next phase in detail: phase 6, agents

### What it delivers

Francs become sats and sats become francs through a person: an agent with a mobile-money account. Melax never
touches the francs. During a cash-in the agent's sats sit in a Lightning payment that is locked, not delivered,
until the agent says the francs arrived. During a cash-out the user's ecash sits in an escrow account until the
user says the francs arrived.

Menu entries 5 (Depot) and 6 (Retrait) stop answering "Bientot disponible". An agent gets a desk in the menu. In
the simulator, the second phone can be an agent, so a visitor can walk a cash-in between two phones.

### Read first

- Rules 14 to 18 (Lightning), 44 to 50 (gateway), 55 and 60 (deposits and SMS kinds) in section 4.
- `packages/lightning/test/contract.ts`: "hold then settle", "hold then cancel", "cancel before payment". It shows how to pay a hold invoice without waiting for the payment to finish, and `quietBalance`.
- `apps/gateway/src/wallet.ts`, `deposit` and `onDepositSettled`: a cash-in ends the same way.
- `packages/vault/src/index.ts`, `melt`: a cash-out ends there.
- `packages/i18n/src/messages.ts`: the screens and SMS for this phase are already written (`agents.*`, `dep.*`, `wd.*`, `dispute.*`, `agent.*`, `sms.dep_*`, `sms.wd_*`, `sms.dispute*`). Use them. Add only what is missing, in three languages.

### Measure before building (first task)

Write `scripts/probe/hold-cltv-probe.ts` and put its numbers in the build log before any engine code:

1. How many blocks does a held payment survive on our LND nodes? `makeHoldInvoice` in `packages/lightning/src/lnd.ts` sets no `cltv_expiry`. The regtest helper mines a block every 30 s, so a default of some tens of blocks would end a held payment well inside the 45 minute window. Hold a payment, mine blocks, and find the block at which LND cancels it on its own.
2. Set `cltv_expiry` on the hold invoice from a new setting (`ESCROW_CLTV_BLOCKS`), sized for the 3 hour hard cap on the network in use, and show with the probe that the payment survives that long. Check that the paying node accepts that delta.
3. What does the gateway node report for a held payment after the invoice's own expiry time has passed?

Do not write "the window is 45 minutes" anywhere until the probe shows a payment held that long.

### Where the code goes

```
apps/gateway/src/escrow/trade.ts      the trade state machine, pure: (state, event) -> state or refusal
apps/gateway/src/escrow/engine.ts     Escrow: start, agentConfirm, agentDecline, agentSent, userConfirm, cancel, dispute, decide, sweep
apps/gateway/src/escrow/agents.ts     Agents: offers, bond, the agent's wallet handle
apps/gateway/src/schema.ts            gateway/002-agents: tables `agents` and `trades`
apps/gateway/src/ussd/machine.ts      flows 5 and 6, the agent desk
apps/gateway/src/ussd/perform.ts      their effects
apps/gateway/src/http.ts              POST /ops/escrow/decide, mounted only when OPERATOR_SECRET is set
apps/gateway/src/demo.ts              two seeded agents, POST /sim/decide, agents in /sim/people
apps/gateway/src/main.ts              escrow.sweep() once before listening, then on a timer
```

The first plan put this in `apps/escrow`. It is a module inside the gateway instead (decision 51): rule 52 says
one process until sessions and the send queue move to the database.

### The two flows

Cash-in (the user buys sats with francs):

1. User: 5, amount in FCFA, picks an agent from a short list (name, method, sats they will get). Confirm. No code: nothing of the user's moves.
2. The engine draws a random preimage, seals it in the trade row, and makes a hold invoice for its hash on the gateway's node. It asks the agent's wallet to pay it and does not wait for that call to return. The trade is `open`.
3. The node reports the invoice `accepted`: the trade is `held`. SMS to the user with the agent's mobile-money number, name, amount and reference (`sms.dep_user`). SMS to the agent (`sms.dep_agent`).
4. The user sends francs outside Melax.
5. Agent desk: "did you receive X from 77*****67?" Yes, then the agent's code. The engine settles the invoice with the preimage, then credits the user the way `Wallet.deposit` does, under the flow name `cashin`. History rows and SMS for both sides come from the settle handler. The trade is `done`.
6. No confirmation 45 minutes after `held`: the engine cancels the invoice, the agent's sats return, both get an SMS. `expired`.

Cash-out (the user sells sats for francs):

1. User: 6, amount, agent, confirm, code. The limits apply: this is a spend.
2. `vault.transfer` moves the sats from `user:<id>` to `escrow:<tradeId>`. The trade is `locked`. SMS to the agent with the user's number, name and amount (`sms.wd_agent`).
3. The agent sends francs outside Melax, then marks it sent on the desk. `sent`. SMS to the user (`sms.wd_user_sent`).
4. User: 6 shows the open trade (`wd.pending`). "Yes, received", then the code. The engine asks the agent's wallet for an invoice and calls `vault.melt` from `escrow:<tradeId>`. `done` when the melt settles.
5. The agent never marks it sent within 45 minutes, or declines: the sats go back to the user. `refunded`.
6. The agent marked it sent and the user does not confirm within 45 minutes: nobody can be believed without a look. The trade becomes `disputed`.

Rules both flows keep:

- One open trade per user. An agent's open cash-ins can never add up to more than the agent's bond.
- Every money step has its own idempotency key built from the trade id (`cashin:<id>:credit`, `cashout:<id>:lock`, `cashout:<id>:pay:<n>`, `slash:<id>`).
- The state machine in `trade.ts` is the only place that says which move is allowed. The engine applies a move with `UPDATE trades SET state = $new WHERE id = $id AND state = $old` and checks one row changed. Whoever loses that race does nothing.
- The preimage leaves the database in one place: the function that settles.
- Rule 15: a cancelled trade's invoice is watched until it expires, and a payment that arrives late is cancelled on sight. `sweep()` does this.

### Bonds and disputes

- An agent's bond is ecash under the vault owner `bond:<agentUserId>`. The agent moves it there from their own balance on the desk, with their code. It cannot be taken back while a trade or a dispute of theirs is open.
- A dispute on a cash-out is simple: the sats are in `escrow:<tradeId>` and stay there until someone decides.
- A dispute on a cash-in cannot keep a Lightning payment locked for a day. So: while the payment is still held, a decision for the user settles it. When the hard cap is reached first, the engine cancels the invoice, the agent gets the sats back, and a later decision for the user is paid out of the agent's bond (`vault.transfer` from `bond:<agent>` to the user). This is why open cash-ins are capped by the bond.
- `Escrow.decide({ tradeId, winner, arbiter, note })` does the money and writes one `audit_log` row. It is reached through `POST /ops/escrow/decide` behind `OPERATOR_SECRET` (rule 49), and through `POST /sim/decide` in demo mode. The console in phase 11 calls the same function. The plan calls the decision "a signed ledger event". Signing comes with the Nostr keys in phase 10. Until then call it recorded, not signed.

### The agent's wallet

The engine needs two things from an agent's wallet: pay this invoice, and give me an invoice. That is a
`LightningBackend`. On regtest the seeded agents use the world node. A real agent links a wallet by Nostr Wallet
Connect, and its connection string is sealed in the `agents` row with its own purpose tag.

The NWC sandbox and our regtest mint are on different networks. A sandbox wallet cannot pay the regtest mint, so
a whole cash-in with ecash cannot run on the sandbox. What can: the Lightning leg of the escrow (open, wait for
`accepted`, settle, cancel, and the late payment of rule 15) with the gateway's side on `NwcBackend`. Test the
leg on both backends and the whole flow on regtest. Do not write that both flows pass on the sandbox.

### Tests to write first

Unit (`apps/gateway/test/escrow.test.ts`, more cases in `machine.test.ts`, new golden files in three languages):
- the trade machine: for every state and every event, the move is in the table or it is refused. Nothing leaves `done`, `expired`, `refunded` or a decided dispute;
- starting is refused when: the amount is outside the agent's range, the agent is off, the agent is the user, the user already has an open trade, the agent's open cash-ins plus this one pass the bond, no agent fits (`agents.none`);
- a cash-out start is refused over a limit and over the balance, and counts toward the day's limit from the moment it locks. A refund gives the room back;
- only the trade's agent can confirm, decline or mark sent, and only with their code. Only the trade's user can confirm a cash-out, and only with theirs;
- the desk is not in the menu of someone who is not an agent;
- every new code prompt is in `PIN_STEPS`, and the existing "never resumes at a code prompt" and "no state holds a code" lists include the new flows;
- `/ops/escrow/decide` does not exist without its secret, and a wrong secret looks like a missing path;
- the mobile-money number of an agent and the number of a user are sealed in the database and in no log.

Integration (`apps/gateway/test/escrow.itest.ts`, real mint and nodes, the agent's wallet is the world node):
- cash-in: while `held`, the world node is down by the amount and `float:node` is unchanged. After the agent confirms, the user holds that much ecash, both histories and both SMS exist, `expectConsistent()`;
- cash-in times out: every sat is back on the world node (`quietBalance`), the user has nothing, both got the SMS;
- confirm and time-out at the same moment, many times over: exactly one wins, and the books are consistent either way;
- the process dies after the agent's confirmation is stored and before the node settled: a restart settles and credits once;
- the mint's reply is lost while crediting: recovery credits once;
- a late payment to a cancelled trade is cancelled on sight;
- cash-out: sats leave the user for `escrow:<id>`, the agent marks sent, the user confirms, the world node receives. The fee comes out of the locked amount, what is left returns to the user, and `escrow:<id>` ends at zero;
- cash-out refunded after 45 minutes with no "sent": the user has every sat back;
- cash-out, the pay-out fails: nothing is lost, the trade can be paid again with a fresh invoice;
- a cash-out dispute decided each way; a cash-in dispute decided for the user while held (settles) and after the hard cap (paid from the bond, bond reduced);
- a bond cannot be withdrawn with a trade open;
- a random run: starts, confirmations, cancellations and clock jumps in any order over many trades end with `expectConsistent()` and no closed trade's escrow account above zero;
- the logs of the whole file hold no number, code, name, invoice or preimage.

On the NWC sandbox (`escrow.nwc.itest.ts`): the escrow's Lightning leg, including rule 15.

End to end (`e2e/agents.spec.ts`): a visitor's phone starts a cash-in with a seeded agent, the agent's phone confirms it, the visitor's SMS and balance show it.

Add to `scripts/mutate.mjs`: the bond cap, the agent's code on a confirmation, the state check in the `UPDATE`, the user's code on a cash-out confirmation.

### Not in this phase

Publishing offers on Nostr and ratings (phase 10). The operator console (phase 11). Automatic confirmation
through a mobile-money API (phase 15). A separate web page for agents: the desk in the menu and the second phone
of the simulator cover it, and the page can come with the console.

### Done when

Both flows run between two phones in the simulator. `npm test`, `npm run test:int` and `npm run test:e2e` pass,
the gateway tests pass with `TEST_DATABASE_URL`, `npm run typecheck` and `npm run lint` are clean, and
`node scripts/mutate.mjs` catches every line. The probe's numbers are in the build log. The items in section 1
point 5 are updated, and section 3 holds the brief for phase 7.

### What phase 5 handed over

`docker compose up`, then `http://localhost:8787`: a landing page, and at `/demo` two phones that dial the real
gateway, with a four-step guide, the SMS of each phone and the books. What exists:

- `Wallet.deposit` and its settle handler: the way sats that arrived on the gateway's node become a user's ecash.
- `apps/gateway/src/demo.ts`, `static.ts`, `boot.ts`. Routes `GET /sim/sms`, `GET /sim/people`, `GET /sim/state`, `POST /sim/fund`, and the pages, all in demo mode only.
- `apps/simulator`: the two pages and their words in three languages.
- The `app` service. A clean start took 126 s and stopping it took half a second, exit code 0.
- `e2e/demo.spec.ts`: 10 browser tests. `scripts/stills.mjs` for looking at the pages.

Gaps that are known and not closed. Do not describe any of these as done:

1. The demo routes have no rate limit. A hosted demo needs one first (phase 13).
2. A deposit whose payment to the mint fails for good is logged and not retried. The sats stay in `float:node`. Phase 8 must close this before real invoices arrive, and phase 6 must not make it worse: a cash-in that reaches this state has already settled the agent's payment.
3. The Lightning address on the screens is not payable until phase 8.
4. A payment to a number with no account is refused until phase 7.
5. Sessions and the per-user send queue live in the memory of one process. Phase 12.
6. A send that runs past the step budget and is then refused sends no SMS. Phase 12.
7. Nothing limits how many numbers one caller can look up on the send screen. Phase 9.
8. All Wolof, in the menus and on the pages, is unreviewed.
9. `static.ts` serves one folder. The voucher page (phase 7), the verify page (phase 10) and the console (phase 11) either become more pages of `apps/simulator` or get a second mount. Decide in phase 7 and write it down.
10. The pages were opened in Chromium only.
11. GitHub warns that `actions/checkout@v4` and `actions/setup-node@v4` were written for Node 20. The workflow was not touched in phase 5. The browser tests and the integration tests do not run in CI yet (phase 12).

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

## 5. Code map

| Path | What it is | Main exports | Tests |
|---|---|---|---|
| `packages/core` | Errors, ids, clock, phone numbers, FCFA and sats, log redaction | `AppError`, `newId`, `FakeClock`, `normalizePhone`, `maskPhone`, `fcfaToSats`, `createLogger`, `redact` | `core.test.ts` |
| `packages/crypto` | Wrappers over node:crypto | `hashPin`, `verifyPin`, `isWeakPin`, `seal`, `open`, `deriveUserKey`, `deriveKey`, `phoneLookupKey`, `newVoucherCode`, `normalizeVoucherCode`, `voucherKey`, `randomAlias` | `crypto.test.ts` |
| `packages/ledger` | Database handle, migrations, the journal | `createPgDb`, `createMemoryDb`, `migrate`, `truncateAll`, `post`, `balance`, `allBalances`, `verifyLedger` | `ledger.test.ts` |
| `packages/lightning` | One interface, two adapters, invoice checks | `LightningBackend`, `LndBackend`, `NwcBackend`, `decodeInvoice`, `checkInvoice`, `feeCapSat` | `invoice.test.ts`, `contract.ts` run by `lnd.itest.ts` and `nwc.itest.ts` |
| `packages/cashu` | Mint client: plan, run, recover | `MintClient` (`planSwap`, `runSwap`, `recoverSwap`, `mintQuote`, `planMint`, `runMint`, `recoverMint`, `meltQuote`, `planMelt`, `runMelt`, `checkMelt`, `states`, `encodeToken`, `decodeToken`, `verifyOffline`) | `mint.itest.ts` |
| `packages/vault` | Sealed proofs plus ledger plus recovery | `Vault` (`mintFor`, `transfer`, `exportToken`, `importToken`, `melt`, `writeOffSpent`, `findOp`, `resume`, `recover`, `audit`, `auditAll`, `liveProofs`, `verifyHoldingsWithMint`, `onSettled`), `vaultMigrations`, `FLOAT_NODE` | `vault.itest.ts` |
| `packages/limits` | Spend tiers, PIN lockout, delays | `TIERS`, `tierFor`, `checkSpend`, `onPinFailure`, `onPinSuccess`, `isPinLocked`, `withdrawalDelayMs` | `limits.test.ts` |
| `packages/sms` | GSM-7, inbound commands, phone-gateway adapters | `assertGsm7`, `toGsm7`, `smsSegments`, `parseCommand`, `AndroidSmsGateway`, `HttpSms`, `MemorySms`, `parseAsgWebhook`, `parseHttpSmsWebhook` | `sms.test.ts` |
| `packages/ussd` | Menu SDK | `con`, `end`, `menu`, `Machine`, `UssdRuntime`, `MemorySessions`, `africasTalking`, `genericHttp`, `simulator` | `ussd.test.ts` |
| `packages/i18n` | Wording | `t`, `clip`, `messages`, `LANGS`, `methodName`, `WOLOF_REVIEWED` | `i18n.test.ts` |
| `packages/nostr`, `packages/fiat-rails` | Empty. Phases 10 and 15 | | |
| `apps/gateway/src/config.ts` | The environment, checked once | `loadConfig`, `Config` | `config.test.ts` |
| `apps/gateway/src/schema.ts` | Tables: `users`, `txlog`, `sms_outbox`, `price_cache`, `audit_log`, `flags`, sequence `receipt_no` | `gatewayMigrations` | every gateway test |
| `apps/gateway/src/rules.ts` | What a first name and an address name may look like | `NAME_RE`, `ALIAS_RE`, `isReservedAlias` | `users.test.ts`, `machine.test.ts` |
| `apps/gateway/src/users.ts` | Accounts and the secret code | `Users` (`register`, `findByPhone`, `byId`, `phoneOf`, `addressOf`, `checkPin`, `changePin`, `setLang`, `setAlias`) | `users.test.ts` |
| `apps/gateway/src/rates.ts` | FCFA per bitcoin, cached | `Rates.get`, `RATE_URL` | `rates.test.ts` |
| `apps/gateway/src/smsout.ts` | SMS outbox, sealed, retried | `SmsOutbox` (`queue`, `flush`, `list`) | `smsout.test.ts` |
| `apps/gateway/src/smsin.ts` | Inbound SMS commands | `SmsInbound.handle` | `http.test.ts` |
| `apps/gateway/src/settle.ts` | Routes the vault's settle hook by flow | `SettleRouter` (`on`, `dispatch`) | `wallet.itest.ts` |
| `apps/gateway/src/wallet.ts` | Balance, resolve, quote, send, deposit, history, limits. Writes history and receipts when a send or a deposit settles | `Wallet` | `wallet.itest.ts`, `perform.test.ts`, `demo.test.ts`, `demo.itest.ts` |
| `apps/gateway/src/ussd/machine.ts` | The menus as a pure machine | `createWalletMachine`, `runtimeTexts`, `PIN_STEPS`, types `S`, `Effect`, `Res` | `machine.test.ts`, `test/golden/` |
| `apps/gateway/src/ussd/perform.ts` | Runs effects by calling the services | `createPerform` | `perform.test.ts`, `wallet.itest.ts` |
| `apps/gateway/src/http.ts` | Fastify routes | `buildHttp` | `http.test.ts`, `wallet.itest.ts` |
| `apps/gateway/src/app.ts` | Wires everything from injected parts | `buildApp`, `App` | all, through `test/helpers.ts` |
| `apps/gateway/src/boot.ts` | Connects everything and returns an `App`. Opens no port | `boot` | every start of the `app` service |
| `apps/gateway/src/main.ts` | The server: boot, recover, seed if asked, listen, timers, clean stop | | `docker compose up`, `docker compose stop app` (timed in the build log) |
| `apps/gateway/src/demo.ts` | Demo mode only: `/sim/*` routes, the top-up, the seed | `mountDemo`, `fundAccount`, `seedDemo`, `regtestWorld`, `DEMO_PEOPLE`, `DEMO_PIN`, `FUND_CAP_FCFA` | `demo.test.ts`, `demo.itest.ts` |
| `apps/gateway/src/static.ts` | The built pages, served from memory | `loadStatic`, `mountStatic` | `demo.test.ts` |
| `apps/simulator` | Landing page (`index.html`) and simulator (`demo.html`). `src/copy.ts` words, `src/lang.ts` language switch, `src/api.ts` the five calls, `src/phone.ts` one phone, `src/demo.ts` the guide, the inboxes and the books, `src/landing.ts`, four CSS files | built into `dist/` by `npm run build:web` | `test/copy.test.ts`, `e2e/demo.spec.ts` |
| `e2e/`, `playwright.config.ts` | Browser tests against the running stack | | `npm run test:e2e` |
| `infra/` | `compose.yml` (gateway side), `compose.mint.yml` (mint side), `compose.regtest.yml` (test chain), `regtest-init/init.ts` | | `scripts/smoke.ts` |
| `scripts/` | `smoke.ts`, `dev-creds.sh`, `build-web.mjs`, `mutate.mjs`, `demo-seed.ts`, `stills.mjs`, `probe/` (`balances.ts` shows what each node can send) | | |
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
`AT_ALLOW_IPS`, `USSD_HTTP_SECRET`, `SMS_ADAPTER` with its keys, `ASG_SIGNING_KEY`, `HTTPSMS_SIGNING_KEY`.
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

**Phase 6, agents.** Now section 3.

**Phase 7, vouchers and merchants.** Voucher = `vault.transfer` to `voucher:<id>` with a P2PK lock to the key derived from the code (`voucherKey`), locktime 30 days, refund key per voucher. Redeem by USSD, by SMS `BON <code>`, and on `apps/voucher-web` where the browser derives the key and swaps at the mint. Sweepers for refunds and for vouchers redeemed elsewhere (`writeOffSpent`). Sending to a number that has no account becomes an SMS voucher. Merchant code, poster with QR and dial string, receipts to both sides, evening summary. Offline acceptance capped at 2,000 FCFA.

**Phase 8, Lightning address and pay codes.** `apps/lnurl`: `/.well-known/lnurlp/<alias>`, description-hash invoices on the gateway node, settle listener that credits through `vault.mintFor`. Pay codes (6 digits, 10 minutes) so a USSD user can pay any invoice. Resolver for outgoing addresses that refuses private ranges and redirects. Moving to a smartphone: sweep to an address, or a voucher for the full balance. Rule 12 is decided here.

**Phase 9, scam shield and recovery.** Guardians (2 of 3), PIN reset with a 24 hour freeze, withdrawal delay with cancel by SMS, reports checked before each send, the `ARNAQUE` checker (rules first, a small language model second, works with the model off), kill switch.

**Phase 10, public proof.** `packages/nostr`: NIP-69 offers with `f=XOF`, signed trade receipts, NIP-56 reports, NIP-98 login. Hourly reserve snapshots from the gateway and from a mint-side auditor, signed, published, anchored with OpenTimestamps. `apps/verify` recomputes everything in the visitor's browser. Circuit breaker pauses spending if liabilities pass reserves.

**Phase 11, operator console.** Users (masked), agents and bonds, live escrows, disputes, limits, liquidity, reserve history, flags, kill switch, audit log. Roles: operator, arbiter, read-only auditor.

**Phase 12, hardening.** Playwright suite through the simulator for every flow. Chaos tests: dropped sessions, lost Lightning replies, mint down. Every row of the threat model has a passing test. A test proves no personal data reaches the logs. A reviewer with no build context audits the money paths; findings land with tests. CI runs the integration job.

**Phase 13, delivery.** Hosted demo (Caddy, backups, runbook), README with the architecture diagram, constraints, metrics and next iteration, the 3 minute pitch script, Devpost text, logo.

**Phase 14, voice.** Asterisk container, ARI app, keypad flows for amounts and PIN, recorded prompts, browser softphone. Wolof and French speech recognition for menu words only, with an accuracy report on recorded phrases.

**Phase 15, fiat rails and Mutinynet.** Bitnob, PayDunya and Wave adapters against recorded fixtures, off by default. A public test network profile.

## 8. What only the owner can supply

- A server (2 vCPU, 4 GB) and a domain for the hosted demo.
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
