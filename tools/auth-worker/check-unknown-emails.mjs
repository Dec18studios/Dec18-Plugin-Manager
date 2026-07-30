#!/usr/bin/env node
/**
 * Dec 18 Studios — reconcile locked-out sign-ins against Squarespace.
 *
 * Two independent detectors, both driven by the Commerce Orders API alone. No
 * webhook subscription, no Contacts API, no extra API scope — the fulfillment
 * cron's existing SQUARESPACE_API_KEY is enough.
 *
 *   drift   Every order id in the ledger is re-read from Squarespace and its
 *           CURRENT customerEmail compared to the address we filed it under.
 *           Orders API docs: customerEmail is "the email address entered at
 *           checkout or, for recurring subscription orders, the customer's
 *           current email address" — so for a subscription this changes under
 *           us when the customer edits their account. Catches a change before
 *           anyone is locked out.
 *
 *   locked  The auth worker's unknown_email_attempts table — addresses that
 *           asked for a code and had no account. Each is matched back to a
 *           known customer through Squarespace's customerId, which is stable
 *           across an email change and identical to Contact.id.
 *
 * Matching is ONLY ever by order id or customerId. Never by name: a Squarespace
 * contact is free to create (a newsletter signup will do), so linking on a name
 * match would let anyone claim a paying customer's license key.
 *
 * Reports by default and writes nothing. --apply performs the ledger migration
 * (add the new address, keep the old — see workflow docs) and prints the D1
 * statement to run; it never deletes anything.
 *
 * Usage:
 *   SQUARESPACE_API_KEY=… LICENSE_LEDGER_DIR=… node check-unknown-emails.mjs
 *   … node check-unknown-emails.mjs --apply
 *   … node check-unknown-emails.mjs --skip-d1        # drift detector only
 *
 * Emails are masked when $CI is set (workflow logs on this repo are public);
 * pass --reveal to force full addresses.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_NAME = "dec18-auth";
const TARGET_PRODUCT = "Happy Little Noders";

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const APPLY = has("apply");
const REVEAL = has("reveal") || !process.env.CI;

// --apply prints a wrangler command containing the raw license key and address,
// which masking does not cover. This repo is public and so are its workflow
// logs, so --apply is a human-run local action only.
if (APPLY && process.env.CI) {
  console.error("--apply is refused under CI: it prints an unmasked license key. Run it locally.");
  process.exit(1);
}

const LEDGER_DIR = process.env.LICENSE_LEDGER_DIR || join(__dirname, "..", "license-keys");
const PROCESSED_PATH = join(LEDGER_DIR, "processed-subscribers.json");

// Test seams, both unset in production. SQUARESPACE_API_BASE points the Orders
// fetch at a local fixture server; UNKNOWN_EMAILS_FIXTURE substitutes a JSON
// file for the wrangler call. See test-check-unknown-emails.mjs.
const SQSP_BASE = process.env.SQUARESPACE_API_BASE || "https://api.squarespace.com";
const D1_FIXTURE = process.env.UNKNOWN_EMAILS_FIXTURE || "";

const mask = (e) => (REVEAL ? e : String(e).replace(/^(.).*(@.*)$/, "$1***$2"));
const sqlStr = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const norm = (e) => String(e || "").trim().toLowerCase();

// ── Squarespace ────────────────────────────────────────────────────

async function fetchOrders(apiKey) {
  const orders = [];
  let cursor = null;
  for (;;) {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${SQSP_BASE}/1.0/commerce/orders?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`Squarespace Orders API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    for (const o of data.result ?? []) {
      if ((o.lineItems ?? []).some((li) => li.productName === TARGET_PRODUCT)) orders.push(o);
    }
    if (data.pagination?.hasNextPage && data.pagination.nextPageCursor) {
      cursor = data.pagination.nextPageCursor;
    } else break;
  }
  return orders;
}

// ── D1 ─────────────────────────────────────────────────────────────

function d1Query(sql) {
  if (D1_FIXTURE) return JSON.parse(readFileSync(D1_FIXTURE, "utf8"));
  // wrangler writes D1 errors to STDOUT and exits 1 with an EMPTY stderr, so
  // never trust a quiet stderr as success.
  const args = ["wrangler", "d1", "execute", DB_NAME, "--remote", "--json", "--command", sql];
  let out;
  try {
    out = execFileSync("npx", args, { cwd: __dirname, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const blob = `${err.stdout || ""}${err.stderr || ""}`.trim();
    throw new Error(`wrangler d1 failed:\n${blob || err.message}`);
  }
  const start = out.indexOf("[");
  if (start < 0) throw new Error(`unexpected wrangler output:\n${out}`);
  return JSON.parse(out.slice(start))[0]?.results ?? [];
}

// ── Ledger ─────────────────────────────────────────────────────────

function loadProcessed() {
  if (!existsSync(PROCESSED_PATH)) {
    console.error(`Ledger not found: ${PROCESSED_PATH}`);
    console.error("Set LICENSE_LEDGER_DIR to your license-ledger clone (git pull it first).");
    process.exit(1);
  }
  return JSON.parse(readFileSync(PROCESSED_PATH, "utf8"));
}

/**
 * Add `newEmail` as its own entry carrying the same key, keeping the old one.
 *
 * Never a rename. fulfill-licenses.mjs dedupes on processed[customerEmail], so
 * both must be present for neither address to re-trigger issuance; and the key's
 * signed `e` claim is still the old address, which the download proxy gates on.
 */
