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
