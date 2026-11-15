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
];
