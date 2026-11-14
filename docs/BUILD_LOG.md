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
