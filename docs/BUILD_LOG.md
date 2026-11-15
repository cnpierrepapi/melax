# Build log

What got built, in order, and what broke on the way. Every bug is here with its fix, including the dumb ones.
Numbers in this file come from runs on the build machine (Windows 11, Docker Desktop with 3.1 GB of RAM and 2 CPUs).

## 14 Nov 2026

### The name

Melax is Wolof for lightning. Checked against the Wolof New Testament, Matthew 24:27: "ni melax di tàkke penku".
The plan was drafted under the working name Jokko. Jokkolabs is already a well known hub in Dakar, so that name was dropped.
A second idea, Weccit (small change), was dropped too: Wecci Ma is a live money app in Senegal.

### Foundations

- `packages/core`: errors, ids, a clock you can fake in tests, phone numbers, FCFA and sats maths, and the log redactor. 12 tests.
- `packages/crypto`: PIN hashing, sealing, phone lookups, voucher codes. 17 tests.
- `packages/ledger`: the journal. 13 tests, one of them a random-operations run.

Node 24 runs the TypeScript files as they are. There is no compile step for the server.

### Regtest network

`docker compose up` starts bitcoind, three LND nodes (world, gateway, mint), the Nutshell mint, Postgres and a Nostr relay.
A helper funds the nodes and opens two channels: world to gateway, gateway to mint, with half of each channel pushed to the far side.
From an empty machine with images already pulled, the channels were active 1 min 44 s after start.

### Lightning backends

One interface, two adapters: LND over REST and Nostr Wallet Connect.
The same 10-test contract suite passes on both: LND on regtest, and two throwaway wallets on faucet.nwc.dev.
It covers plain pay, description-hash invoices, paying twice, hold then settle, hold then cancel, a wrong preimage, cancel after settle, cancel before payment, and unknown hashes.

### Ecash client and vault

`packages/cashu` splits every mint operation in two: plan it (pure, stored first), then run it. After a lost reply it asks the mint what happened and rebuilds the same proofs from the stored plan.
`packages/vault` keeps the ledger and the sealed proofs in step for deposits, transfers, vouchers, token export and import, and Lightning pay-outs.

Tested against the real Nutshell mint and LND nodes on regtest, with faults injected only at the network edge of the test process:

- ecash client: 15 tests (lost replies, mint down, locked ecash, refund after locktime, failed payments).
- vault: 21 tests (crash mid-swap then recovery on a fresh process, BUSY while an operation is unresolved, a payment held by the payee, a voucher redeemed from another wallet).
- 1,000 random sends between five accounts: ledger equals proofs held for every account, total unchanged, the mint confirms every proof we hold is unspent. 671 s.
- Ledger alone, 10,000 random operation sequences (`PROPERTY_RUNS=10000`): balances sum to zero, nothing internal goes negative, the chain verifies. 152 s.

### Limits, SMS, USSD, wording

- `packages/limits`: tiers, spend checks, PIN lockout, withdrawal delay. 10 tests.
- `packages/sms`: GSM-7 checks, inbound commands, two phone-gateway adapters. 15 tests.
- `packages/ussd`: the menu SDK and its runtime. 18 tests.
- `packages/i18n`: every screen and SMS in French, Wolof and English. 9 tests. The Wolof has not been read by a native speaker yet.

## 15 Nov 2026

### Phases, handover plan, litepaper

The owner asked for the build to run in numbered phases with a stop after each, for the plan to be kept current so someone else can pick the work up, and for a litepaper that explains the trade-offs.

- `docs/PLAN.md` rewritten: phase board, the next phase in detail, 39 rules that keep later work from breaking earlier work, a code map, and the first plan's design as an appendix.
- `docs/LITEPAPER.md`, `docs/DECISIONS.md` and `docs/ARCHITECTURE.md` written.
- Measured the mint's fee reserve with `scripts/probe/fee-reserve-probe.ts`: 3 to 4 sats for 100 to 500,000 sats when the mint's node knows a route. With its channels down the mint falls back to 1 % and the vault's fee cap refuses pay-outs of 1,000 sats or more.

### Phase 4: the wallet over USSD

A person with any phone can now open an account, set a code, read a balance, send to another Melax number, see
how to receive, read their history and change their code, language or address name. It runs through the USSD
engine on regtest with real ecash.

What went in:

