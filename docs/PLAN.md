# Melax: full build plan

Bitcoin for any phone in Senegal: USSD, SMS and voice on top of Lightning and Cashu ecash,
with agent cash-in/cash-out that never puts francs or the pot in the operator's hands.

Target: Dakar Bitcoin Hack 2026 (submissions close 20 Nov 2026, 20:00 UTC).
Scope rule: everything below gets built. Where a dependency is missing or gated, the plan
names the replacement that was designed around it.

---

## 1. Dependency audit (run 14 Nov 2026 from this machine)

Probe scripts live in `scripts/probe/` (`nwc-probe.mjs`, `cashu-probe.mjs`).

### 1.1 Tested live and working

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

### 1.2 Exists but not in the shape needed: designed around

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

### 1.3 Not yet run (first tasks of the build)

- bitcoind regtest + 2 LND + Nutshell on `LndRestWallet` end to end (images confirmed: `btcpayserver/bitcoin:32.1`, `lightninglabs/lnd:v0.21.8-beta`).
- Wolof ASR accuracy on spoken menu words (measure on 50 recorded phrases before trusting it).
- A real SMS round trip through an Android phone.

### 1.4 Needs you (accounts and hardware)

An Anthropic API key (optional, only for the scam checker), a VPS (2 vCPU / 4 GB) and a domain, an Android phone with a SIM for the SMS gateway,
optional sandbox accounts (Africa's Talking, Bitnob, PayDunya, Wave Business), a Hugging Face token if
Kiriku is wanted. 

---

## 2. What gets built

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

---

## 3. Architecture

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

Stack: Node 24, TypeScript strict, Fastify, zod, Postgres 17, Drizzle, vitest, fast-check, Playwright.
Front ends (simulator, voucher page, console, verify page): Vite + vanilla TS, target under 30 KB gzip each.
Containers: bitcoind, lnd-mint, lnd-peer, nutshell, postgres, nostr-rs-relay, asterisk, asr (optional profile), app.

---

## 4. Component design

### 4.1 Ledger (the source of truth)
- Double-entry, append-only, hash-chained journal. Every money movement is one balanced transaction with an idempotency key.
- Accounts: user spendable, user locked, escrow, fees, mint float, agent bond.
- Invariant checked after every write and in property tests: sum of user balances = value of proofs in the vault.
- Outgoing payments use reserve -> attempt -> settle/release. A lost answer keeps funds reserved and is resolved by payment-hash lookup, never by retry.

### 4.2 Vault and custody
- User balance is a set of Cashu proofs, encrypted at rest with a per-user key = HKDF(server pepper from env/KMS, user salt). The PIN gates use; it is not the encryption key (a 4 to 6 digit PIN is brute-forceable, so claiming otherwise would be false).
- PIN: 5 digits, Argon2id + pepper, weak PINs refused, lockout 5 tries then 15 min -> 24 h.
- Phone numbers stored as HMAC for lookup plus an encrypted copy. No number, PIN, code or invoice in logs.

### 4.3 Lightning
- `LightningBackend`: `makeInvoice`, `makeHoldInvoice`, `settle`, `cancel`, `pay`, `lookup`, `subscribe`, `capabilities`.
- LND implementation over REST (invoicesrpc, routerrpc). NWC implementation over `@getalby/sdk`.
- Every invoice decoded and checked (amount, hash, expiry, network) before it is trusted or paid. Fee cap max(5 sat, 0.5%).

### 4.4 Mint
- Nutshell 0.22.1 on `LndRestWallet`, input fee 0 for the pilot keyset, `MINT_MAX_BALANCE`, per-mint and per-melt caps, rate limits on.
- Keysets rotate monthly; each closed keyset is one audit epoch.
- Gateway talks to it only over the public Cashu API, so any standard mint can be swapped in.

### 4.5 USSD engine (`@melax/ussd`)
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

### 4.6 SMS channel
- Outbound: receipts, incoming-payment notices, voucher delivery, escrow prompts, security alerts.
- Inbound commands: `SOLDE`, `BON <code>`, `AIDE`, `ARNAQUE <texte>`. Nothing that moves money out.
- Adapters: android-sms-gateway (webhook HMAC verified), httpSMS, console (tests).
- GSM-7 only, single segment where possible; the encoder rejects text that would silently switch to UCS-2.

### 4.7 Voice line
- Asterisk + ARI app. Flow: language pick -> PIN by keypad -> spoken menu.
- ASR only for menu intent (a closed list of about 20 words per language) with keypad fallback after one miss.
- Amounts, phone numbers and PIN are keypad only. Every action is read back and confirmed with `1`.
- Prompts: recorded files per language; TTS (Adia_TTS) only for names and amounts.

### 4.8 Vouchers
- Create (USSD 7 > 1): amount -> PIN -> gateway swaps user proofs into proofs P2PK-locked to the code-derived key, locktime 30 days, refund key = issuer.
- Code: 16 characters in 4 groups (`K7MP-2XQR-9TWB-4HNC`), alphabet without lookalikes, last character is a checksum.
- Locked token stored by gateway under `sha256(code)` and mirrored to Nostr as an encrypted-to-nobody blob (it is safe to publish).
- Redeem: USSD (7 > 2), SMS (`BON <code>`), or web page that unlocks in the browser and offers "add to my Melax", "pay a Lightning address", or "export standard Cashu token".
- Paper vouchers: agent prints a sheet (QR + code + USSD string). Unclaimed vouchers return to the issuer after the locktime.
- Offline acceptance for merchants: web app verifies DLEQ + lock offline against cached mint keys and queues the swap; capped at 2,000 FCFA per voucher because double-spend cannot be ruled out offline.

### 4.9 Agents: cash-in and cash-out
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

### 4.10 Nostr
- Agent offers: NIP-69 kind 38383 with `f=XOF`, `pm`, `premium`, `fa` range, geohash at commune precision.
- Trade receipts: signed by agent and gateway after settlement, no phone numbers, used for rating.
- Reserve snapshots and voucher blobs. Own relay in compose, optional publish to public relays behind a flag.
- Operator and agent login by Nostr key (NIP-98 HTTP auth); agent payouts and wallet linking via NWC.

### 4.11 Lightning address and LNURL
- `alias@domain` by default (random two-word alias). Phone-number addresses are opt-in, because a public address that is a phone number invites scams.
- LNURL-pay with description-hash invoices; payer comment delivered in the SMS receipt; amounts shown in FCFA.
- Pay codes: a smartphone payee turns an invoice or address into a 6-digit code valid 10 minutes, so a USSD user can pay any Lightning invoice.

### 4.12 Merchants
- Merchant code (5 digits), poster generator (QR for smartphones, `#2xxx*4*code#` for feature phones).
- SMS receipt to both sides with a receipt number; preimage kept as proof.
- Evening summary by SMS in the merchant's language; optional auto cash-out to a chosen agent.

### 4.13 Scam shield
- Recipient name shown before every send; first payment to a new recipient capped.
- Limits: per transaction, per day, per month; raised by account age and guardian setup.
- Large withdrawals wait 30 minutes with an SMS that lets the owner cancel.
- SIM-swap defence: a PIN reset needs 2 of 3 guardians (numbers chosen by the user) or an agent visit; reset freezes spending for 24 h.
- `ARNAQUE <texte>`: forwards a suspicious message; rules engine first, Claude second (`claude-haiku-5-5`, text only, no account data); reply is a one-line verdict in the user's language. Works with the model switched off.
- Reported numbers and addresses published as NIP-56 reports and checked before each send.

### 4.14 Reserves and verification
- Hourly snapshot: issued minus redeemed per keyset, Lightning balance (local + pending), ledger total, vault total.
- Signed, published to Nostr, anchored with OpenTimestamps (direct calendar HTTP calls; the npm client is stale).
- Verify page recomputes the hash chain and signature in the browser and shows one line: covered or not covered.
- Circuit breaker: if liabilities exceed reserves, spending pauses and the console alerts.

### 4.15 Operator console
Users (masked), agents and bonds, live escrows, disputes, limits, liquidity and channel health, reserve history,
feature flags, kill switch, audit log. Roles: operator, arbiter, read-only auditor.

### 4.16 AI use (kept narrow)
Scam-message verdicts, Wolof/French intent normalisation for the voice line, plain-language daily summaries for
merchants and the operator. The model never sees PINs, codes, full numbers or balances tied to a person, and has
no tools and no authority over money. Every feature has a rules-only fallback.

---

## 5. Security plan

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

---

## 6. Repository layout

```
melax/
  apps/        gateway/  lnurl/  escrow/  voice/  console/  simulator/  voucher-web/  verify/
  packages/    ussd/  ledger/  vault/  lightning/  cashu/  sms/  nostr/  fiat-rails/  i18n/  limits/  crypto/
  infra/       compose.yml  compose.mint.yml  compose.voice.yml  regtest-init/  deploy/
  docs/        architecture.md  threat-model.md  status.md  runbook.md  adr/
  scripts/     demo-seed.ts  smoke.ts  probe/
```

---

## 7. Work packages

Each package follows the same contract: read `docs/architecture.md` and the package brief,
write the tests first, build until `npm test` and the package's acceptance check pass, update `docs/status.md`
with what is real and what is simulated. Packages in the same wave have no shared files and can run in parallel.

**Wave 0: foundations**
- WP0 Monorepo, CI, lint, strict TS, compose skeleton, `docs/architecture.md`, ADRs for the decisions in section 1.
- WP1 Regtest stack: bitcoind + 2 LND + channel + Nutshell on LndRest. *Accept:* `scripts/smoke.ts` mints, melts and pays across the two nodes from a cold `docker compose up`.

**Wave 1: money core**
- WP2 Ledger. *Accept:* property tests (10k random operation sequences) hold the invariants; crash-recovery test.
- WP3 Lightning backends (LND + NWC). *Accept:* same contract test suite passes on regtest LND and on faucet.nwc.dev, including hold settle/cancel.
- WP4 Cashu client + vault. *Accept:* balance = proofs after 1k random sends; swap interrupted mid-flight recovers from the stored preview.
- WP5 Crypto and limits: PIN, pepper, HMAC lookups, limit engine, lockouts.

**Wave 2: channels**
- WP6 `@melax/ussd` engine + simulator provider + all menu flows. *Accept:* golden transcripts for every path in three languages; no screen over 160 characters.
- WP7 Web phone simulator (feature-phone skin, keypad, SMS inbox).
- WP8 SMS channel + android-sms-gateway and httpSMS adapters + GSM-7 encoder.
- WP9 Africa's Talking and generic HTTP USSD adapters with recorded fixtures.

**Wave 3: products**
- WP10 Send/receive/history end to end over USSD on regtest.
- WP11 Lightning address, LNURL-pay server, pay codes, SSRF-safe resolver.
- WP12 Vouchers: create, redeem (USSD, SMS, web), paper sheets, refund sweeper, offline merchant acceptance.
- WP13 Escrow engine + agent flows + bonds + disputes. *Accept:* cash-in and cash-out pass on regtest and on the NWC sandbox; timeout refunds exact balances; race tests around confirm vs cancel.
- WP14 Merchant mode: codes, poster generator, receipts, summaries.

**Wave 4: network and trust**
- WP15 Nostr: relay in compose, NIP-69 offers, receipts, NIP-56 reports, NIP-98 login.
- WP16 Reserve snapshots, OpenTimestamps anchoring, verify page, circuit breaker.
- WP17 Scam shield: guardians, delays, name-before-send, `ARNAQUE` checker with Claude and rules fallback.
- WP18 Fiat rail adapters (Bitnob, PayDunya, Wave) against fixtures, off by default.

**Wave 5: voice and console**
- WP19 Voice line: Asterisk ARI app, keypad flows, recorded prompts, browser softphone.
- WP20 Wolof/French ASR service + intent grammar + accuracy report on recorded phrases.
- WP21 Operator console and roles.
- WP22 Graduation: sweep to Lightning address, Cashu export, NWC link.

**Wave 6: hardening and delivery**
- WP23 End-to-end Playwright suite driving the simulator through every flow; chaos tests (dropped sessions, lost Lightning replies, mint down).
- WP24 Independent review: a reviewer with no build context audits money paths and the threat model, files findings, fixes land with tests.
- WP25 Mutinynet profile and hosted deployment (Caddy, backups, runbook).
- WP26 Demo seed (market in Dakar: 6 users, 3 merchants, 2 agents) and one-command start.
- WP27 Submission pack: README, architecture diagram, status table, 3-minute video script and recording, Devpost text. Written with the human-voice skill.

---

## 8. Definition of done

- `docker compose up` on a clean machine gives a working wallet in the simulator in under 5 minutes.
- Every flow in section 2 runs on regtest with real Lightning payments and real ecash; the hosted demo runs the same stack.
- `docs/status.md` lists, per feature: real on regtest / real on Mutinynet / real with a physical phone / simulated.
- Threat model has a passing test per row. No PII in logs (tested).
- Public repo, MIT licence, CI green.

## 9. Open items that code cannot close

- A real `#2xxx#` code needs ARTP and an operator; the build proves the protocol, not the contract.
- Wolof copy and voice prompts need a native speaker's review before they are called finished.
- BCEAO has no crypto framework and a Senegalese exchange case went to prosecutors in 2025. The design keeps the operator out of fiat for that reason; a pilot with real money still needs legal advice.
