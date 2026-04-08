#!/usr/bin/env node

/**
 * Generate a license key manually.
 *
 * Usage:
 *   node tools/generate-license-key.mjs --tier master --email user@example.com
 *   node tools/generate-license-key.mjs --tier photochemist --email user@example.com
 *   node tools/generate-license-key.mjs --tier photochemist --email user@example.com --plugins photochemist,dasgrain
 *
 * Tiers:
 *   master       → unlocks ALL current and future plugins
 *   <pluginId>   → unlocks only that plugin (or use --plugins for multiple)
 *
 * Each key is appended to tools/license-keys/ledger.json for record-keeping.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { loadPrivateKey, generateLicenseKey } from "./license-crypto.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tier") args.tier = argv[++i];
    if (argv[i] === "--email") args.email = argv[++i];
    if (argv[i] === "--name") args.name = argv[++i];
    if (argv[i] === "--plugins") args.plugins = argv[++i].split(",");
    if (argv[i] === "--expiry") args.expiry = argv[++i]; // days or "none"
  }
  return args;
}

/** Calculate unix-seconds expiration from tier, or explicit --expiry days. */
function expirationForTier(tier, expiryOverride) {
  if (expiryOverride === "none") return null;
  if (expiryOverride) return Math.floor(Date.now() / 1000) + parseInt(expiryOverride, 10) * 86400;
  const now = Math.floor(Date.now() / 1000);
  if (tier === "free")   return now + 30 * 86400;
  if (tier === "annual") return now + 365 * 86400;
  return null; // master = permanent
}

const args = parseArgs(process.argv.slice(2));

if (!args.tier || !args.email) {
  console.error(
    "Usage: node tools/generate-license-key.mjs --tier <master|free|annual|pluginId> --email <email> [--name \"Full Name\"] [--plugins p1,p2] [--expiry <days|none>]"
  );
  console.error("");
  console.error("Tiers:  master (permanent), annual (365 days), free (30 days), <pluginId>");
  console.error("");
  console.error("Examples:");
  console.error("  node tools/generate-license-key.mjs --tier master --email fan@example.com --name \"Jane Doe\"");
  console.error("  node tools/generate-license-key.mjs --tier free --email trial@example.com");
  console.error("  node tools/generate-license-key.mjs --tier annual --email buyer@example.com");
  console.error("  node tools/generate-license-key.mjs --tier annual --email vip@example.com --expiry 730");
  process.exit(1);
}

const privateKeyPath = join(__dirname, "license-keys", "private.pem");
if (!existsSync(privateKeyPath)) {
  console.error("Private key not found. Generate it first:");
  console.error("  node tools/license-keygen.mjs");
  process.exit(1);
}

const privateKey = loadPrivateKey(privateKeyPath);
const plugins = (args.tier === "master" || args.tier === "annual") ? ["*"] : (args.plugins ?? [args.tier]);

const exp = expirationForTier(args.tier, args.expiry);
const payload = {
  t: args.tier,
  e: args.email.trim().toLowerCase(),
  p: plugins,
};
if (exp) payload.exp = exp;

const key = generateLicenseKey(privateKey, payload);

console.log("");
console.log("═══════════════════════════════════════════════════════════");
console.log("  LICENSE KEY");
console.log("═══════════════════════════════════════════════════════════");
console.log("");
console.log(key);
console.log("");
console.log("  Tier:     ", payload.t);
console.log("  Email:    ", payload.e);
if (args.name) console.log("  Name:     ", args.name);
console.log("  Plugins:  ", payload.p.join(", "));
if (exp) console.log("  Expires:  ", new Date(exp * 1000).toISOString().slice(0, 10));
else console.log("  Expires:   never (permanent)");
console.log("═══════════════════════════════════════════════════════════");

// Append to ledger
const ledgerPath = join(__dirname, "license-keys", "ledger.json");
let ledger = [];
if (existsSync(ledgerPath)) {
  ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
}
const ledgerEntry = { tier: payload.t, email: payload.e, plugins: payload.p, key, generatedAt: new Date().toISOString() };
if (args.name) ledgerEntry.name = args.name;
if (exp) ledgerEntry.expiresAt = new Date(exp * 1000).toISOString();
ledger.push(ledgerEntry);
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n", "utf8");
console.log(`\nAppended to ledger (${ledger.length} total keys issued)`);
