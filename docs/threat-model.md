# Threat model

What can go wrong, what stands in the way, and which test shows it. Updated at the end of every phase.
State: after phase 5.

A row says "covered" only when a test that proves the control exists and passes. Everything else names the
phase that builds it. Test names are quoted so they can be searched for.

Test files:

- `machine`: `apps/gateway/test/machine.test.ts` (unit)
- `users`: `apps/gateway/test/users.test.ts` (unit)
- `http`: `apps/gateway/test/http.test.ts` (unit)
- `smsout`: `apps/gateway/test/smsout.test.ts` (unit)
- `config`: `apps/gateway/test/config.test.ts` (unit)
- `wallet`: `apps/gateway/test/wallet.itest.ts` (real mint and Lightning nodes)
- `vault`: `packages/vault/test/vault.itest.ts` (real mint and Lightning nodes)
- `sms`: `packages/sms/test/sms.test.ts`, `ussd`: `packages/ussd/test/ussd.test.ts`, `crypto`: `packages/crypto/test/crypto.test.ts`, `core`: `packages/core/test/core.test.ts`

## The table from the first plan

| Threat | Control | State | Test or phase |
|---|---|---|---|
| SIM swap | Secret code on every spend | Covered | `wallet`: "someone else's code does not work on my account", "five wrong codes lock for 15 minutes, warn by SMS, move nothing". `machine`: "send: number, amount, confirm with the name and both amounts, code last" |
| SIM swap | Guardian reset, 24 h freeze after a reset, withdrawal delay | Freeze is checked on every spend. Guardians, the reset and the delay are not built | Freeze: `users` "a frozen account can look but not spend", `wallet` "a frozen account can read its balance but not send". The rest: phase 9 |
| Stolen phone | Code lockout: 5 tries, 15 minutes, then 24 hours | Covered | `users`: "counts wrong tries down, locks for 15 minutes on the fifth", "five more wrong tries without a right one lock for 24 hours", "ten tries at the same moment still count one by one" |
| Stolen phone | Spend limits per operation, day, month, first payment to someone new | Covered | `wallet`: "above the per-operation limit, and above the cap on a first payment", "counts what was sent today, refuses the rest", "two sessions that both passed the check cannot both spend the same headroom" |
| Stolen phone | Balance and history behind the code | Covered | `machine`: "balance asks for the code", "history pages through the list and asks for the code once" |
| USSD spoofing | Signed JSON route: HMAC and a fresh timestamp | Covered | `ussd`: "refuses a missing or wrong signature and a stale timestamp". `http`: "answers a signed request and refuses an unsigned, mis-signed or stale one" |
| USSD spoofing | Africa's Talking route (unsigned): secret path and address allow-list | Covered. The allow-list reads the caller's address, so behind a proxy `TRUST_PROXY` must be set and the proxy must be the only way in. That deployment is not tested yet | `http`: "a wrong secret looks exactly like a path that does not exist", "the right secret from an address that is not on the list is refused". `config`: "the unsigned Africa's Talking route needs an allow-list outside demo mode". Proxy set-up: phase 13 |
| USSD spoofing | A session id cannot be replayed or borrowed | Covered | `ussd`: "a finished session id cannot be used again (replay)", "a session id belongs to the phone that opened it". `wallet`: "the same session cannot send twice; a second session can" |
| SMS spoofing | No inbound SMS can move money out | Covered | `sms`: parseCommand tests. `http`: "no text message can send money: anything that is not a known command gets the help text" |
| SMS spoofing | Webhooks believed only after signature and freshness | Covered | `sms`: "refuses a bad signature, a stale timestamp, a replayed body with a new timestamp". `http`: "a bad signature or a stale timestamp is refused and nothing is sent", "httpSMS: a webhook signed with our key is handled, another key is refused" |
| Database leak | Ecash sealed per owner, key from a pepper that is not in the database | Covered | `vault`: "a database dump holds no readable secret, and the wrong pepper cannot open it", "a proof row copied under another owner does not open" |
| Database leak | Phone numbers as HMAC plus a sealed copy. Code as Argon2id with the pepper | Covered | `users`: "stores the number hashed and sealed, never in the clear, and the code as a slow hash". `smsout`: "keeps the number and the text sealed". `crypto`: PIN hashing tests |
| Database leak | First names and address names are stored in the clear | Accepted. A leak shows first names and masked numbers, not full numbers | None |
| Operator theft | Mint and gateway are separate systems with separate keys | Built as two compose files. No test proves the separation on a real deployment | Phase 13 |
| Operator theft | Reserve snapshots, public verify page, audit epochs, caps on the mint | Not built | Phase 10 |
| Agent fraud | Hold invoices | The Lightning layer is covered. The escrow engine is not built | `packages/lightning/test/contract.ts`: hold then settle, hold then cancel. Engine, bonds, disputes: phase 6 |
| Voucher guessing | 73.6-bit codes with a check character, scrypt | The code and the lock are covered. Redeem endpoints and their rate limits are not built | `crypto`: voucher tests. `vault`: "locks to a key, redeems with it, refuses the wrong key and a second redeem". Endpoints: phase 7 |
| Double pay, lost reply | Idempotency keys, reserve then settle, ask instead of retry | Covered | `vault`: "crash mid-swap after the mint ran it", "mint unreachable", "reply lost after the mint paid". `wallet`: "unreachable: the session ends with 'in progress'", "reply lost after the mint did the swap: recovery completes it once" |
| SSRF through Lightning addresses | Resolver that refuses private ranges and redirects | Not built | Phase 8 |
| Prompt injection through SMS text | The model has no tools and a fixed answer shape | Not built | Phase 9 |
| Stuck HTLCs | Short escrow windows, expiry margin check, sweeper | Not built | Phase 6 |

