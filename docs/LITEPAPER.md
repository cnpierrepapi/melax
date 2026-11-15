# Melax litepaper

Draft of 15 Nov 2026. Melax is Wolof for lightning.

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
shows `Send 500 F (808 sats) to Moussa (77*****67)?`. She confirms and types her code. The server takes notes
worth 808 sats out of her drawer, hands them to the mint, and gets fresh notes back: 808 for Moussa's drawer and
the change for hers. The exercise book gets its line. Both phones get an SMS.

## What exists today, and what does not

Built and tested as of this draft:

- A private test network that starts with one command: a bitcoin chain, three Lightning nodes, the mint, a database.
- The Lightning layer, with two ways to connect. The same ten checks pass on both, including locking a payment and then releasing or refunding it.
- The exercise book. I ran 10,000 random sequences of operations against it and the totals always came back to zero.
- The drawer and the note handling: deposits, transfers, vouchers locked to a code, pay-outs, and recovery after a crash. 36 tests against the real mint, then 1,000 random sends. The long run and the crash tests end by asking the mint whether every note I believe I hold is still unspent. It was.
- Secret code hashing and lockout, spending limits, SMS handling, the menu engine, and every screen in French, Wolof and English.

Designed and not built yet: the wallet menus themselves, the phone simulator you can click on, the agent cash-in
and cash-out, Lightning addresses, the public reserve check, the voice line. The order is in `docs/PLAN.md`.

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

I chose the referee. The Lightning part is built and tested. The engine around it is the next big phase.

Cost: a person has to press confirm, sats sit locked while they wait, and a dispute needs a human arbiter.

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

Cost: the rate can move between the screen and the payment, and rounding can be off by up to one franc.

### 13. Fees

When money comes in, the user is credited the full amount and I absorb the small routing cost to the mint. When
money goes out, the user pays the real Lightning fee, capped at 5 sats or half a percent. I measured what the mint
asks: 3 to 4 sats when it knows a route. When it does not, it asks for 1 percent and my cap refuses the payment.

Cost: on a public network that refusal may happen more often. I would rather refuse than surprise someone with a fee.

### 14. A test network, not real bitcoin

Everything runs on a private chain. Real money needs a real short code from the regulator, an operator contract,
and legal advice. None of that fits in a hackathon, and pretending otherwise would be a lie.

Cost: a judge cannot pay in from their own wallet yet. A public test network profile is in the plan.

## What I do not claim

- The Wolof was written by me and no native speaker has read it yet.
- No SMS has gone through a physical phone. The adapters are tested against the documented formats.
- No short code is live. The server speaks the protocol aggregators use, which proves the software and not the contract.
- This is not legal to run with real money in Senegal today without advice.

## Questions I expect

These answers describe the design. The section above says which parts are built.

*Is this a bank?* No. It holds small amounts for people whose phones cannot hold keys, with caps, and with a way out.

*What if your server is hacked?* The database alone is useless: notes and phone numbers are sealed with a secret that is not in it. An attacker with the running server could move what the gateway holds, which is why holdings are capped and the mint is a separate system.

*What if you run away with the money?* That is the risk of any custodian. The answer is caps, the split between mint and gateway, and a reserve check anyone can run. It lowers the risk. It does not remove it.

*Why not just use mobile money?* Mobile money stops at the border and at the operator. This lets a relative abroad pay in from any Lightning wallet, and the user can leave with their money.

*Why ecash and not Lightning for each user?* A Lightning wallet per user needs a node or a custodian per user. Ecash gives private, instant transfers inside and one Lightning connection to the outside.

*What happens if the phone is stolen?* Nothing moves without the code. Five wrong tries lock it. Limits cap what a thief could take even with the code.

*How do you know the books are right?* The vault tests end by comparing the ledger with the notes held, account by account. The long run and the crash tests also ask the mint whether those notes are still unspent.

## Words used here

- USSD: the menu system behind codes like `#144#`. Works on every phone, no data.
- Sat: one hundred-millionth of a bitcoin.
- Lightning: bitcoin's fast payment network.
- Ecash, Cashu: digital notes signed by a mint that cannot trace them.
- Mint: the service that signs and redeems the notes.
- Gateway: my server. It runs the menus and keeps the notes.
- Hold invoice: a Lightning payment that is locked until someone releases or cancels it.
- Voucher: notes locked to a code.
- Regtest: a private bitcoin network for testing.
