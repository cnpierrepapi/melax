# Melax litepaper

Draft of 15 Nov 2026, updated after phase 5 (the phone simulator). Melax is Wolof for lightning.

## What it is

Melax is a bitcoin wallet for a phone with no internet. You dial a short code, a menu comes up, you type a number
and an amount, you confirm with a secret code. It is the same menu you already use to check airtime or send
mobile money, with sats behind it.

The person I have in mind sells at a market in Dakar and owns a phone with buttons. A cousin in Paris wants to send
her 5,000 francs tonight without a transfer shop taking a cut and a day. She does not want an app or a seed phrase. She wants a number to give out and a way to turn the money into francs at the stall next door.

## How it works, with no jargon

Five pieces. Each one has an everyday twin.

The menu (USSD). When you dial `#2580#`, the phone network opens a text conversation between your phone and my
server. No data plan, no app. Every screen holds 160 plain characters, so every word on it had to earn its place.

The fast road (Lightning). Bitcoin's main chain is a slow, careful ledger. Lightning is the fast road built on
top of it: payments arrive in about a second and cost almost nothing. It is how money gets in and out of Melax.

Digital banknotes (ecash). Inside Melax, your balance is a small pile of digital notes. A mint signs each note,
the way a central bank prints money. The trick is that the mint signs them blind. Picture a note sealed in an
envelope lined with carbon paper: the mint stamps the envelope, the stamp goes through onto the note, and the mint
never sees the serial number. Later it can check its own stamp, but it cannot tell whose note it was.

The locked drawer (the gateway). A phone with buttons cannot keep digital notes. So my server keeps them for you,
in a drawer locked with a key that is never written to the database. Your secret code is what tells the server to open it.

The exercise book (the ledger). Every movement is written as a line with a from and a to, in whole sats. Each
line carries a fingerprint of the line before it. Tear out a page or change a figure and the fingerprints stop
matching. Anyone with the book can check that.

So a payment from Awa to Moussa goes like this. Awa dials, picks Send, types Moussa's number and 500. The screen
shows `Send 500 F (1 250 sats) to Moussa (78*****33)?`. She confirms and types her code. The server takes notes
worth 1,250 sats out of her drawer, hands them to the mint, and gets fresh notes back: 1,250 for Moussa's drawer
and the change for hers. The exercise book gets its line. Both phones get an SMS with the same receipt number.

That is not a sketch any more. It is the first test in `apps/gateway/test/wallet.itest.ts`, with those numbers,
against the real mint.

## What exists today, and what does not

Built and tested as of this draft:

- A private test network that starts with one command: a bitcoin chain, three Lightning nodes, the mint, a database.
- The Lightning layer, with two ways to connect. The same ten checks pass on both, including locking a payment and then releasing or refunding it.
- The exercise book. I ran 10,000 random sequences of operations against it and the totals always came back to zero.
- The drawer and the note handling: deposits, transfers, vouchers locked to a code, pay-outs, and recovery after a crash. 36 tests against the real mint, then 1,000 random sends. The long run and the crash tests end by asking the mint whether every note I believe I hold is still unspent. It was.
- Secret code hashing and lockout, spending limits, SMS handling, the menu engine, and every screen in French, Wolof and English.
- The wallet itself, through the menus: open an account, read a balance, send to another number, see how to receive, read the history, change the code, the language or the address name. 143 tests without a network, 15 more with real ecash.
- Something you can click. One command starts everything, and a web page shows two phones with buttons. They dial the real server. A guide walks you through four steps: open an account, add test money, send 500 F, look at the other phone. A browser test does the same walk on a 360 pixel screen.
- Agents. Press 5 to cash in: you pick an agent, the agent's sats get locked in a Lightning payment, you send the francs, the agent confirms with their code and the sats are yours. Press 6 to cash out: your sats wait in a locked box until you say the francs arrived. Bonds, disputes, an arbiter's button. On the demo page the second phone can be the agent's.

Designed and not built yet: vouchers and shops, Lightning addresses that can be paid, the public reserve check,
the voice line. The order is in `docs/PLAN.md`.

The gap that matters most moved. Money can now come in through an agent, but on the test network the francs part
is pretend: nobody sends a real Wave transfer. And a relative abroad still cannot pay in from their own wallet.
That comes with Lightning addresses.