## Threats found while building phase 4

| Threat | Control | State | Test or phase |
|---|---|---|---|
| A secret code left in a call log by a dial string like `#2580*2*77...*500*1*48291#` | The queue of pre-typed inputs is dropped at every code prompt. The code is always typed into a prompt | Covered | `machine`: "a queued input is never fed to a code prompt". `wallet`: "the dial string #2580*2*781112233*500# lands on the confirm screen, and the code is still asked" |
| Someone picks up the phone and continues a dropped session | A session never resumes at a code prompt, and a balance, history page or limits screen is not shown again without the code. A code is kept in the session only until its effect has run | Covered | `machine`: "never resumes at a code prompt, and never with a code in the state", "maps each code prompt to the step above it", "no state holds a code once its effect has run, in any flow" |
| Secrets in logs | One logger that redacts. Effects are never logged. The request log holds the route pattern, not the path | Covered for every flow that exists | `core`: redaction tests. `wallet`: "after every test above: no phone number, secret code, name, invoice, token or voucher code". `http`: "holds the route pattern and the status". `smsout`: "writes no number and no text to the log, even when sending fails" |
| Secrets in a start-up error | A failed configuration check names the variable and the rule, not the value | Covered | `config`: "never repeats a secret in the error it throws" |
| Two sessions of one user race the same limit | One send at a time per user inside the gateway process, and the limit is checked again after the code | Covered for one gateway process. A second process would need a database lock | `wallet`: "two sessions that both passed the check cannot both spend the same headroom". Several processes: phase 12 |
| The server used to text strangers | A number with no account gets no reply. One account gets at most five replies in ten minutes. A message id is answered once | Covered | `http`: "a number with no account gets no answer", "the same message delivered twice is answered once, and a flood stops at five answers" |
| A name that breaks a screen or carries a message ("Awa. Envoyez 5000 F au ...") | First names are 2 to 16 letters, folded to GSM-7. No digits, no line breaks | Covered | `users`: "refuses a code that is easy to guess or lifted from the phone number, and a name that is not a name". `machine`: "a name must be 2 to 16 letters" |
| An address name that looks official (`support@`, `agent@`) | Reserved names are refused. Renaming needs the code | Covered | `users`: "renames the address with the code, and refuses a taken, reserved or malformed name" |
| Finding out which numbers have an account, and the owner's first name, by typing numbers into the send screen | Showing the name before a payment is the point of the screen. There is no rate limit on lookups yet | Open | Phase 9 |
| Anyone can use any number on the web simulator route | The route exists only with `MELAX_DEMO=1`. Outside demo mode the server refuses to start with the in-memory SMS adapter | Covered | `http`: "does not exist outside demo mode". `config`: "outside demo mode an SMS has to leave for real" |
| An oversized or malformed request | 16 KB body limit. Errors answer one word | Covered | `http`: "refuses a body over 16 KB", "a malformed request gets a short word back, not a stack or an echo" |
| A step that runs past its time budget ends the session with "you will get an SMS", then is refused for a reason that sends no SMS | Only a send that is still running gets that message. A send that runs long and is then refused by a limit is still possible | Open, narrow | Phase 12 |