- `apps/gateway`: configuration, six tables, accounts and codes, the exchange rate, the wallet, the SMS outbox, inbound SMS, the menu machine, the effect runner, the HTTP routes and the boot file. About 3,900 lines with tests.
- The menus are one pure machine. I wrote its tests before the machine: French transcripts by hand, and 33 golden files for the same flows in three languages. They passed on the first run, so the only failure I watched was the missing module. To make up for that I broke the code on purpose afterwards (see below).
- A send checks the code, then the limits, then moves the ecash. The history rows, the receipt number and both SMS are written inside the transaction that settles the ecash.
- `docs/threat-model.md`, an ESLint config, and a GitHub Actions workflow for type check, lint and unit tests.

Numbers from this machine:

- 252 unit tests in 18 s. 71 integration tests in 182 s.
- The 15 wallet integration tests take 33 to 40 s. They pass on PGlite and on Postgres 17. The 143 gateway unit tests pass on both too, including ten wrong codes sent at the same moment.
- With the mint cut off, a send comes back as "in progress" within a few seconds: the whole test, sign-ups and deposit included, takes under 7 s. The Cashu library gives up its retries faster than I expected.
- The server was started by hand on the regtest stack with Postgres 17. It read 38,919,778 F per bitcoin from CoinGecko. The first balance took 652 ms because it fetched the rate. The sign-up took 71 ms, most of it the slow hash on the code. Every other screen took 1 to 8 ms.

Breaking it on purpose. `scripts/mutate.mjs` changes one guarded line, runs the tests that should notice, and
puts the line back. Nine lines: the dial-string queue reaching a code prompt, a session resuming at a code prompt,
a locked code still being compared, the Africa's Talking allow-list, history without the code, SMS replies without
a cap, sends of one user running side by side, a send without the code, and the limit checked only before the
code. All nine made a test fail.

Not done in this phase, and said so in `docs/status.md`: the clean shutdown has never run, money enters an account
only through a test helper, and the address on the screens is not payable yet.

## Defect log