I would rather show less and have every part of it be real.

## The choices, and the roads not taken

For each one: what the question was, what the two options were, which I picked, and what it costs me.

### 1. Who holds the money

A smartphone wallet lets you hold your own keys. Nobody can freeze or lose your money but you. A phone with buttons
cannot do that: there is nowhere to keep a key and no app to run.

So for USSD users Melax holds the money. I say it plainly instead of dressing it up. What I did to shrink the trust:
the mint and the gateway are two separate systems with separate keys, the mint has a cap on what it will hold and
each user has limits on what can move, and a voucher lets money leave the system as a code. Still to build: a public
page where anyone can check that what Melax owes is covered, and a menu entry that sends the whole balance to a
wallet the user controls on the day they get a smartphone.

Cost: a user has to trust the operator. That is the honest price of working on any phone.

### 2. Ecash, or just numbers in a database

The simple way is a table: Awa 5,000, Moussa 2,000. Sending is one number down, another up. Mobile money works
like this and it is fast.

I used ecash instead. Three reasons. The mint cannot see who pays whom, so the party that could print money
knows nothing about people, and the party that knows people cannot print money. A voucher becomes a real bearer
note that works without my server. And the notes are a standard, so a user can walk out with them to any Cashu
wallet.

Cost: it is much more work, every send needs a round trip to the mint, and there are now two parties to trust
instead of one. For a weekend demo a table would have been enough. For something people keep money in, splitting
the power in two is worth it.

### 3. Run my own Lightning node, or rent one

Renting (a wallet you connect to over the internet) is quick and needs no channel management. Running a node gives
full control and one feature I need: a payment that can be locked and released later.

I built both behind one interface and run my own node in the test network. Writing the same ten checks for both
paid off: the sandbox wallet I tested cannot cancel a locked invoice that nobody has paid yet. Had I tested only my
own node, the agent flow would have had a hole in it.

Cost: two adapters to maintain.

### 4. How agents swap francs for sats

Option one: plug into Wave or Orange Money and move the francs myself. Smooth for the user, but it makes me a
money transmitter handling francs, needs contracts I do not have, and puts me in a place the regional central bank
has not written rules for.

Option two: the agent and the customer swap directly, and Melax only referees the bitcoin side. The agent's sats
are locked in a payment that nobody can spend yet. The customer sends francs over Wave. The agent confirms, the
lock opens. If nobody confirms in 45 minutes, the sats go back by themselves.

I chose the referee, and it is built now. Cash-out is the mirror: your sats move into a box only the engine opens,
the agent sends you francs, you confirm with your code, and the box pays the agent's wallet.

Each agent also puts up a bond, in sats, with Melax. An agent can never have more cash-ins open than the bond
covers. It is the agent's skin in the game, and it pays the customer when a dispute outlives the lock (choice 24).

Cost: a person has to press confirm, sats sit locked while they wait, and a dispute needs a human arbiter. There
is no console for the arbiter yet, just a protected address the console will call.

### 5. Getting a voucher into one SMS

I wanted "send money to any number, even one that never heard of Melax". The obvious way is to text the ecash
itself. I measured it first: a token is between 366 and 2,136 characters, three to fourteen SMS. Not usable.

So the SMS carries a 16-character code. The code is run through a slow function that turns it into a key, and the
notes are locked to that key. The locked notes can be stored anywhere, even in public, because without the code
they cannot be spent. After 30 days an unclaimed voucher returns to the sender.

Cost: 15 random characters instead of a long random key. That is still about 10^22 possibilities, and each guess
costs real computing time, but it is a trade and I know it.

### 6. Catching typos in a code

People will copy that code from a screen by hand. A check character at the end catches mistakes. The textbook
scheme (ISO 7064) looked right. I tested every case before using it and it missed 60 of 26,100 swaps of two
neighbouring characters.

I replaced it with a scheme by Damm that catches every single wrong character and every swap. The test goes
through all the cases, so this is something I can show, not something I hope.

Cost: a lookup table in the code that needs a comment to explain.

### 7. What the secret code protects

One option is to encrypt each user's notes with their PIN. It sounds strong: even I could not read them. But a
five-digit PIN has 100,000 possibilities. Anyone who stole the database could try them all in an afternoon. I would
be claiming protection that is not there.

