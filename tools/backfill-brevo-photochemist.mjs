#!/usr/bin/env node
/*
 * backfill-brevo-photochemist.mjs
 *
 * One-shot: push existing PhotoChemist-demo downloaders into a Brevo list so the
 * welcome+tips automation fires for people who downloaded before the auto-sync
 * (worker /log) was live.
 *
 * Pipeline:
 *   1. GET download-logger /export?secret=  → CSV of every download event
 *   2. keep rows where tool_slug == photochemist-demo AND unsubscribed == 0
 *   3. best-effort FIRSTNAME from ledger.json (purchasers only; skipped if absent)
 *   4. POST /v3/contacts to Brevo  (updateEnabled:true → idempotent upsert)
 *
 * Secrets (never pass on the command line / never commit):
 *   - download-logger admin secret:  tools/license-keys/download-logger-secret.txt
 *   - Brevo v3 API key (xkeysib-…):  env BREVO_API_KEY  OR
 *                                    tools/license-keys/brevo-api-key.txt
 *
 * Usage:
 *   node tools/backfill-brevo-photochemist.mjs --dry-run   # preview, no writes
 *   node tools/backfill-brevo-photochemist.mjs             # live upsert
 *   node tools/backfill-brevo-photochemist.mjs --list 3 --slug photochemist-demo
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = join(__dirname, "license-keys");

const DL_WORKER_URL = "https://dec18-download-logger.dec18studios.workers.dev";
const BREVO_CONTACTS_URL = "https://api.brevo.com/v3/contacts";

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
function argVal(flag, dflt) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const LIST_ID = Number(argVal("--list", "3"));
const SLUG = argVal("--slug", "photochemist-demo");

// ── secrets ───────────────────────────────────────────────────────────────────
function readSecretFile(path) {
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}
const DL_SECRET = readSecretFile(join(KEYS_DIR, "download-logger-secret.txt"));
const BREVO_KEY =
  (process.env.BREVO_API_KEY || "").trim() ||
  readSecretFile(join(KEYS_DIR, "brevo-api-key.txt"));

if (!DL_SECRET) {
  console.error("✖ Missing download-logger admin secret (tools/license-keys/download-logger-secret.txt).");
  process.exit(1);
}
if (!DRY_RUN && !BREVO_KEY) {
  console.error("✖ Missing Brevo API key. Set env BREVO_API_KEY or create tools/license-keys/brevo-api-key.txt (xkeysib-…).");
  process.exit(1);
}

// ── minimal RFC-4180 CSV parser (handles "" escaping + quoted commas) ──────────
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ── best-effort name enrichment from the ledger ────────────────────────────────
// Ledger files live in the private license-ledger repo (LICENSE_LEDGER_DIR
// points at a clone); legacy in-repo path is the fallback. Enrichment stays
// optional — missing files are silently skipped.
const LEDGER_DIR = process.env.LICENSE_LEDGER_DIR || KEYS_DIR;
function loadLedgerNames() {
  const map = new Map();
  try {
    const path = join(LEDGER_DIR, "ledger.json");
    if (existsSync(path)) {
      const ledger = JSON.parse(readFileSync(path, "utf8"));
      const entries = Array.isArray(ledger) ? ledger : ledger.entries || [];
      for (const e of entries) {
        if (e && e.email && e.name) map.set(e.email.trim().toLowerCase(), e.name.trim());
      }
    }
  } catch { /* ignore — enrichment is optional */ }
  try {
    const subsPath = join(LEDGER_DIR, "processed-subscribers.json");
    if (existsSync(subsPath)) {
      const subs = JSON.parse(readFileSync(subsPath, "utf8"));
      for (const [email, rec] of Object.entries(subs)) {
        if (rec && rec.name && !map.has(email.trim().toLowerCase())) {
          map.set(email.trim().toLowerCase(), String(rec.name).trim());
        }
      }
    }
  } catch { /* ignore — enrichment is optional */ }
  return map;
}

async function main() {
  console.log(`\nBrevo backfill — list #${LIST_ID}, tool "${SLUG}"${DRY_RUN ? "  (DRY RUN)" : ""}\n`);

  // 1. pull the export CSV
  const res = await fetch(`${DL_WORKER_URL}/export?secret=${encodeURIComponent(DL_SECRET)}`);
  if (!res.ok) {
    console.error(`✖ /export failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const csv = await res.text();
  const rows = parseCSV(csv);
  const header = rows.shift() || [];
  const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));

  // 2. filter to our tool, not unsubscribed
  const targets = rows
    .filter((r) => r.length > 1)
    .filter((r) => (r[col.tool_slug] || "").trim() === SLUG)
    .filter((r) => String(r[col.unsubscribed] || "0").trim() !== "1");

  const names = loadLedgerNames();

  const contacts = targets.map((r) => {
    const email = (r[col.email] || "").trim().toLowerCase();
    const full = names.get(email) || "";
    const firstName = full ? full.split(/\s+/)[0] : "";
    return { email, firstName, downloads: r[col.download_count], last: r[col.last_downloaded] };
  });

  console.log(`Found ${contacts.length} ${SLUG} contact(s) eligible (non-unsubscribed):\n`);
  for (const c of contacts) {
    const masked = c.email.replace(/^(.).*(@.*)$/, "$1***$2");
    console.log(`  ${masked.padEnd(28)} name:${c.firstName || "—"}  dls:${c.downloads}  last:${(c.last || "").slice(0, 10)}`);
  }
  console.log("");

  if (DRY_RUN) {
    console.log("Dry run — nothing sent to Brevo. Re-run without --dry-run to upsert.\n");
    return;
  }

  // 4. upsert each into Brevo
  let created = 0, updated = 0, failed = 0;
  for (const c of contacts) {
    const body = {
      email: c.email,
      listIds: [LIST_ID],
      updateEnabled: true,
      ...(c.firstName ? { attributes: { FIRSTNAME: c.firstName } } : {}),
    };
    const r = await fetch(BREVO_CONTACTS_URL, {
      method: "POST",
      headers: { "api-key": BREVO_KEY, "accept": "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.status === 201) { created++; console.log(`  + created  ${c.email}`); }
    else if (r.status === 204) { updated++; console.log(`  ~ updated  ${c.email}`); }
    else {
      failed++;
      let detail = "";
      try { detail = JSON.stringify(await r.json()); } catch {}
      console.log(`  ✖ ${r.status}   ${c.email}  ${detail}`);
    }
    await new Promise((res) => setTimeout(res, 150)); // gentle pacing
  }

  console.log(`\nDone. created:${created}  updated:${updated}  failed:${failed}  (list #${LIST_ID})\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
