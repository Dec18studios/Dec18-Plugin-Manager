#!/usr/bin/env node
/**
 * One-time / repeatable import of the existing processed-subscribers.json ledger
 * into the auth Worker's D1 `accounts` table.
 *
 * It decodes each stored license key to recover tier / plugins / expiry, then
 * emits SQL UPSERTs. Pipe the SQL into wrangler:
 *
 *   node import-subscribers.mjs > seed.sql
 *   wrangler d1 execute dec18-auth --local  --file=seed.sql   # local test
 *   wrangler d1 execute dec18-auth --remote --file=seed.sql   # production
 *
 * Re-running is safe: UPSERT refreshes keys/plugins/active_until without
 * clobbering first_verified_at / verify_method (those are owned by the worker).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROCESSED_PATH = join(__dirname, "..", "license-keys", "processed-subscribers.json");

function base64urlDecode(str) {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

function decodePayload(key) {
  try {
    const parts = String(key).split(".");
    if (parts.length !== 3 || parts[0] !== "D18") return null;
    return JSON.parse(base64urlDecode(parts[1]).toString("utf8"));
  } catch {
    return null;
  }
}

const sqlStr = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

function main() {
  const ledger = JSON.parse(readFileSync(PROCESSED_PATH, "utf8"));
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = [];

  for (const [emailRaw, rec] of Object.entries(ledger)) {
    const email = String(emailRaw).trim().toLowerCase();
    const key = rec.key;
    if (!key) continue;
    const payload = decodePayload(key);
    if (!payload) {
      process.stderr.write(`skip (unparseable key): ${email}\n`);
      continue;
    }
    const plugins = JSON.stringify(payload.p ?? []);
    const activeUntil = typeof payload.exp === "number" ? payload.exp : "NULL";
    const createdAt = rec.processedAt ? Math.floor(Date.parse(rec.processedAt) / 1000) || nowSec : nowSec;

    rows.push(
      `INSERT INTO accounts (email, name, keys, plugins, tier, active_until, created_at) VALUES (` +
        `${sqlStr(email)}, ${sqlStr(rec.name)}, ${sqlStr(JSON.stringify([key]))}, ` +
        `${sqlStr(plugins)}, ${sqlStr(payload.t)}, ${activeUntil}, ${createdAt}) ` +
        `ON CONFLICT(email) DO UPDATE SET ` +
        `name = excluded.name, keys = excluded.keys, plugins = excluded.plugins, ` +
        `tier = excluded.tier, active_until = excluded.active_until;`
    );
  }

  process.stdout.write(rows.join("\n") + "\n");
  process.stderr.write(`\nemitted ${rows.length} account upsert(s)\n`);
}

main();
