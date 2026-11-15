# Melax

A bitcoin wallet for the small phone you already have. You dial `#2580#`, a menu opens, and you can hold,
send and receive bitcoin in francs, in Wolof, French or English. No app, no internet. Under the menu it is
Lightning and Cashu ecash, and an agent with a Wave or Orange Money account swaps francs for sats with you.

Melax is Wolof for lightning.

This is a learning project. I built it for the Dakar Bitcoin Hack 2026 and decided not to submit it. It runs
on a private test network on your machine. No real money, no real phone line, nothing deployed.

## What works

Everything below runs against a real Nutshell mint and real Lightning nodes, on a local regtest chain.

- Open an account from the phone menu, with a 5-digit code. Five wrong tries lock it.
- Balance and history, behind the code. Amounts in francs and in sats.
- Send to another number. Real ecash moves, and both people get an SMS receipt with the same number.
- Limits per payment, per day, per month, and a cap on the first payment to someone new.
- Cash in through an agent (menu 5). You pick an agent, the agent's sats get locked in a Lightning payment, you send francs, the agent confirms with their code, and the sats are yours. Nobody confirms for 45 minutes: the agent gets every sat back.
- Cash out through an agent (menu 6). Your sats go into a box only the engine can open. The agent sends francs, you confirm with your code, the box pays the agent's wallet.
- Agents put up a bond. A dispute goes to an arbiter, and if it outlives the Lightning lock, the bond pays you.
- A web page with two drawn phones that dial the real server, their SMS, and the books, live. A four-step guide that only ticks a step when the server's own SMS shows it happened.

The part I care about most is what happens when things break. The line drops mid-payment, the server dies,
the mint's reply gets lost. In every one of those cases Melax writes down what it is about to do before it
calls anyone, and after a crash it asks the mint or the node what happened. It never guesses and never pays twice.

## Run it

You need Docker (the stack took about 800 MB of RAM here), Node 24 and npm.

```
npm install
docker compose up -d --wait        # bitcoind, three LND nodes, the mint, Postgres, and the app. About 2 minutes
```

Then open `http://localhost:8787`. The demo page is `/demo`. Seeded people share the code `27495`.

For the tests and the scripts, copy the test nodes' credentials out of Docker first:

```
bash scripts/dev-creds.sh
npm test                 # 350 unit tests, no network
npm run test:int         # 101 tests against the real mint and nodes, about 8 minutes
npm run test:e2e         # 12 browser tests (first time: npx playwright install chromium)
node scripts/mutate.mjs  # breaks 25 guarded lines one at a time; a test has to catch each one
```

## Kill it mid-payment

```
npm run crash-demo
```

This starts a second copy of the real server on port 8790 with a kill switch at its network edge. Awa sends
Moussa 500 F. The mint does the swap, and the instant it answers, the server kills itself with SIGKILL. Then:

```
   what the database holds now:
     Awa     locked      1250 sats
     Awa     spendable  11250 sats
     transfers: 1 pending; history rows of the send: 0
4. A new gateway process starts, with no kill switch. Before it answers any phone it asks the mint what happened.
   after the restart:
     Awa     spendable  11250 sats
     Moussa  spendable   1250 sats
     transfers: 1 done; history rows of the send: 2
   SMS to Awa: Melax: envoye 500 F a Moussa. Solde: 4 500 F. Recu no 1002
   SMS to Moussa: Melax: recu 500 F de Awa. Solde: 500 F. Recu no 1002
   books: 12500 sats owed, 12500 sats of ecash held, they match
```

A second restart changes nothing. The payment happened once.

## How it fits together

```
 feature phone --USSD/SMS--> gateway (apps/gateway) ----------> mint (Nutshell, its own LND node)
                              |  menus, accounts, limits         issues ecash, never sees a phone number
                              |  vault: sealed ecash + ledger
                              |  escrow: agents, bonds, disputes
                              '--> gateway's LND node <--Lightning--> agents' wallets, everybody else
```

The mint and the gateway are separate on purpose. The mint can issue money but knows nobody. The gateway knows
people's numbers but cannot issue money. The gateway holds the ecash for its users, sealed with a key that is
not in the database. That makes it custodial, and I say so everywhere.

## What is not real

- The phone is a web page, and the SMS stay on the page. The code speaks the protocols USSD aggregators and SMS phone gateways use, tested against their documented formats, but no real short code or SIM was ever wired up.
- The coins are on a private regtest chain. They are worth nothing.
- In an agent trade the francs part is pretend. The agent's confirmation is a button press.
- Agents' wallets are one test node playing everybody. A wallet linked by Nostr Wallet Connect was tested for the Lightning lock only, on the public NWC sandbox.
- An arbiter's decision is recorded, not signed. There is no console.
- Melax takes no on-chain bitcoin. Money comes in through an agent or the demo's top-up button.
- The Wolof is mine and no native speaker has read it.
- Running this with real money in Senegal needs legal advice first. A wallet like this holds people's money.

## Where it stopped

Phases 0 to 6 of 15 are built. The plan for the rest, the rules the code follows and a log of every bug with
its cause are in `docs/`:

- `docs/LITEPAPER.md`, the plain-words version: every big choice, the road not taken, and what it cost.
- `docs/PLAN.md`, the phase board and the brief for the next phase (vouchers and merchants).
- `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (67 of them), `docs/threat-model.md`, `docs/BUILD_LOG.md` (53 defects), `docs/status.md`.

The obvious next step is Mutinynet, a public test network with 30 second blocks, the same pace as the local
chain here. On it, anyone could pay into Melax from their own test wallet and check the payments for themselves.

The closest thing that exists is Machankura, a USSD Lightning wallet running in several African countries. Melax's
take on it is the agent trade: neither side has to go first on trust.

## License

MIT.
