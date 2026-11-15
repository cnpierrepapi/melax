# Architecture

What each part is, why it is there, and how a sat moves through real functions. Updated at the end of every phase.
This describes what exists after phase 5. Parts that are only planned are in `docs/PLAN.md`.

## The shape

```
 feature phone --USSD--> aggregator ---+
 feature phone --SMS---> phone gateway +--> gateway (apps/gateway) --> ledger + vault (Postgres)
 web simulator (/demo) ----------------+             |
                                                     +--> mint client --> Nutshell mint --> its own LND node
 someone's Lightning wallet <--> gateway's LND node <-+
```

Two trust domains, two sets of keys:

- The gateway side (`infra/compose.yml`) knows phone numbers and holds each user's ecash, sealed.
- The mint side (`infra/compose.mint.yml`) sees blinded tokens only. It cannot link a payer to a payee.

On regtest a third file (`infra/compose.regtest.yml`) adds the test chain and a node that plays everybody else.

## Modules and the contract each holds

| Module | Contract | Depends on |
|---|---|---|
| `packages/core` | No I/O. Errors with stable codes, sortable ids, an injectable clock, E.164 phone numbers, whole-sat and whole-franc maths, and the only logger, which redacts | nothing |
| `packages/crypto` | Thin wrappers over node:crypto. Argon2id for PINs, AES-256-GCM sealing with a purpose tag, HMAC phone lookups, one key per purpose from the pepper, voucher codes with a proven check character | core |
| `packages/ledger` | `Db` (plain SQL, transactions, the same on Postgres and PGlite), append-only migrations, and `post()`: balanced entries, idempotent, hash chained, nothing internal below zero | core |
| `packages/lightning` | `LightningBackend`: invoices, hold invoices, pay, lookups. `pay` never throws for a payment that may have left | core |
| `packages/cashu` | `MintClient`: every mint operation as plan (pure) then run, with a recover call for each | core, crypto |
| `packages/vault` | `Vault`: the only code that moves ecash. Keeps ledger and sealed proofs equal per owner, records every operation before the network call, recovers after a crash | ledger, cashu, lightning, crypto |
| `packages/limits` | Pure rules: tiers, spend checks, PIN lockout schedule, withdrawal delay | core |
| `packages/sms` | GSM-7 checks, inbound command parser, phone-gateway adapters, webhook verification | core |
| `packages/ussd` | Screens that cannot exceed 160 GSM-7 characters, pure menu machines, the session runtime, aggregator adapters | core, sms |
| `packages/i18n` | Every user-facing string in three languages | core, sms |
| `apps/gateway` | The service a phone talks to. Its parts are below | all of the above |
| `apps/simulator` | The landing page and the web phone simulator. Browser code: plain TypeScript and CSS, built by Vite into `dist/`, served by the gateway in demo mode. Talks to the gateway over five HTTP calls and holds no logic of the wallet | nothing at run time. `src/copy.ts` is checked against `packages/i18n` by a test |

Inside `apps/gateway/src`:

| File | Contract |
|---|---|
| `config.ts` | The environment, read once. Secrets come from there only and never appear in an error |
| `schema.ts` | The gateway's tables. Append-only migrations |
| `users.ts` | Who a number is. The one place a secret code is compared, counted and locked |
| `rates.ts` | FCFA per bitcoin: a live source, the euro peg as fallback, a cache, and no invented value |
| `wallet.ts` | Balance, recipient lookup, quote, send, deposit, history, limits. Moves money through the vault only. A deposit is credited only for an invoice the gateway's own node reports as settled |
| `settle.ts` | Owns the vault's single settle hook and routes it to the flow that started the operation |
| `smsout.ts` | SMS queued inside the transaction they report, sealed at rest, sent by a timer, retried |
| `smsin.ts` | Inbound SMS commands. None moves money. Strangers get no reply |
| `ussd/machine.ts` | The menus as a pure machine: state in, screen or effect out |
| `ussd/perform.ts` | Runs each effect by calling a service. The caller is always the session's own number |
| `http.ts` | The routes aggregators and phone gateways call. Each one mounts only when its secret is set |
| `app.ts` | Builds all of the above from injected parts, so tests can swap the database, clock, SMS adapter and log |
| `boot.ts` | Connects the database, the mint, the Lightning node, the SMS adapter and, in a regtest demo, the node that pays top-ups. Opens no port, so a script can use it |
| `main.ts` | The server: boot, finish what a previous run left open (vault operations, then trades), seed the demo if asked, listen, start three timers, stop cleanly on a signal |
| `demo.ts` | Demo mode only: what the simulator reads, the top-up, the seed, the two seeded agents, the arbiter's demo button `/sim/decide`. Shows first names, never an id, a number or ecash |
| `escrow/trade.ts` | The trade state machine, pure: kind, state and event in, the next state or a refusal out. Who may cause each event |
| `escrow/agents.ts` | Agents: enrol, the offer, the sealed mobile-money number, the agent's wallet (a `LightningBackend`), the bond's balance and what leans on it. Prices with the premium |
| `escrow/engine.ts` | `Escrow`: starts both kinds of trade, the people's moves (confirm, decline, mark sent, dispute, cancel), the arbiter's `decide`, bonds, and `sweep`/`step`, which move trades on the clock and on the node's word. Every move is a state-checked `UPDATE`. History and SMS come from its settle handlers |
| `static.ts` | The built pages, read once into memory. No request path reaches the disk |