So the PIN is a gate, checked with a slow hash and a server secret that is never stored in the database. The
notes are encrypted with a key that also needs that server secret. The lockout rule: five wrong tries lock the code
for 15 minutes, the next five for a day.

Cost: the operator, holding the secret and the database, can read the notes. See choice 1.

### 8. When the line drops in the middle of a payment

The easy fix is to try again. With money that is how you pay twice.

Every operation is written down before it is sent: the plan first, then the request. If the answer never comes,
the server does not guess. It asks the mint what happened and finishes or undoes the job from the saved plan.
Until it knows, that money stays locked and the user sees "in progress, you will get an SMS".

Cost: more states to handle, and only one outgoing payment per user at a time.

### 9. Tests against the real thing, or against a stand-in

A stand-in mint written by me would make tests fast and would agree with whatever I believed. That is the problem.

The money tests run against the real mint software and real Lightning nodes on the private network. To test a
crash I cut the connection at the edge of the test and leave the mint alone. This found things a stand-in never
would: the mint replays its answer when asked twice, the library retries nine times on its own, a balance read
can land mid-update.

Cost: the tests need Docker and take minutes instead of seconds.

### 10. The exercise book, or a balance column

A single balance column per user is one line of code. It cannot tell you where a sat came from or prove that
nobody edited it.

I used double entry with chained fingerprints. Only the accounts that stand for the outside world may go negative.

Cost: one writer at a time. Fine for a pilot of a few thousand users. It would need rethinking at the scale of a
national operator.

### 11. Plain database queries, or a toolkit

The first plan named a query toolkit (Drizzle). I wrote plain SQL instead. A reviewer can read every money
movement as one statement, and the same statements run inside the tests with no database server.

Cost: no automatic type checking of queries, and I write migrations by hand.

### 12. Francs on the screen

Users think in francs, the system keeps sats. I show both and keep limits in francs.

The rate moves all day, so which sats count: the ones on the confirm screen, or the ones worked out again when
the code is typed? I went with the screen. What you agreed to is what leaves. Between two users nobody gains or
loses on the rate, so there is nothing to protect by recomputing. If the two ever differ by more than 5 percent
the server refuses, because that would be a bug and not a price move.

Cost: rounding can be off by up to one franc, and a quote can be a few minutes old if the line dropped and the
session was picked up again.

### 13. Fees

When money comes in, the user is credited the full amount and I absorb the small routing cost to the mint. When
money goes out, the user pays the real Lightning fee, capped at 5 sats or half a percent. I measured what the mint
asks: 3 to 4 sats when it knows a route. When it does not, it asks for 1 percent and my cap refuses the payment.

Cost: on a public network that refusal may happen more often. I would rather refuse than surprise someone with a fee.

A cash-out has the same fee, and somebody has to carry it. I could have paid the agent the sats minus the fee.
Instead the user's box holds the sats plus the most the fee can be, the agent gets exactly the sats they agreed to,
and whatever the fee did not use comes back to the user. So the confirm screen shows a slightly bigger number
than the sats. That number is the honest one.

### 14. A test network, not real bitcoin

Everything runs on a private chain. Real money needs a real short code from the regulator, an operator contract,
and legal advice. None of that fits in a hackathon, and pretending otherwise would be a lie.

Cost: a judge cannot pay in from their own wallet yet. A public test network profile is in the plan.

### 15. Does reading a balance need the code

Leaving it open is one step shorter, and the balance is the screen people use most. But a phone with buttons
gets lent, to a child, a neighbour, the person at the next stall. What is in the account is nobody's business
but the owner's.

Balance and history ask for the code. Limits, the address and the language do not.

Cost: one more step, every time.

### 16. One long dial string, or the code typed by hand

Shortcodes can carry the whole request: `#2580*2*781112233*500#` jumps straight to the confirm screen. The
tempting next step is to put the code in there too and pay in one dial.

I stopped at the code. A dial string stays in the phone's call log, where anyone who picks the phone up can read
it. So whatever was pre-typed is thrown away the moment a code prompt comes up, and the code is always typed
into the prompt. If someone dials the long version anyway, the code in it is ignored and they are asked again.

Cost: paying always takes at least two steps.

### 17. When the receipt gets written

The simple order is: move the money, then write the history line, then queue the SMS. Three steps, and a crash
between any two leaves money that moved with no trace of it for the user.

