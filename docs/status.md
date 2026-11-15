# Status

What is real today and what is not built yet. Updated 15 Nov 2026, after phase 5. The phase board is in `docs/PLAN.md`.

## Built and tested

| Part | Proof |
|---|---|
| Regtest network: bitcoind, three LND nodes, Nutshell mint, Postgres, Nostr relay | `docker compose up`, then `node scripts/smoke.ts`: mint, swap and melt with real payments. Restart after a night stopped also checked |
| Lightning backends: LND over REST, Nostr Wallet Connect | One 10-test contract suite, passing on regtest LND and on faucet.nwc.dev, hold settle and cancel included |
| Ledger: double entry, hash chained, idempotent | 13 tests, including tampering and a random-operations run |
| Ecash client: plan, run, recover | 15 tests against the real mint |
| Vault: sealed proofs, deposits, transfers, vouchers, export and import, pay-outs, crash recovery | 21 tests against the real mint and nodes, plus 1,000 random sends |
| PIN hashing, sealing, key derivation, voucher codes | 18 tests. The voucher check character is proven by enumeration |
| Limits and PIN lockout | 10 tests |
| SMS: GSM-7, inbound commands, android-sms-gateway and httpSMS adapters | 15 tests against the documented request shapes. No message has gone through a physical phone yet |
| USSD SDK: screens, runtime, Africa's Talking and generic providers | 19 tests |
| Wording in French, Wolof, English | 9 tests. Wolof not reviewed by a native speaker |
| Wallet menus: open an account, balance, send, receive, history, change the code, language, address, limits | 72 tests on the menu machine, 33 of them golden transcripts in three languages. 13 more through the real services |
| Accounts and the secret code: numbers hashed and sealed, lockout after five tries, freeze | 17 tests, on PGlite and on Postgres 17 |
| A send between two phones, with real ecash | 15 tests against the real mint and nodes: limits, lockout, one send per session, mint unreachable, reply lost, both HTTP routes, and a check that the logs of the whole run hold no number, code, name or invoice |
| SMS outbox: queued with the money, sealed, retried | 9 tests |
| Exchange rate: live source, euro-peg fallback, cache | 8 tests. The fixture is a recorded answer |
| HTTP routes: simulator, Africa's Talking, signed JSON, two SMS webhooks | 17 tests |
| Configuration | 8 tests |
| A deposit over Lightning: credited only for an invoice the gateway's own node reports as settled, for the node's amount, once per payment | 2 unit tests and 5 against the real mint and nodes, one of them with the mint's reply lost and recovered |
| Demo routes: one number's SMS, the seeded people, the books under first names, the top-up's refusals | 11 unit tests. The state page is dumped and searched for numbers, ids, keys and proofs |
| The top-up node is handed over on regtest only | 4 unit tests, and the configuration refuses its settings outside demo mode |
| Demo seed: six accounts, each topped up with a real payment, five payments between them | 1 test against the real mint and nodes, and every start of the `app` service |
| Web pages served from memory, with a script policy | 5 tests, 15 hostile paths among them |
| Landing page and phone simulator, in Wolof, French and English | 7 tests on the wording. 10 browser tests against the running stack: the four-step guide on a 360 px screen, a payment between two phones, a wrong code, a foreign code, the language switch, the page weight, and no sideways scroll at 320, 360 and 1440 px |
| One command start | `docker compose up` from empty volumes to a seeded wallet on `http://localhost:8787`: 126 s with the images already pulled. `docker compose stop app` exits in half a second with code 0 |
| Deliberate breakage | `node scripts/mutate.mjs` breaks fifteen guarded lines one at a time. Each one made a test fail |

Totals on 15 Nov 2026: 282 unit tests, 78 integration tests, 10 browser tests.

The gateway tests (166 unit, 22 integration) also pass on a real Postgres 17 server.

## Built, with a known limit

- Money gets into an account through the top-up button of the demo, on the test network only. Real cash-in with agents comes in phase 6, and paying in from any Lightning wallet in phase 8.
- The demo routes have no login. Anyone who can reach the page can hold any phone and top up any account, 25,000 F at a time, with no limit on how often. Fine on a laptop. A hosted demo needs a rate limit first (phase 13).
- Top-ups only flow one way: world node, gateway node, mint. The regtest helper opens one more channel when a side runs under 1,000,000 sats. The mint also stops issuing at 20,000,000 sats.
- A deposit whose payment to the mint fails for good leaves the sats on the gateway's node, owned by nobody in the books. It is logged as an error and not retried. Phase 8 has to close this before real invoices arrive.
- The demo uses a fixed rate of 40,000,000 F per bitcoin, written in `compose.yaml`. Start with `RATE_FIXED_XOF_PER_BTC=` to use the live rate.
- The Lightning address shown on the screens is not payable yet (phase 8).
- Sending to a number with no account is refused. Phase 7 turns it into an SMS voucher.
- Menu entries 4 Payer marchand, 5 Depot, 6 Retrait, 7 Bons, the guardians, "code oublie" and the move to a smartphone answer "Bientot disponible sur Melax."
- The gateway must run as one process. Sessions and the per-user send queue are in its memory.
- Nothing limits how many numbers a caller can look up on the send screen (phase 9).
- The Wolof on the web pages has not been read by a native speaker either. The Wolof page says so, in Wolof.
- The pages were checked in Chromium only.

## Not built yet

The agent escrow engine, vouchers and merchant mode, Lightning address and LNURL, the scam shield and account
recovery, Nostr offers and receipts, reserve snapshots and the verify page, the operator console, the voice line
and Wolof speech, fiat rail adapters, the Mutinynet profile, the hosted deployment, and the submission pack.

Nothing is deployed. The repository is private.