## The data that flows

- `PlainProof` (`packages/cashu/src/index.ts`): one ecash note as plain JSON: keyset id, amount in sats, secret, signature `C`, optional DLEQ proof and witness.
- `SwapPlan`, `MintPlan`, `MeltPlan`: the inputs and the exact outputs (secrets and blinding factors) of one mint operation. Plain JSON, sealed and stored before the network call.
- `ops` row (`packages/vault/src/index.ts`, migration `vault/001-init`): one operation: kind, idempotency key, owner, stage, status, amount, public data, sealed plan. `data.meta.t` names the flow that started it.
- Journal entry (`packages/ledger/src/ledger.ts`): kind, idempotency key, postings that sum to zero, hash of the previous entry.
- `users` row (`apps/gateway/src/schema.ts`): id, the number as an HMAC and as a sealed copy, a masked form for screens, first name, address name, language, role, the code's Argon2id hash, the wrong-try counter and lock time, the freeze time.
- `txlog` row: one side of a movement as the user reads it: signed sats and francs, the other party's first name, the receipt number, the vault operation it came from, and whether it counts toward the limits.
- `sms_outbox` row: the number and the text, both sealed, with a status and a retry time.
- `agents` row (migration `gateway/002-agents`): the user id, the mobile-money number sealed (purpose `agent:momo:<id>`) and masked, the method, the premium in basis points, the range in francs, on or off, and the wallet: `world` (the demo node) or `nwc` with its connection string sealed (`agent:wallet:<id>`).
- `trades` row (same migration): kind, state, reference, idempotency key, the user and the agent, francs, sats, sats locked, the rate, the method; for a cash-in the payment hash, the preimage sealed (`trade:preimage:<id>`), the invoice and its expiry; the times `held_at`, `deadline_at`, `hard_cap_at`; the retry counter `attempt`; `watch` for a closed cash-in whose invoice is still watched; the winner of a decided dispute. A partial unique index allows one open trade per user.
- Vault owners added by this phase: `escrow:<tradeId>` (a cash-out's locked sats) and `bond:<agentUserId>`.
- Menu state `S` (`ussd/machine.ts`): `{ at, lang, profile, v, q }`. `at` is the step, `v` what was typed so far, `q` the inputs still queued from a dial string.
- `Effect` and `Res`: what the machine asks for (`profile`, `register`, `balance`, `resolve`, `quote`, `send`, `receiveInfo`, `receiveSms`, `history`, `pinChange`, `setLang`, `address`, `setAlias`, `limits`, and for agents `trade`, `offers`, `cashin`, `cashout`, `tradeConfirm`, `dispute`, `tradeCancel`, `desk`, `deskNext`, `deskAct`, `bond`, `bondAdd`, `bondOut`, `offer`, `offerToggle`) and the one shape every answer has: `{ ok: true, ... }` or `{ ok: false, err, ... }`.

## Walkthrough 1: sats arrive and become a user's ecash

1. A payment settles on the gateway's node. `Wallet.deposit({ userId, paymentHash })` asks that node with `lookupInvoice()`. Only a settled invoice goes further, and the amount is the one the node reports. It posts `ext:lightning -> float:node` with `post()` under the key `recv:<hash>`. (Today the demo's top-up calls this. Phase 8 calls it from the invoice listener.)
2. `Vault.mintFor()` asks the mint for a quote (`MintClient.mintQuote`), checks the invoice amount with `decodeInvoice`, and builds the outputs (`MintClient.planMint`).
3. In one transaction it posts `float:node -> float:minting` and inserts the `ops` row with the sealed plan (`insertOp`).
4. `driveMint()` checks `ln.lookupPayment(hash)` first, so a payment is never sent twice, then `ln.pay()`.
5. `MintClient.recoverMint()` reports `not_run`, `runMint()` gets the signatures, `finish()` unblinds them and verifies each DLEQ proof.
6. In one transaction: `addProofs()` seals each proof under the owner's key, `post()` moves `float:minting -> user:<id>:spendable`, the op is marked done, and the `onSettled` hook runs. For a deposit the hook is `Wallet.onDepositSettled()`: one `txlog` row of kind `deposit` and the SMS `sms.ln_received`.