The history lines, the receipt number and both SMS are written in the same database transaction that settles the
notes. Either all of it exists or none of it does. This also covers the slow case: when the mint goes quiet and
the answer is only found later, the receipts are written then, by the same code.

One exception, on purpose. If an SMS cannot be put together, say a name that will not fit the alphabet, the
money still settles and the problem is logged. The other order would leave money locked because of a sentence.

Cost: every new kind of payment has to plug into that one place.

### 18. Two phones, one limit

A daily limit is checked before a send. Two sessions on the same account can both pass the check and then both
send. The clean fix is a lock in the database. The quick fix is a queue in the server's memory: one send per
person at a time, and the limit is checked again after the code.

I took the quick one and tested it with two sessions typing the code at the same instant. One goes through, the
other is told the limit is reached.

Cost: it only holds while there is a single server process. Before there are two, the queue has to move into the
database. It is on the list.

### 19. Who gets an SMS back

A stranger texts SOLDE. The friendly thing is to answer "dial #2580# to open an account".

But the sender of an SMS can be forged. A server that answers every number will text any phone an attacker
names, at my cost and in my name. So a number with no account gets silence, an account gets at most five replies
in ten minutes, and nothing an SMS can ask for moves money out.

Cost: a curious person who texts first hears nothing.

### 20. Tests that passed the first time

I wrote the menu tests before the menus. When the code was done they all passed on the first run. That sounds
good and proves little: a test that has never failed has not shown it can.

So I broke the code on purpose, one line at a time. Let the dial string reach the code prompt. Let a session
resume at the code prompt. Skip the lock. Skip the code on a send. Nine of these after the menus, six more after
the simulator, each followed by the tests. All fifteen were caught, and the script that does it is in the repository (`scripts/mutate.mjs`).

Cost: fifteen lines is a sample. It is not a proof that every line is guarded.

### 21. Where the demo's money comes from

A demo needs accounts with money in them. The quick way is one line that writes a balance into the database.

I did not want a number in the demo that the real system could not have produced. So the top-up button makes a
real payment on the test network. A node that plays "a relative abroad" pays the gateway's node, the gateway asks
its own node whether the payment really settled and for how much, and only then buys ecash for the account. The
six people at the market who are already there when you arrive got their money the same way.

It is the same door a Lightning address will use later. It asks the node. It does not believe the caller.

Cost: the demo needs that second node's keys, so it only works on the test network, and the server checks that
before it offers the button. Money only flows one way until cash-out exists, so the test network has to open a
new channel now and then. I found that out when the seed stopped working after a day of tests.

### 22. How the guide knows you did the step

The demo page has four steps. A guide could tick a step when you press "next".

Mine ticks a step when the server's own SMS outbox shows it happened. The welcome SMS means the account exists.
The deposit SMS means the money arrived. The next step stays shut until then. You cannot click your way past a
step you did not do, and what the page says is always what the wallet did.

Cost: the page asks the server every second and a half, and the guide now depends on the names the server gives
its SMS. Change one and the guide stops ticking. A browser test catches that.

### 23. How long a payment can stay locked

The plan said 45 minutes and wrote it as a fact. Before building anything I measured it. A locked Lightning
payment dies when its block budget runs out, and the node gives up a bit before that. With LND's default the
payment survived 65 blocks. On my test chain that is 32.5 minutes. The 45 minute window would have failed every
time, quietly, on the agent's side.

So the budget is now a setting, and the server refuses to start if the setting and the block time cannot cover the
3 hour hard cap. On the test chain 432 blocks held a payment for 414 blocks, past the 360 the cap needs. On the
real network the default is already enough, because a block takes ten minutes there and not thirty seconds.

The other road was to trust the plan's number. It would have looked fine in every demo shorter than half an hour.

Cost: a bigger budget ties up the agent's sats in the network for longer if something goes wrong. And there is a
ceiling: the paying node refused a budget of 2,100 blocks.

### 24. A dispute that outlives the lock

Say you sent the francs and the agent swears they never came. Someone has to look. That can take a day, and a
Lightning payment cannot stay locked for a day.

Option one: keep the payment locked as long as possible and hope the arbiter is quick. Option two: let the lock
go at the 3 hour cap, give the agent their sats back, and if the arbiter then decides for you, pay you out of the
agent's bond.