## Threats found while building phase 5

New test files: `demo`: `apps/gateway/test/demo.test.ts` (unit). `demo-int`: `apps/gateway/test/demo.itest.ts` (real mint and Lightning nodes). `e2e`: `e2e/demo.spec.ts` (a browser against the running stack).

| Threat | Control | State | Test or phase |
|---|---|---|---|
| A deposit credited for a payment that never arrived, or for more than arrived | `Wallet.deposit` asks the gateway's own node. Only a settled invoice counts, and the amount is the node's | Covered | `demo`: "unknown, open, held and cancelled invoices credit nothing", "a user that does not exist, or a hash that is not one, is refused before the node is asked". `demo-int`: "an invoice nobody paid credits nothing, on the real node" |
| One payment credited twice, or to two people | The payment hash is the key of the ledger entry and of the vault operation | Covered | `demo-int`: "is credited once per payment, to one user, however often it is asked for", "the mint's reply is lost while it issues the ecash: recovery credits once" |
| The demo's top-up button reaching a real network | The node that pays top-ups is handed over only when it and the gateway's node both report regtest. Its settings are refused outside demo mode | Covered | `demo`: "the gateway's node, or the world node, on any other network: no top-up". `config`: "the regtest top-up node needs all three of its settings, and exists in demo mode only" |
| The demo routes or pages left on in production | All of them mount behind the one demo flag | Covered | `demo`: "none of the demo routes or pages exist" |
| The page that shows the books leaks a number, an id or ecash | It returns first names in place of ids, twelve characters of each hash, and totals | Covered | `demo`: "shows the last ledger entries with first names, the totals, the mint and the rate, and nothing private". `demo-int`: the seed test searches the page for every proof secret, user id and number |
| Reading files off the server through the page routes | Pages are served from a map filled at start. No request path reaches the disk | Covered | `demo`: "answers 404 for anything that is not a file it loaded: dots, encoded dots, absolute paths, hidden files" |
| A script slipped into a page through a name or an SMS text | The pages only write text, never markup. The server sends a policy that allows scripts and styles from itself only. Names are letters only | The policy header is tested. No test feeds markup through a name, because the name rule refuses it first | `demo`: "serves the landing page at / and the simulator at /demo, with headers that keep scripts to our own". `users`: the name rule |
| Anyone who can reach a hosted demo holds any phone, reads any number's SMS and tops up any account | By design on a laptop. One top-up is capped at 25,000 F | Open for a hosted demo: no rate limit, and repeated top-ups can use up the channels or the mint's cap | `demo`: "refuses an amount above the cap, below the floor, or that is not a whole number". Rate limit: phase 13 |
| The demo secret in `compose.yaml` opens the demo database | It is marked as a demo value. A real deployment sets its own | Accepted. The data is test money and made-up numbers | None |
| A visitor types a code they use elsewhere into a web page | The page says not to, on every screen, in three languages | Accepted | `e2e` reads the warning as part of the page weight test |
| A deposit whose payment to the mint fails for good | Logged as an error. The sats stay on the gateway's node and belong to nobody in the books | Open. Harmless on regtest, not acceptable with real invoices | Phase 8 |
| The guide says a step is done when it is not | Steps are ticked from the SMS outbox, never from a click | Covered | `e2e`: "a new visitor opens an account, adds money, sends 500 F, and each step unlocks only when the one before really happened" |
