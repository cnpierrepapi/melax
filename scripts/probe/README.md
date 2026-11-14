# Probes

Two throwaway scripts from the dependency audit in `docs/PLAN.md` section 1. They are kept because
the plan cites their results.

- `nwc-probe.mjs`: creates two sandbox wallets on faucet.nwc.dev and checks plain pay, hold then settle, hold then cancel.
- `cashu-probe.mjs`: needs a Nutshell mint on `localhost:3338`. Measures token sizes and proves the short-code voucher lock.

Run them from a scratch folder with `@getalby/sdk`, `@cashu/cashu-ts` and `@noble/curves` installed.