I chose the second. It is why open cash-ins are capped by the bond: the bond has to be able to pay all of them.
A decision made while the payment is still locked just settles it, and the bond is not touched.

Cost: an agent with a dispute open can take fewer new customers until it is decided. And the arbiter's decision
is recorded with who made it, but not signed yet. Signing comes with the Nostr keys.

## What I do not claim

- The Wolof was written by me and no native speaker has read it yet.
- No SMS has gone through a physical phone. The adapters are tested against the documented formats.
- No short code is live. The server speaks the protocol aggregators use, which proves the software and not the contract.
- This is not legal to run with real money in Senegal today without advice.
- Nobody can pay into an account from outside yet, except through the demo's top-up button and through an agent, both on the test network. The address shown on the screens cannot be paid yet.
- No Wave or Orange Money transfer has happened. In the demo the francs side of a trade is pretend, and the agent's confirmation is a button press.
- The agents' wallets on the test network are one node playing everybody. A wallet linked by Nostr Wallet Connect was tested for the locked payment only: the public sandbox cannot pay my test mint, so the whole trade was never run there.
- An arbiter's decision is recorded, not signed. There is no console for it yet.
- It is not deployed anywhere. It runs on my machine, in Docker, from one command.
- The demo pages have no login. Anyone who can reach them can hold any phone. That is what a demo is for, and it is why the server refuses to carry them outside demo mode.
- The Wolof on the web pages is mine too, and just as unread as the Wolof in the menus.
- It has to run as a single process for now.
- Anyone can type numbers into the send screen and learn which ones have an account and the owner's first name. Showing the name is the point of that screen. Limiting how often is not built.

## Questions I expect

These answers describe the design. The section above says which parts are built.

*Is this a bank?* No. It holds small amounts for people whose phones cannot hold keys, with caps, and with a way out.

*What if your server is hacked?* The database alone is useless: notes and phone numbers are sealed with a secret that is not in it. An attacker with the running server could move what the gateway holds, which is why holdings are capped and the mint is a separate system.

*What if you run away with the money?* That is the risk of any custodian. The answer is caps, the split between mint and gateway, and a reserve check anyone can run. It lowers the risk. It does not remove it.

*Why not just use mobile money?* Mobile money stops at the border and at the operator. This lets a relative abroad pay in from any Lightning wallet, and the user can leave with their money.

*Why ecash and not Lightning for each user?* A Lightning wallet per user needs a node or a custodian per user. Ecash gives private, instant transfers inside and one Lightning connection to the outside.

*What happens if the phone is stolen?* Nothing moves without the code. Five wrong tries lock it. Limits cap what a thief could take even with the code.

*Can someone empty my account by faking an SMS from my number?* No. An SMS can ask for a balance or for help. Sending needs a USSD session and the code.

*The line dropped while I was typing. Did I pay?* If you had not typed the code, nothing moved, and dialling again offers to continue from the confirm screen. If you had, either you get the receipt by SMS or an SMS saying it did not go through. The server finds out which. It does not guess.

*What if the agent keeps my francs and never confirms?* Open a dispute from menu 5. Until the arbiter decides, the agent's sats stay locked, up to 3 hours. If the decision comes later than that, you are paid from the agent's bond.

*What if I take the agent's francs and say they never came?* Your sats stay in the box. Once the agent says the francs were sent, neither the clock nor a cancel gives them back to you: after 45 minutes of silence it becomes a dispute.

*How do you know the books are right?* The vault tests end by comparing the ledger with the notes held, account by account. The long run and the crash tests also ask the mint whether those notes are still unspent.

## Words used here

- USSD: the menu system behind codes like `#144#`. Works on every phone, no data.
- Dial string: a short code with the answers already in it, like `#2580*2*781112233*500#`.
- Sat: one hundred-millionth of a bitcoin.
- Lightning: bitcoin's fast payment network.
- Ecash, Cashu: digital notes signed by a mint that cannot trace them.
- Mint: the service that signs and redeems the notes.
- Gateway: my server. It runs the menus and keeps the notes.
- Hold invoice: a Lightning payment that is locked until someone releases or cancels it.
- Voucher: notes locked to a code.
- Regtest: a private bitcoin network for testing.