| # | What happened | Cause | Fix |
|---|---|---|---|
| 1 | `npm install` refused to resolve | typescript-eslint 8.72 does not accept TypeScript 7 | Pinned TypeScript to 6.0.x |
| 2 | First voucher check character (ISO 7064 hybrid, mod 31,30) missed 60 of 26,100 neighbour swaps | That scheme only promises "nearly all" swaps. I measured it before using it | Switched to Damm's scheme over a 30-symbol quasigroup (order 3 times Damm's order-10 table). The test enumerates every case: zero misses |
| 3 | The image build failed at the web build step | The Dockerfile built front ends that did not exist yet | `scripts/build-web.mjs` builds whatever front ends exist and skips the rest |
| 4 | LND answered "illegal base64 data at input byte 40" on payment lookups | LND's REST gateway wants URL-safe base64 with padding in path parameters. Node's `base64url` drops the padding | Encode with the standard alphabet, swap `+` and `/`, keep the `=` |
| 5 | A scripted edit mangled a regex in `lnd.ts` | Shell quoting ate the backslashes | Fixed by hand. Multi-line edits go through the editor or a script file from now on |
| 6 | The "cancel refunds every sat" test read a balance 430 sats off | An LND channel balance moves while an HTLC is added or removed, because the commitment fee changes. A single read can land mid-update. Measured with `scripts/probe/lnd-cancel-probe.ts`: 2,481,700 before, 2,478,270 while held (3,000 + 430 of fee), 2,481,700 after the cancel | The test now reads until two consecutive reads agree. The refund is exact |
| 7 | A hold invoice from an aborted test run stayed locked on the gateway node | The test crashed between "paid" and "settle" | `scripts/probe/lnd-cancel-held.ts` cancels leftovers. The escrow engine gets the same sweep on boot |
| 8 | On the NWC sandbox, cancelling a hold invoice nobody has paid yet returns NOT_FOUND | That wallet can only cancel an invoice that is already holding a payment. Until it expires, the invoice can still be paid | `cancel()` now returns true or false. The escrow engine keeps watching a cancelled trade's invoice until it expires and refunds a late payment on sight. The contract test covers both behaviours |
| 9 | Injected "lost reply" faults did nothing: the calls still succeeded | The Cashu library retries network errors on the mint's cached endpoints by itself (NUT-19), up to 9 times, and the mint replays its cached answer | The fault now outlasts the retries, which is what a crashed process looks like. Also capped the library's request timeout at 15 s: its default is 5 minutes, too long for a phone session |
| 10 | Spending locked ecash with the right key was refused: "Input should be a valid string" | The signing helper leaves the witness as an object. The mint's API wants a JSON string | `wireProofs()` serialises the witness before a swap |
| 11 | Running the same mint request twice succeeded, where the test expected a refusal | Not a bug: the mint answers an identical request from its response cache. The test's expectation was wrong | The test now checks that the replay returns the very same proofs and that fresh outputs on the same quote are refused |
| 12 | Found while reading the vault before its first run: a sealing key could be cached for a salt that was later rolled back | The owner's salt was inserted inside the money transaction. A rollback would leave the cache holding a key nobody could derive again | Salts are now committed on their own before any money transaction starts. The cache only holds keys read from committed rows |
| 13 | Found in the same read: after a crash, a pay-out could be released while the mint was still about to pay it | The first draft kept an "asked" flag and treated "unpaid" after a restart as failed | The quote is the mint's own idempotency key. On resume the vault looks first and asks again only while the mint says unpaid and not in flight |
| 14 | The mint's rate limit would have throttled the gateway | Limits are per client address, and every user reaches the mint through one gateway | Raised for the pilot mint, with a note for operators in `infra/compose.mint.yml` |
| 15 | The regtest helper looked healthy before it had redone its checks | `/tmp/ready` survived a container restart | The helper deletes the marker when it starts |
| 16 | Two official sources disagree on the SMS gateway's webhook field for the sender | The project README says `phoneNumber`, its docs site says `sender` | The adapter reads both. Both shapes are fixtures in the test |
| 17 | After a night stopped, `docker compose up` never became ready. The Lightning nodes answered "RPC server is in the process of starting up" for minutes | LND treats a chain whose last block is hours old as not synced and will not finish starting. The helper that mines blocks was waiting for LND to be ready. Each waited for the other | The helper mines one block before it waits for the nodes and keeps one coming while they sync |
| 18 | With defect 17 fixed, the gateway to mint channel stayed inactive, and the mint asked a 1 % fee reserve on every quote | After the restart the nodes did not reconnect. The helper only connected peers when it opened a channel. With no route known, the mint falls back to its percentage reserve | The helper connects the peers by host name on every run. Ready one second after the nodes are up |
| 19 | Three scripted edits came out wrong: a `\n` inside a message became a real line break, a regex lost its backslashes, and a test string was split over three lines. A fourth one-liner failed to parse for the same reason | I wrote small Node scripts through a shell heredoc. The shell layer on this machine eats one level of backslashes before the file exists. Defect 5 was the same cause and I repeated it | Fixed each by hand. Rule 31 now says it without a loophole: edits go through the editor. A script that moves whole lines around and holds no backslash is still allowed |
| 20 | The "restart, then recover" tests left the send pending: "sealed data failed authentication" | The test helper drew a fresh random server secret for every app it built, so the restarted app could not open the plan the first one had sealed. Not a product bug, and the product did the right thing: it refused to guess | The test keeps one secret per test, as a real restart keeps its environment. Rule 40 |
| 21 | Two tests typed a menu choice and got the wrong screen | The session before had been left open on a prompt, so the next dial began with "Reprendre ou vous en etiez?" and the test's first key answered that. The product was right | The tests now read the offer and answer it. One of them became a check that the offer leads to the account menu and never to the code prompt |
| 22 | Found on reading, before any run: the balance printed on a receipt could be far off for small sends | The first draft worked the rate back out of the francs and sats of the send. At 39 million F per bitcoin, 1 F is 3 sats after rounding, which implies a rate 15 % away from the real one | The operation stores the real rate it was made at |
| 23 | Found while designing the resume rules: after walking back to a screen that is not worth resuming, the next dial offered the screen before it | The USSD runtime only stored a resume point when there was one. It never forgot the old one | `packages/ussd`: no resume point now clears the stored one. One new test |
| 24 | `npm run lint` had never worked | The script existed since the first day. The config file and the `@eslint/js` package did not | Added both. The first real run found one unused initial value in `lnd.ts` |
| 25 | A variable set to nothing (`RATE_FIXED_XOF_PER_BTC=`) stopped the server: "Too small" | The number parser read the empty string as zero. Compose files write empty variables all the time. Found by a test that wanted "no fixed rate" | Empty means not set. Rule 54 and a test |
| 26 | The server could not be stopped from the shell during the manual start | `kill -INT` from Git Bash does not deliver a signal to a native Node process on Windows. I ended it with `taskkill`. So the clean shutdown code has never run | Written down as open in `docs/status.md` and in the phase 5 brief, to be checked in Docker |
| 27 | `apps/gateway/package.json` pointed at `src/index.ts`, a file that never existed | Left over from the skeleton | Points at `src/app.ts` |
| 28 | A test asked for a server outside demo mode with the in-memory SMS adapter and was refused at start | The test was wrong. The rule that refused it is the one that keeps a real deployment from "sending" receipts into memory | The test names a real adapter |