function migrate(processed, oldEmail, newEmail, stamp) {
  const rebuilt = {};
  for (const [k, v] of Object.entries(processed)) {
    if (k === oldEmail) {
      rebuilt[k] = { ...v, emailChangedTo: newEmail, emailChangedAt: stamp };
      rebuilt[newEmail] = { ...v, emailChangedFrom: oldEmail, emailChangedAt: stamp };
    } else if (k !== newEmail) {
      rebuilt[k] = v;
    }
  }
  return rebuilt;
}

function upsertSql(email, rec) {
  const payload = (() => {
    try {
      const b = rec.key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(Buffer.from(b, "base64").toString("utf8"));
    } catch {
      return {};
    }
  })();
  const createdAt = rec.processedAt ? Math.floor(Date.parse(rec.processedAt) / 1000) : Math.floor(Date.now() / 1000);
  return (
    `INSERT INTO accounts (email, name, keys, plugins, tier, active_until, created_at) VALUES (` +
    `${sqlStr(email)}, ${sqlStr(rec.name)}, ${sqlStr(JSON.stringify([rec.key]))}, ` +
    `${sqlStr(JSON.stringify(payload.p ?? []))}, ${sqlStr(payload.t)}, ` +
    `${typeof payload.exp === "number" ? payload.exp : "NULL"}, ${createdAt}) ` +
    `ON CONFLICT(email) DO UPDATE SET name = excluded.name, keys = excluded.keys, ` +
    `plugins = excluded.plugins, tier = excluded.tier, active_until = excluded.active_until;`
  );
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.SQUARESPACE_API_KEY;
  if (!apiKey) {
    console.error("SQUARESPACE_API_KEY is required.");
    process.exit(1);
  }

  let processed = loadProcessed();
  const orders = await fetchOrders(apiKey);
  console.log(`${orders.length} ${TARGET_PRODUCT} order(s); ${Object.keys(processed).length} ledger entries.\n`);

  // orderId -> the address we filed it under, and customerId -> those addresses.
  const ledgerByOrder = new Map();
  const ledgerByCustomer = new Map();
  for (const [email, rec] of Object.entries(processed)) {
    if (rec?.orderId) ledgerByOrder.set(rec.orderId, norm(email));
  }
  for (const o of orders) {
    const known = ledgerByOrder.get(o.id);
    if (known && o.customerId) {
      if (!ledgerByCustomer.has(o.customerId)) ledgerByCustomer.set(o.customerId, new Set());
      ledgerByCustomer.get(o.customerId).add(known);
    }
  }

  const migrations = new Map(); // newEmail -> {oldEmail, orderId, why}

  // ── Detector 1: drift ────────────────────────────────────────────
  console.log("── drift: ledger address vs Squarespace's current customerEmail ──");
  let drift = 0;
  for (const o of orders) {
    const filedUnder = ledgerByOrder.get(o.id);
    const current = norm(o.customerEmail);
    if (!filedUnder || !current || current === filedUnder) continue;
    if (processed[current]) continue; // already migrated
    drift++;
    console.log(`  order ${o.orderNumber}: ${mask(filedUnder)} -> ${mask(current)}`);
    migrations.set(current, { oldEmail: filedUnder, orderId: o.id, why: `order ${o.orderNumber} now reports it` });
  }
  if (!drift) console.log("  none");

  // ── Detector 2: locked-out sign-ins ──────────────────────────────
  if (!has("skip-d1")) {
    console.log("\n── locked out: unknown_email_attempts vs Squarespace customerId ──");
    let rows = [];
    try {
      rows = d1Query(
        "SELECT email, attempts, first_ts, last_ts, status FROM unknown_email_attempts " +
          "WHERE status != 'resolved' ORDER BY attempts DESC, last_ts DESC LIMIT 200;"
      );
    } catch (err) {
      console.log(`  (skipped — ${err.message.split("\n")[0]})`);
      rows = null;
    }
    if (rows && !rows.length) console.log("  none");
    for (const r of rows ?? []) {
      const email = norm(r.email);
      const age = new Date(r.last_ts * 1000).toISOString().slice(0, 10);
      // Which Squarespace customer currently owns this address?
      const theirOrder = orders.find((o) => norm(o.customerEmail) === email);
      const owners = theirOrder?.customerId ? ledgerByCustomer.get(theirOrder.customerId) : null;
      const oldEmail = [...(owners ?? [])].find((e) => e !== email);

      if (oldEmail) {
        console.log(`  MATCH  ${mask(email)}  (${r.attempts}x, last ${age})  <- ${mask(oldEmail)}`);
        console.log(`         same Squarespace customerId on order ${theirOrder.orderNumber}`);
        if (!migrations.has(email)) {
          migrations.set(email, { oldEmail, orderId: theirOrder.id, why: `shares customerId with ${mask(oldEmail)}` });
        }
      } else if (theirOrder) {
        console.log(`  ORDER  ${mask(email)}  (${r.attempts}x, last ${age}) — has an order we never filed; check fulfillment`);
      } else {
        console.log(`  NONE   ${mask(email)}  (${r.attempts}x, last ${age}) — no ${TARGET_PRODUCT} order; typo or never purchased`);
      }
    }
  }

  // ── Report / apply ───────────────────────────────────────────────
  if (!migrations.size) {
    console.log("\nNothing to migrate.");
    return;
  }

  console.log(`\n${migrations.size} migration(s) available:`);
  for (const [newEmail, m] of migrations) {
    console.log(`  ${mask(m.oldEmail)} -> ${mask(newEmail)}   (${m.why})`);
  }

  if (!APPLY) {
    console.log("\nReport only. Re-run with --apply to write the ledger and emit the D1 statement.");
    return;
  }

  const stamp = new Date().toISOString();
  const sql = [];
  for (const [newEmail, m] of migrations) {
    const rec = processed[m.oldEmail];
    if (!rec?.key) {
      console.log(`  skip ${mask(newEmail)} — no key on the ledger entry for ${mask(m.oldEmail)}`);
      continue;
    }
    processed = migrate(processed, m.oldEmail, newEmail, stamp);
    sql.push(upsertSql(newEmail, processed[newEmail]));
  }
  writeFileSync(PROCESSED_PATH, JSON.stringify(processed, null, 2) + "\n");
  console.log(`\nWrote ${PROCESSED_PATH} — commit and push the license-ledger repo.`);
  console.log("\nThen grant OTP access (the old rows are left in place deliberately):\n");
  for (const s of sql) console.log(`npx wrangler d1 execute ${DB_NAME} --remote --command "${s.replace(/"/g, '\\"')}"\n`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
