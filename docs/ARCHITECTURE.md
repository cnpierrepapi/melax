# Architecture

What each part is, why it is there, and how a sat moves through real functions. Updated at the end of every phase.
This describes what exists after phase 3. Parts that are only planned are in `docs/PLAN.md`.

## The shape

```
 feature phone --USSD--> aggregator --+
 feature phone --SMS---> phone gateway +--> gateway (apps/gateway, phase 4) --> ledger + vault (Postgres)
 web simulator ------------------------+                |
                                                        +--> mint client --> Nutshell mint --> its own LND node
 someone's Lightning wallet <--> gateway's LND node <---+
```

Two trust domains, two sets of keys:

- The gateway side (`infra/compose.yml`) knows phone numbers and holds each user's ecash, sealed.
- The mint side (`infra/compose.mint.yml`) sees blinded tokens only. It cannot link a payer to a payee.

On regtest a third file (`infra/compose.regtest.yml`) adds the test chain and a node that plays everybody else.

## Modules and the contract each holds

| Module | Contract | Depends on |
|---|---|---|
| `packages/core` | No I/O. Errors with stable codes, sortable ids, an injectable clock, E.164 phone numbers, whole-sat and whole-franc maths, and the only logger, which redacts | nothing |
| `packages/crypto` | Thin wrappers over node:crypto. Argon2id for PINs, AES-256-GCM sealing with an owner tag, HMAC phone lookups, voucher codes with a proven check character | core |
| `packages/ledger` | `Db` (plain SQL, transactions, the same on Postgres and PGlite), append-only migrations, and `post()`: balanced entries, idempotent, hash chained, nothing internal below zero | core |
| `packages/lightning` | `LightningBackend`: invoices, hold invoices, pay, lookups. `pay` never throws for a payment that may have left | core |
| `packages/cashu` | `MintClient`: every mint operation as plan (pure) then run, with a recover call for each | core, crypto |
| `packages/vault` | `Vault`: the only code that moves ecash. Keeps ledger and sealed proofs equal per owner, records every operation before the network call, recovers after a crash | ledger, cashu, lightning, crypto |
| `packages/limits` | Pure rules: tiers, spend checks, PIN lockout schedule, withdrawal delay | core |
| `packages/sms` | GSM-7 checks, inbound command parser, phone-gateway adapters, webhook verification | core |
| `packages/ussd` | Screens that cannot exceed 160 GSM-7 characters, pure menu machines, the session runtime, aggregator adapters | core, sms |
| `packages/i18n` | Every user-facing string in three languages | core, sms |

## The data that flows

- `PlainProof` (`packages/cashu/src/index.ts`): one ecash note as plain JSON: keyset id, amount in sats, secret, signature `C`, optional DLEQ proof and witness.
- `SwapPlan`, `MintPlan`, `MeltPlan`: the inputs and the exact outputs (secrets and blinding factors) of one mint operation. Plain JSON, sealed and stored before the network call.
- `ops` row (`packages/vault/src/index.ts`, migration `vault/001-init`): one operation: kind, idempotency key, owner, stage, status, amount, public data, sealed plan.
- Journal entry (`packages/ledger/src/ledger.ts`): kind, idempotency key, postings that sum to zero, hash of the previous entry.

## Walkthrough 1: sats arrive and become a user's ecash

1. A payment settles on the gateway's node. The caller posts `ext:lightning -> float:node` with `post()`. (Today a test helper does this: `deposit()` in `packages/vault/test/vault.itest.ts`. Phase 8 does it from the invoice listener.)
2. `Vault.mintFor()` asks the mint for a quote (`MintClient.mintQuote`), checks the invoice amount with `decodeInvoice`, and builds the outputs (`MintClient.planMint`).
3. In one transaction it posts `float:node -> float:minting` and inserts the `ops` row with the sealed plan (`insertOp`).
4. `driveMint()` checks `ln.lookupPayment(hash)` first, so a payment is never sent twice, then `ln.pay()`.
5. `MintClient.recoverMint()` reports `not_run`, `runMint()` gets the signatures, `finish()` unblinds them and verifies each DLEQ proof.
6. In one transaction: `addProofs()` seals each proof under the owner's key, `post()` moves `float:minting -> user:<id>:spendable`, the op is marked done, and the `onSettled` hook runs.

If the process dies after step 4, `Vault.recover()` calls `driveMint()` again: the node says the payment succeeded, the mint says the quote is issued, and `recoverMint()` rebuilds the same proofs from the stored plan through the mint's restore endpoint.

## Walkthrough 2: one user sends to another

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

## Why it is built this way

The short version is in `docs/DECISIONS.md`, the plain-words version in `docs/LITEPAPER.md`. The three choices that shape everything else:

- Ecash instead of balances in a table (decision 23 and litepaper choice 2): the party that can issue money knows no one, the party that knows people cannot issue.
- Plan, store, then run (decision 14): the only safe answer to a lost reply is to ask what happened.
- Real mint and real nodes in tests (decision 13): the bugs worth finding live in the gap between a stand-in and the real thing.