If the process dies after step 4, `Vault.recover()` calls `driveMint()` again: the node says the payment succeeded, the mint says the quote is issued, and `recoverMint()` rebuilds the same proofs from the stored plan through the mint's restore endpoint.

## Walkthrough 2: one user sends to another (inside the vault)

1. `Vault.transfer()` calls `startSwap()`. `ensureOwners()` commits a salt for both owners.
2. In one transaction: `lockOwner()` takes the sender's row lock, `assertFree()` refuses if another outgoing operation is pending, `select()` picks live proofs, `MintClient.planSwap()` builds outputs for the receiver and the change, `post()` moves the amount from `spendable` to `locked`, the picked proofs become `reserved`, and the op is stored with the sealed plan.
3. `driveSwap()` calls `MintClient.runSwap()`.
4. `settleSwap()` in one transaction: inputs become `spent`, the receiver's proofs are sealed under the receiver's key, the change under the sender's, `post()` moves `sender:locked -> receiver:spendable`, the hook runs.
5. If the mint refused, `failSwap()` puts the proofs back to `live` and posts `locked -> spendable`.
6. If there was no answer, the op stays `pending`. `resume()` calls `MintClient.recoverSwap()`: inputs unspent means it never ran, so release; inputs spent means it ran, so restore the outputs and settle.

A voucher is the same call with a `lock` (NUT-11 P2PK) and an owner named `voucher:<id>`. Redeeming is a transfer out of that owner with the `privkey` derived from the code.

## Walkthrough 3: a user pays a Lightning invoice

1. `Vault.melt()` decodes the invoice, asks `MintClient.meltQuote()`, and refuses if the fee reserve is above `feeCapSat()`.
2. In one transaction it reserves amount plus fee reserve, picks proofs, and stores a split plan.
3. `driveMelt()` stage `split`: swap into proofs worth exactly amount plus reserve (`runSwap`, or `recoverSwap` after a crash). The exact proofs are stored as `reserved`.
4. Stage `melting`: `checkMelt()` first, then `runMelt()` only while the mint says unpaid.
5. Paid: exact proofs become `spent`, change proofs are sealed for the owner, `post()` moves `locked -> ext:lightning` for amount plus the fee actually paid and returns the rest to `spendable`.
6. Unpaid: `failMelt()` makes the exact proofs live again and releases the ledger lock. Pending or no answer: nothing changes until the next `resume()`.

## Walkthrough 4: from a keypad to two SMS

Awa dials `#2580#`, picks Envoyer, types Moussa's number and 500, confirms, types her code.

