# Status

What is real today and what is not built yet. Updated 15 Nov 2026, after phase 4. The phase board is in `docs/PLAN.md`.

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
| Configuration | 7 tests |
| Deliberate breakage | `node scripts/mutate.mjs` breaks nine guarded lines one at a time. Each one made a test fail |

Totals on 15 Nov 2026: 252 unit tests, 71 integration tests.

The gateway was also started for real once, on the regtest stack with Postgres 17: sign-up, balance and limits
over the simulator route, with the live rate.

## Built, with a known limit

- Money gets into an account only through a test helper. The top-up button comes with the simulator in phase 5, real cash-in with agents in phase 6, and paying in from any Lightning wallet in phase 8.
- The Lightning address shown on the screens is not payable yet (phase 8).
- Sending to a number with no account is refused. Phase 7 turns it into an SMS voucher.
- Menu entries 4 Payer marchand, 5 Depot, 6 Retrait, 7 Bons, the guardians, "code oublie" and the move to a smartphone answer "Bientot disponible sur Melax."
- The gateway must run as one process. Sessions and the per-user send queue are in its memory.
- The clean shutdown path has not run: a signal sent from Git Bash on Windows does not reach the server. To be checked in Docker.
- Nothing limits how many numbers a caller can look up on the send screen (phase 9).

## Not built yet

The web phone simulator and landing page, the demo seed, the agent escrow engine, vouchers and merchant mode,
Lightning address and LNURL, the scam shield and account recovery, Nostr offers and receipts, reserve snapshots
and the verify page, the operator console, the voice line and Wolof speech, fiat rail adapters, the Mutinynet
profile, the hosted deployment, and the submission pack.

Nothing is deployed. The repository is private.
