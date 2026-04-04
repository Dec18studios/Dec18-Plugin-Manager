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
    if (argv[i] === "--plugins") args.plugins = argv[++i].split(",");
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!args.tier || !args.email) {
  console.error(
    "Usage: node tools/generate-license-key.mjs --tier <master|pluginId> --email <email> [--plugins p1,p2]"
  );
  console.error("");
  console.error("Examples:");
  console.error("  node tools/generate-license-key.mjs --tier master --email fan@example.com");
  console.error(
    "  node tools/generate-license-key.mjs --tier photochemist --email buyer@example.com"
  );
  process.exit(1);
}

const privateKeyPath = join(__dirname, "license-keys", "private.pem");
if (!existsSync(privateKeyPath)) {
  console.error("Private key not found. Generate it first:");
  console.error("  node tools/license-keygen.mjs");
  process.exit(1);
}

const privateKey = loadPrivateKey(privateKeyPath);
const plugins = args.tier === "master" ? ["*"] : (args.plugins ?? [args.tier]);

const payload = {
  tier: args.tier,
  email: args.email.trim().toLowerCase(),
  plugins,
  issuedAt: new Date().toISOString(),
};

const key = generateLicenseKey(privateKey, payload);

console.log("");
console.log("═══════════════════════════════════════════════════════════");
console.log("  LICENSE KEY");
console.log("═══════════════════════════════════════════════════════════");
console.log("");
console.log(key);
console.log("");
console.log("  Tier:     ", payload.tier);
console.log("  Email:    ", payload.email);
console.log("  Plugins:  ", payload.plugins.join(", "));
console.log("  Issued:   ", payload.issuedAt);
console.log("═══════════════════════════════════════════════════════════");

// Append to ledger
const ledgerPath = join(__dirname, "license-keys", "ledger.json");
let ledger = [];
if (existsSync(ledgerPath)) {
  ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
}
ledger.push({ ...payload, key, generatedAt: new Date().toISOString() });
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n", "utf8");
console.log(`\nAppended to ledger (${ledger.length} total keys issued)`);
