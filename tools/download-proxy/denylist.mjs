#!/usr/bin/env node
/**
 * Dec 18 Studios — license key denylist admin
 *
 * The download proxy refuses any key whose SHA-256 is in the `key_denylist`
 * table (see tools/download-proxy/schema.sql). This is the revocation lever:
 * it takes effect on the next request, needs no app update, and does not
 * require re-issuing anyone's key.
 *
 * We only ever store the HASH. Reading a key back out of the denylist is
 * impossible by design — the table must not become a second copy of the
 * credentials it exists to contain.
 *
 * Usage:
 *   node denylist.mjs add <D18-key> [--reason leaked] [--email a@b.com]
 *   node denylist.mjs add-email <email> [--reason refunded]   # all their keys
 *   node denylist.mjs add-all  --reason leaked [--yes]        # ENTIRE ledger
 *   node denylist.mjs remove <D18-key>
 *   node denylist.mjs list
 *   node denylist.mjs report [--hours 24]                     # download log
 *
 * Ledger lookups read $LICENSE_LEDGER_DIR (the private license-ledger clone),
 * falling back to tools/license-keys/.
 *
 * Add --local to hit the local D1 instead of production.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_NAME = "dec18-auth";

const argv = process.argv.slice(2);
const cmd = argv[0];
const positional = argv.slice(1).filter((a) => !a.startsWith("--"));
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const hashKey = (key) => createHash("sha256").update(key.trim()).digest("hex");
const sqlStr = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

function ledgerPath() {
  const dir = process.env.LICENSE_LEDGER_DIR || join(__dirname, "..", "license-keys");
  return join(dir, "processed-subscribers.json");
}

function loadLedger() {
  const p = ledgerPath();
  if (!existsSync(p)) {
    console.error(`Ledger not found: ${p}`);
    console.error("Set LICENSE_LEDGER_DIR to your license-ledger clone (git pull it first).");
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(p, "utf8"));
  // The ledger has been through a couple of shapes; accept both.
  const rows = Array.isArray(raw) ? raw : raw.processed || raw.subscribers || [];
  return rows.filter((r) => r && r.licenseKey);
}

function d1(sql) {
  // wrangler writes D1 errors to STDOUT and exits 1 with an EMPTY stderr, so
  // never trust stderr alone to decide whether this worked.
  const args = [
    "wrangler", "d1", "execute", DB_NAME,
    has("local") ? "--local" : "--remote",
    "--json", "--command", sql,
  ];
  try {
    const out = execFileSync("npx", args, { cwd: __dirname, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const start = out.indexOf("[");
    if (start < 0) return [];
    return JSON.parse(out.slice(start))[0]?.results || [];
  } catch (err) {
    const blob = `${err.stdout || ""}${err.stderr || ""}`.trim();
    console.error("wrangler d1 failed:\n" + (blob || err.message));
    process.exit(1);
  }
}

function insertRows(rows, reason) {
  if (!rows.length) {
    console.log("Nothing to add.");
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  // Chunked so one bad row can't blow a 100-row statement, and to stay well
  // inside wrangler's command-length limit.
  for (let i = 0; i < rows.length; i += 25) {
    const chunk = rows.slice(i, i + 25);
    const values = chunk
      .map((r) => `(${sqlStr(r.hash)}, ${sqlStr(r.email)}, ${sqlStr(reason)}, ${now})`)
      .join(", ");
    d1(
      `INSERT OR REPLACE INTO key_denylist (key_hash, email, reason, created_at) VALUES ${values};`
    );
    process.stdout.write(`  ...${Math.min(i + 25, rows.length)}/${rows.length}\r`);
  }
  console.log(`\nDenylisted ${rows.length} key(s) — reason: ${reason}`);
  console.log("Effective immediately; no deploy needed.");
}

const maskEmail = (e) =>
  !e ? "(unknown)" : e.replace(/^(.).*(@.*)$/, (_, a, b) => `${a}***${b}`);

switch (cmd) {
  case "add": {
    const key = positional[0];
    if (!key?.startsWith("D18.")) {
      console.error("Expected a D18.… license key.");
      process.exit(1);
    }
    insertRows([{ hash: hashKey(key), email: flag("email") }], flag("reason", "revoked"));
    break;
  }

  case "add-email": {
    const email = positional[0]?.toLowerCase();
    if (!email) {
      console.error("Expected an email address.");
      process.exit(1);
    }
    const rows = loadLedger()
      .filter((r) => String(r.email || "").toLowerCase() === email)
      .map((r) => ({ hash: hashKey(r.licenseKey), email: r.email }));
    console.log(`${rows.length} key(s) for ${maskEmail(email)}`);
    insertRows(rows, flag("reason", "revoked"));
    break;
  }

  case "add-all": {
    const rows = loadLedger().map((r) => ({ hash: hashKey(r.licenseKey), email: r.email }));
    console.log(`This denylists ALL ${rows.length} keys in the ledger.`);
    console.log("Every existing customer's app stops downloading until they are re-issued a key.");
    if (!has("yes")) {
      console.log("\nRe-run with --yes if that is really what you want.");
      process.exit(1);
    }
    insertRows(rows, flag("reason", "leaked"));
    break;
  }

  case "remove": {
    const key = positional[0];
    if (!key?.startsWith("D18.")) {
      console.error("Expected a D18.… license key.");
      process.exit(1);
    }
    d1(`DELETE FROM key_denylist WHERE key_hash = ${sqlStr(hashKey(key))};`);
    console.log("Removed from denylist (if it was present).");
    break;
  }

  case "list": {
    const rows = d1(
      "SELECT key_hash, email, reason, created_at FROM key_denylist ORDER BY created_at DESC LIMIT 200;"
    );
    if (!rows.length) {
      console.log("Denylist is empty.");
      break;
    }
    console.log(`${rows.length} denylisted key(s):\n`);
    for (const r of rows) {
      const when = new Date((r.created_at || 0) * 1000).toISOString().slice(0, 16).replace("T", " ");
      console.log(`  ${r.key_hash.slice(0, 16)}…  ${when}  ${r.reason || "-"}  ${maskEmail(r.email)}`);
    }
    break;
  }

  case "report": {
    const hours = parseInt(flag("hours", "24"), 10);
    const since = Math.floor(Date.now() / 1000) - hours * 3600;

    const busiest = d1(
      `SELECT key_hash, email, COUNT(*) AS n, COUNT(DISTINCT ip_hash) AS ips, COUNT(DISTINCT country) AS countries
       FROM download_events WHERE ts > ${since} AND outcome = 'ok'
       GROUP BY key_hash ORDER BY n DESC LIMIT 20;`
    );
    console.log(`\nBusiest keys, last ${hours}h  (many IPs on one key = shared/leaked)\n`);
    if (!busiest.length) console.log("  (no downloads)");
    for (const r of busiest) {
      console.log(
        `  ${String(r.n).padStart(4)} dl  ${String(r.ips).padStart(3)} ip  ${String(r.countries).padStart(2)} cc   ` +
        `${r.key_hash.slice(0, 16)}…  ${maskEmail(r.email)}`
      );
    }

    const denied = d1(
      `SELECT outcome, COUNT(*) AS n FROM download_events
       WHERE ts > ${since} AND outcome != 'ok' GROUP BY outcome ORDER BY n DESC;`
    );
    console.log(`\nDenials, last ${hours}h\n`);
    if (!denied.length) console.log("  (none)");
    for (const r of denied) console.log(`  ${String(r.n).padStart(5)}  ${r.outcome}`);
    console.log("");
    break;
  }

  default:
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(2, 30).join("\n").replace(/^ \* ?/gm, ""));
    process.exit(cmd ? 1 : 0);
}
