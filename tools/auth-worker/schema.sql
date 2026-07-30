-- Dec 18 Studios — Auth Worker (email OTP) schema for Cloudflare D1.
--
-- Apply locally:   wrangler d1 execute dec18-auth --local  --file=schema.sql
-- Apply to prod:   wrangler d1 execute dec18-auth --remote --file=schema.sql
--
-- Storage model:
--   accounts             — the entitlement ledger (email -> license keys). Source of
--                          truth the OTP gate checks against. Seeded from the existing
--                          processed-subscribers.json and kept current by fulfillment.
--   verification_events  — append-only analytics log. Every successful verification
--                          writes a row so we can answer "who completed email
--                          verification?" (method='otp') vs "who just has a key?"
--                          (method='silent_key').
--   otp_codes            — ephemeral: one active 6-digit code per email (hashed).
--   rate_limits          — ephemeral: per-email / per-IP counters with a window.
--   unknown_email_attempts
--                        — someone asked for a code on an address with no account. Until
--                          this existed the request was answered and then forgotten, so a
--                          customer who changed their email was invisible to us until they
--                          emailed support. One row per address, counted, not append-only.
--
-- otp_codes and rate_limits are ephemeral and could later move to KV; they live in D1
-- for now so the whole flow needs a single binding and is trivially testable.

CREATE TABLE IF NOT EXISTS accounts (
  email             TEXT PRIMARY KEY,          -- always lowercased / trimmed
  name              TEXT,
  keys              TEXT NOT NULL DEFAULT '[]',-- JSON array of "D18..." license strings
  plugins           TEXT NOT NULL DEFAULT '[]',-- JSON array; ["*"] = all plugins
  tier              TEXT,                      -- last/highest tier seen for this email
  active_until      INTEGER,                   -- unix seconds; NULL = perpetual
  created_at        INTEGER NOT NULL,
  first_verified_at INTEGER,                   -- first successful OTP (NULL until proven)
  verify_method     TEXT,                      -- 'otp' | 'silent_key' | NULL
  last_seen_at      INTEGER
);

CREATE TABLE IF NOT EXISTS verification_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  email     TEXT NOT NULL,
  device_id TEXT,
  method    TEXT NOT NULL,                     -- 'otp' | 'silent_key'
  ts        INTEGER NOT NULL,
  ip_hash   TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_email ON verification_events (email);
CREATE INDEX IF NOT EXISTS idx_events_ts    ON verification_events (ts);

CREATE TABLE IF NOT EXISTS otp_codes (
  email      TEXT PRIMARY KEY,                 -- one active code per email
  code_hash  TEXT NOT NULL,                    -- SHA-256(code + email + pepper), hex
  expires_at INTEGER NOT NULL,                 -- unix seconds
  attempts   INTEGER NOT NULL DEFAULT 0,       -- verify attempts; burned at MAX_ATTEMPTS
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  scope      TEXT PRIMARY KEY,                 -- e.g. 'start:email:foo@bar' / 'start:ip:<hash>'
  count      INTEGER NOT NULL DEFAULT 0,
  window_end INTEGER NOT NULL                  -- unix seconds; row is stale past this
);

-- Keyed by email (not append-only) so a probing attacker cannot grow this without
-- bound: repeat attempts bump a counter instead of adding rows, and handleStart's
-- per-IP + per-email rate limits run BEFORE the insert. The count is also the useful
-- signal — one hit is a typo, five over two days is a real person locked out.
CREATE TABLE IF NOT EXISTS unknown_email_attempts (
  email          TEXT PRIMARY KEY,             -- always lowercased / trimmed
  attempts       INTEGER NOT NULL DEFAULT 1,
  first_ts       INTEGER NOT NULL,
  last_ts        INTEGER NOT NULL,
  last_ip_hash   TEXT,
  last_device_id TEXT,
  -- 'new'      — not yet cross-checked against Squarespace
  -- 'match'    — Squarespace contact owns an order already in our ledger: email change
  -- 'contact'  — known to Squarespace but no matching order: newsletter signup, not a buyer
  -- 'unknown'  — Squarespace has never heard of them: typo or someone who never purchased
  -- 'resolved' — dealt with; a fresh attempt reopens it as 'new'
  status         TEXT NOT NULL DEFAULT 'new',
  checked_ts     INTEGER,                      -- last Squarespace cross-check
  sq_contact_id  TEXT,                         -- Contact.id == Order.customerId
  matched_email  TEXT,                         -- the OLD address, when status='match'
  matched_order  TEXT,                         -- the order id that proved it
  note           TEXT
);
CREATE INDEX IF NOT EXISTS idx_unknown_last_ts ON unknown_email_attempts (last_ts);
CREATE INDEX IF NOT EXISTS idx_unknown_status  ON unknown_email_attempts (status);
