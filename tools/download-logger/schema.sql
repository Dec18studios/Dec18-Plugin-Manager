-- Run once to set up the database:
--   wrangler d1 execute dec18-downloads --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS downloads (
  email            TEXT NOT NULL,
  tool_slug        TEXT NOT NULL,
  tool_name        TEXT NOT NULL,
  first_downloaded TEXT NOT NULL,
  last_downloaded  TEXT NOT NULL,
  download_count   INTEGER DEFAULT 1,
  unsubscribed     INTEGER DEFAULT 0,
  -- Set to 1 by tools/demo-welcome-email.mjs after the one-time welcome email
  -- goes out, or to 2 when the address is undeliverable (junk typed into the
  -- download gate, permanent Brevo rejection) so it stops being retried hourly.
  -- Any non-zero value retires the row. Deliberately NOT reset by /log
  -- re-downloads, so nobody gets the welcome twice.
  -- (Added later via ALTER TABLE; the sender script auto-migrates.)
  welcome_sent     INTEGER DEFAULT 0,
  PRIMARY KEY (email, tool_slug)
);

CREATE INDEX IF NOT EXISTS idx_tool ON downloads(tool_slug);
CREATE INDEX IF NOT EXISTS idx_email ON downloads(email);

-- ── Newsletter campaigns ─────────────────────────────────────────────────────
-- One row per (address, campaign). Used by tools/monthly-update-announce.mjs so
-- a rerun cannot mail the same person twice. A column per campaign does not work
-- for a monthly send, and buyers who never used the download gate have no
-- downloads row to flag at all, so campaign state lives here instead.
--   state 0 = queued/attempted, 1 = sent, 2 = undeliverable, never retried
CREATE TABLE IF NOT EXISTS campaign_sends (
  email      TEXT    NOT NULL,
  campaign   TEXT    NOT NULL,
  audience   TEXT,
  state      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (email, campaign)
);

CREATE INDEX IF NOT EXISTS idx_campaign_sends_campaign
  ON campaign_sends(campaign);

-- Daily-quota accounting reads this by date, so keep it indexed.
CREATE INDEX IF NOT EXISTS idx_campaign_sends_updated
  ON campaign_sends(updated_at);

-- Written by GET|POST /newsletter-optout in worker.js. Keyed on the address only,
-- so it covers buyers with no downloads row. Suppresses every future newsletter.
CREATE TABLE IF NOT EXISTS newsletter_optouts (
  email        TEXT PRIMARY KEY,
  opted_out_at TEXT NOT NULL,
  source       TEXT
);
