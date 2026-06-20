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
