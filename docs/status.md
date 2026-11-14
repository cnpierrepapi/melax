# Status

What is real today and what is not built yet. Updated 14 Nov 2026.

## Built and tested

| Part | Proof |
|---|---|
| Regtest network: bitcoind, three LND nodes, Nutshell mint, Postgres, Nostr relay | `docker compose up`, then `node scripts/smoke.ts`: mint, swap and melt with real payments |
| Lightning backends: LND over REST, Nostr Wallet Connect | One 10-test contract suite, passing on regtest LND and on faucet.nwc.dev, hold settle and cancel included |
| Ledger: double entry, hash chained, idempotent | 13 tests, including tampering and a random-operations run |
| Ecash client: plan, run, recover | 15 tests against the real mint |
| Vault: sealed proofs, deposits, transfers, vouchers, export and import, pay-outs, crash recovery | 21 tests against the real mint and nodes, plus 1,000 random sends |
| PIN hashing, sealing, voucher codes | 17 tests. The voucher check character is proven by enumeration |
| Limits and PIN lockout | 10 tests |
| SMS: GSM-7, inbound commands, android-sms-gateway and httpSMS adapters | 15 tests against the documented request shapes. No message has gone through a physical phone yet |
| USSD SDK: screens, runtime, Africa's Talking and generic providers | 18 tests |
| Wording in French, Wolof, English | 9 tests. Wolof not reviewed by a native speaker |

## Not built yet

The gateway service itself (accounts, send, pay, history over USSD), the web phone simulator, Lightning address and LNURL,
the agent escrow engine, merchant mode, Nostr offers and receipts, reserve snapshots and the verify page, the scam shield,
the operator console, the voice line and Wolof speech, fiat rail adapters, the Mutinynet profile, the hosted deployment,
the demo seed, and the submission pack.

Nothing is deployed. The repository is private.
