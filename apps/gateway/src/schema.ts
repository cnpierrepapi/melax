// The gateway's own tables. The ledger and the vault bring theirs (ledgerMigrations, vaultMigrations).
// Contract: migrations are append-only. Never edit one that has been applied: add gateway/002-... instead.
// Timestamps are BIGINT epoch milliseconds. Money is BIGINT whole sats or BIGINT whole FCFA.
// Callers: main.ts (migrate on boot), tests.
import type { Migration } from "@melax/ledger";

export const gatewayMigrations: Migration[] = [
  {
    name: "gateway/001-init",
    sql: [
      // phone_hmac finds a user by number. phone_sealed is the number itself, readable only with the
      // server pepper. phone_masked (77*****67) is what screens and receipts show.
      `CREATE TABLE users (
         id TEXT PRIMARY KEY,
         phone_hmac BYTEA NOT NULL UNIQUE,
         phone_sealed BYTEA NOT NULL,
         phone_masked TEXT NOT NULL,
         name TEXT NOT NULL,
         alias TEXT NOT NULL UNIQUE,
         lang TEXT NOT NULL CHECK (lang IN ('fr', 'wo', 'en')),
         role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'merchant', 'agent')),
         pin_hash TEXT NOT NULL,
         pin_fail_count INT NOT NULL DEFAULT 0,
         pin_locked_until BIGINT NOT NULL DEFAULT 0,
         frozen_until BIGINT NOT NULL DEFAULT 0,
         created_at BIGINT NOT NULL
       )`,
      // One row per side of a movement. amount_* are signed: negative when the money left this user.
      // `spend` marks the rows that count toward the day and month limits. `ref` is the vault operation.
      `CREATE TABLE txlog (
         id BIGSERIAL PRIMARY KEY,
         user_id TEXT NOT NULL REFERENCES users(id),
         ts BIGINT NOT NULL,
         kind TEXT NOT NULL,
         amount_sat BIGINT NOT NULL,
         amount_fcfa BIGINT NOT NULL,
         counterparty TEXT NOT NULL,
         counterparty_id TEXT,
         receipt_no BIGINT NOT NULL,
         ref TEXT NOT NULL,
         spend BOOLEAN NOT NULL DEFAULT FALSE
       )`,
      `CREATE INDEX txlog_user ON txlog(user_id, id DESC)`,
      `CREATE INDEX txlog_spend ON txlog(user_id, ts) WHERE spend`,
      `CREATE INDEX txlog_ref ON txlog(ref)`,
      // Receipt numbers start at 1001. A rolled-back transaction leaves a gap, never a duplicate.
      `CREATE SEQUENCE receipt_no START 1001 OWNED BY txlog.receipt_no`,
      // The text is sealed because it can hold a voucher code. After a real send it is deleted;
      // in demo mode it is kept so the web simulator can show the message.
      `CREATE TABLE sms_outbox (
         id BIGSERIAL PRIMARY KEY,
         to_hmac BYTEA NOT NULL,
         to_sealed BYTEA NOT NULL,
         body_sealed BYTEA,
         kind TEXT NOT NULL,
         status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed')),
         adapter TEXT,
         attempts INT NOT NULL DEFAULT 0,
         next_at BIGINT NOT NULL DEFAULT 0,
         created_at BIGINT NOT NULL,
         sent_at BIGINT,
         error TEXT
       )`,
      `CREATE INDEX sms_outbox_due ON sms_outbox(status, next_at, id)`,
      `CREATE INDEX sms_outbox_to ON sms_outbox(to_hmac, id)`,
      `CREATE TABLE price_cache (
         id INT PRIMARY KEY CHECK (id = 1),
         xof_per_btc BIGINT NOT NULL CHECK (xof_per_btc > 0),
         source TEXT NOT NULL,
         fetched_at BIGINT NOT NULL
       )`,
      // Created now so later phases only add rows: the operator's audit trail and the feature flags
      // (kill switch included) are first written in phase 9.
      `CREATE TABLE audit_log (
         id BIGSERIAL PRIMARY KEY,
         ts BIGINT NOT NULL,
         actor TEXT NOT NULL,
         action TEXT NOT NULL,
         subject TEXT,
         data JSONB NOT NULL DEFAULT '{}'::jsonb
       )`,
      `CREATE TABLE flags (
         name TEXT PRIMARY KEY,
         value JSONB NOT NULL,
         updated_at BIGINT NOT NULL
       )`,
    ],
  },
  {
    name: "gateway/002-agents",
    sql: [
      // An agent is a user with a mobile-money account and a Lightning wallet of their own. The
      // mobile-money number is sealed (purpose agent:momo:<userId>); the masked copy is for screens.
      // wallet_kind 'world' is the regtest node that plays everybody else (demo only); 'nwc' is a
      // wallet linked by Nostr Wallet Connect, its connection string sealed (purpose agent:wallet:<userId>).
      `CREATE TABLE agents (
         user_id TEXT PRIMARY KEY REFERENCES users(id),
         momo_sealed BYTEA NOT NULL,
         momo_masked TEXT NOT NULL,
         method TEXT NOT NULL CHECK (method IN ('wave', 'om', 'free', 'cash')),
         premium_bp INT NOT NULL CHECK (premium_bp >= 0 AND premium_bp <= 1000),
         min_fcfa BIGINT NOT NULL CHECK (min_fcfa > 0),
         max_fcfa BIGINT NOT NULL CHECK (max_fcfa >= min_fcfa),
         active BOOLEAN NOT NULL DEFAULT TRUE,
         wallet_kind TEXT NOT NULL CHECK (wallet_kind IN ('world', 'nwc')),
         wallet_sealed BYTEA,
         created_at BIGINT NOT NULL
       )`,
      // One row per cash-in or cash-out. `state` moves only as escrow/trade.ts allows, with
      // UPDATE ... WHERE state = <current>. The preimage of a cash-in's hold invoice is sealed
      // (purpose trade:preimage:<id>) and leaves the table in one function, the one that settles.
      // deadline_at is when the current wait ends (or when a retry is due). hard_cap_at: a held
      // cash-in payment is released by then whatever happens. watch: a closed cash-in whose invoice
      // is still watched, so a payment that arrives late is cancelled on sight.
      `CREATE TABLE trades (
         id TEXT PRIMARY KEY,
         ref TEXT NOT NULL UNIQUE,
         idem_key TEXT NOT NULL UNIQUE,
         kind TEXT NOT NULL CHECK (kind IN ('cashin', 'cashout')),
         state TEXT NOT NULL,
         user_id TEXT NOT NULL REFERENCES users(id),
         agent_id TEXT NOT NULL REFERENCES agents(user_id),
         fcfa BIGINT NOT NULL CHECK (fcfa > 0),
         sats BIGINT NOT NULL CHECK (sats > 0),
         lock_sats BIGINT NOT NULL CHECK (lock_sats >= sats),
         rate BIGINT NOT NULL CHECK (rate > 0),
         method TEXT NOT NULL,
         payment_hash TEXT UNIQUE,
         preimage_sealed BYTEA,
         bolt11 TEXT,
         invoice_expires_at BIGINT,
         held_at BIGINT,
         deadline_at BIGINT NOT NULL,
         hard_cap_at BIGINT,
         attempt INT NOT NULL DEFAULT 0,
         watch BOOLEAN NOT NULL DEFAULT FALSE,
         winner TEXT CHECK (winner IN ('user', 'agent')),
         created_at BIGINT NOT NULL,
         updated_at BIGINT NOT NULL
       )`,
      // One open trade per user: a second start loses on this index, whatever the timing.
      `CREATE UNIQUE INDEX trades_one_open ON trades(user_id) WHERE state NOT IN ('done', 'expired', 'rejected', 'refunded', 'failed')`,
      `CREATE INDEX trades_agent ON trades(agent_id, state)`,
      `CREATE INDEX trades_due ON trades(state, deadline_at)`,
      `CREATE INDEX trades_watch ON trades(watch) WHERE watch`,
    ],
  },
];
