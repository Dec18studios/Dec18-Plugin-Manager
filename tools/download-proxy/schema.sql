-- Dec 18 Studios — download-proxy tables
--
-- These live in the SAME D1 database as the auth worker (`dec18-auth`), because
-- the proxy needs to read the `accounts` table that auth-worker owns. Apply with:
--
--   wrangler d1 execute dec18-auth --remote --file=tools/download-proxy/schema.sql
--
-- Safe to re-run: everything is IF NOT EXISTS.

-- --------------------------------------------------------------------------
-- Revoked / burned license keys.
--
-- We store the SHA-256 of the key, never the key itself: the whole point of
-- this table is to contain a credential leak, so it must not become another
-- copy of the credentials. Compute a hash to insert with:
--
--   printf '%s' 'D18.xxx.yyy' | shasum -a 256
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS key_denylist (
  key_hash   TEXT PRIMARY KEY,   -- lowercase hex SHA-256 of the full D18 token
  email      TEXT,               -- owner, for support triage (nullable)
  reason     TEXT,               -- 'leaked', 'refunded', 'chargeback', 'abuse'
  created_at INTEGER NOT NULL    -- unix seconds
);

-- --------------------------------------------------------------------------
-- Download audit log. Doubles as the rate-limit counter (see RATE_LIMIT_* vars
-- in wrangler.toml) — one row per gated request, keyed by key_hash.
--
-- Raw client IPs are NOT stored; only a salted hash, so the log can show
-- "one key, 40 distinct machines" without retaining personal data.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS download_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT NOT NULL,
  email    TEXT,
  repo     TEXT,
  tag      TEXT,
  asset    TEXT,
  outcome  TEXT NOT NULL,        -- 'ok' | 'denied:<reason>'
  ip_hash  TEXT,                 -- SHA-256(ip + IP_HASH_SALT), truncated
  country  TEXT,
  ts       INTEGER NOT NULL      -- unix seconds
);

CREATE INDEX IF NOT EXISTS idx_download_events_key_ts ON download_events(key_hash, ts);
CREATE INDEX IF NOT EXISTS idx_download_events_ts     ON download_events(ts);
CREATE INDEX IF NOT EXISTS idx_download_events_email  ON download_events(email);