1. The aggregator posts to `/ussd/at/<secret>` (`http.ts`). The secret is compared in constant time and the caller's address is checked against the allow-list. `africasTalking()` turns the cumulative text into one input and calls `UssdRuntime.handle()`.
2. The runtime starts the machine at `boot`, which emits the effect `profile`. `createPerform()` looks the number up with `Users.findByPhone()` (an HMAC of the number) and answers with her language. The machine goes to `home` and the runtime returns the menu.
3. "2" leads to `send.to`. The number she types is sent as the effect `resolve`: `Wallet.resolve()` finds Moussa and returns his user id, first name and masked number. The id is what the session keeps. His number is not stored in it.
4. "500" becomes the effect `quote`: `Wallet.quote()` runs `checkSpend()` against what she sent today and this month (`txlog` rows marked `spend`), converts with `Rates.get()` and checks her balance. The confirm screen shows 500 F, the sats, Moussa's name.
5. "1" leads to `send.pin`. If a dial string had queued more inputs, `drain()` drops them here.
6. Her code becomes the effect `send`. `Wallet.send()`:
   - `Users.checkPin(id, pin, "spend")` takes the row lock, refuses if locked, verifies the Argon2id hash, counts a wrong try, and refuses a frozen account;
   - `serial()` makes this the only send of hers in progress;
   - `vault.findOp("ussd:<sessionId>:send")` returns an earlier outcome if this session already sent;
   - the limits are checked again, because another session may have spent since the quote;
   - `vault.transfer()` runs walkthrough 2, with `meta: { t: "send", sender, recipient, fcfa, rate }`.
7. When the vault settles, `SettleRouter.dispatch()` calls `Wallet.onSendSettled()` inside the settle transaction: one receipt number from the sequence, two `txlog` rows, and two SMS through `SmsOutbox.queue()`, each in its reader's language.
8. `Wallet.outcome()` reads the receipt number back and the machine closes with "Envoye: 500 F a Moussa. Recu no 1001".
9. A timer in `main.ts` calls `SmsOutbox.flush()`, which opens each sealed row and hands it to the adapter.

If the mint does not answer in step 6, `vault.transfer()` returns `pending`, the screen says an SMS will follow,
and the money stays locked. The other timer calls `Vault.recover()`. When it finds out what happened, step 7 runs
then: either the two receipts, or one SMS to Awa saying the payment did not go through.

## Walkthrough 5: a visitor on the demo page

Someone opens `http://localhost:8787/demo` on a phone.

1. `static.ts` answers `/demo` from its map with `demo.html`, already holding its English sentences (written in at build time by the `melax-fill-copy` step in `apps/simulator/vite.config.ts`). `src/demo.ts` in the browser calls `GET /sim/people` and draws two phones with `createPhone()` (`src/phone.ts`).
2. The visitor's phone gets a random Senegalese mobile number, kept in the browser's storage. The second phone is Moussa, one of the six seeded people.
3. The green key posts `{ sessionId, phone, dial: "#2580#" }` to `/ussd/sim`. From there it is walkthrough 4: the same runtime, machine and services a real aggregator would reach. The phone shows the text that comes back and nothing else.
4. Every 1.5 seconds the page reads `GET /sim/sms` for both numbers and `GET /sim/state`. `progress()` in `src/demo.ts` works out the step from the SMS kinds: `welcome` means the account exists, `deposit` means money arrived, `sent` means the payment went through, `received` on the other number means it landed.
5. "Add 5 000 F" posts to `/sim/fund`. `fundAccount()` in `apps/gateway/src/demo.ts` makes an invoice on the gateway's node, has the world node pay it, and calls `Wallet.deposit()`: walkthrough 1 from the top.
6. `/sim/state` reads the last 20 journal entries and their postings, swaps each user id for a first name with `publicAccount()`, adds the totals from `Vault.auditAll()` and returns them. The page draws them as "what just happened".

When the stack starts with `DEMO_SEED=1` on an empty database, `seedDemo()` runs steps 5 and walkthrough 4's send
for six people before the port opens, so the first visitor already has someone to pay.

## Walkthrough 6: a cash-in through an agent

Awa presses 5 and types 2000.

1. The `offers` effect calls `Escrow.offers("cashin", awa, 2000)`. It walks `Agents.active()`, skips Awa herself and anyone whose range does not fit, prices each with `cashinSats()` (the francs' worth less the premium) and drops anyone whose `bondedSats()` plus these sats would pass `bondSats()`. Three at most go on the screen.
2. Awa picks Ndeye and confirms. No code: nothing of hers moves. `Escrow.startCashin()` checks the sats on the screen against the rate again (rule 53), draws a random preimage, and in one transaction locks Ndeye's `agents` row, checks Awa has no open trade and the bond still covers it, and inserts the trade as `open` with the preimage sealed.
3. Then the network: `LndBackend.makeHoldInvoice()` on the gateway's node with `cltvExpiry` from `ESCROW_CLTV_BLOCKS`, and `Agents.wallet(ndeye).pay()`, not awaited: a held payment only returns when it is settled or cancelled.
4. `step()` asks `lookupInvoice()`. Once the node says `accepted`, `openStep()` moves the trade to `held` and queues two SMS in the same transaction: Ndeye's mobile-money number for Awa (`sms.dep_user`), Awa's masked number for Ndeye (`sms.dep_agent`). The start waits up to 6 s for this, so Awa's screen can already say where to send the francs.
5. Ndeye presses 0, 4, 1, sees the trade (`Escrow.nextFor()`), presses 1 and types her code. `Escrow.agentConfirm()` checks it is her trade, checks her code with `Users.checkPin()`, then moves `held` to `settling`.
6. `creditStep()` calls `settleHeld()`, the one place the preimage is opened, and `LightningBackend.settle()`. Then it is a deposit (rule 55): the node says settled, `post()` books `recv:<hash>`, and `Vault.mintFor()` turns the sats into Awa's ecash under `cashin:<id>:credit`.
7. The vault's settle hook reaches `onCredited()` through `SettleRouter`. In the transaction that adds Awa's proofs it moves the trade to `done`, writes a history row for each side under one receipt number, and queues `sms.dep_done` and `sms.dep_agent_done`.

If Ndeye never confirms, `heldStep()` moves the trade to `expired` once 45 minutes have passed and cancels the
invoice; her sats go back. If Awa disputes, `disputedStep()` lets go of the payment at the 3 hour cap (`released`),
and a decision for Awa after that runs `slashStep()`: `Vault.transfer()` from `bond:<ndeye>` to Awa.

## Walkthrough 7: a cash-out through an agent

1. Awa presses 6, types 2000, picks Ndeye, confirms and types her code. `Escrow.startCashout()` checks the code, then inside `Wallet.serial()` (the same queue as her sends) the limits with `Wallet.limitCheck()` and the balance, and inserts the trade as `locking`. The sats locked are the sats plus `feeCapSat()` of them.
2. `lockStep()` calls `Vault.transfer()` from `user:<awa>` to `escrow:<tradeId>` under `cashout:<id>:lock`. `onLocked()` moves the trade to `locked`, writes Awa's history row with `spend` set (it counts toward her limits from now), and texts Ndeye Awa's number.
3. Ndeye sends the francs, then marks it sent with her code: `Escrow.agentSent()`. Awa gets `sms.wd_user_sent`.
4. Awa presses 6, sees the trade, presses 1 and types her code: `Escrow.userConfirm()` moves it to `paying`.
5. `payStep()` asks Ndeye's wallet for an invoice of exactly the trade's sats, checks the amount, and calls `Vault.melt()` from `escrow:<tradeId>` under `cashout:<id>:pay:<n>`. `onPaid()` moves the trade to `returning`. A failed melt leaves everything in the box and the next try uses `n + 1` and a fresh invoice.
6. `changeStep()` moves whatever the fee did not use back to Awa (`cashout:<id>:change`) and `onChangeBack()` closes the trade with her SMS.

With no "sent" for 45 minutes, or a decline, `refundStep()` moves the whole box back and `onRefunded()` writes a
history row that gives the limit room back. With "sent" and then 45 minutes of silence from Awa, the trade becomes
a dispute and waits for `Escrow.decide()`.

## Why it is built this way

The short version is in `docs/DECISIONS.md`, the plain-words version in `docs/LITEPAPER.md`. The choices that shape everything else:

- Ecash instead of balances in a table (decision 23 and litepaper choice 2): the party that can issue money knows no one, the party that knows people cannot issue.
- Plan, store, then run (decision 14): the only safe answer to a lost reply is to ask what happened.
- Real mint and real nodes in tests (decision 13): the bugs worth finding live in the gap between a stand-in and the real thing.
- Menus as a pure machine with effects on the side (decision 24): every path can be replayed as text, and the place where a code may exist is small enough to check.
- Receipts written in the same transaction as the money (decision 27): there is no moment where one exists without the other.
