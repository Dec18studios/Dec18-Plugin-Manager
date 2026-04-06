#!/usr/bin/env node
/**
 * One-time backfill: regenerate license keys for all processed subscribers
 * and write them to ledger.json.
 *
 * Ed25519 signatures are deterministic — same private key + same email
 * produces the exact same key that was originally emailed.
 *
 * Usage:
 *   node tools/backfill-ledger.mjs tools/license-keys/private.pem
 */

import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROCESSED_PATH = join(__dirname, "license-keys", "processed-subscribers.json");
const LEDGER_PATH = join(__dirname, "license-keys", "ledger.json");

function base64urlEncode(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateMasterKey(privateKey, email) {
  const payload = { t: "master", e: email, p: ["*"] };
  const json = JSON.stringify(payload);
  const payloadB64 = base64urlEncode(Buffer.from(json, "utf8"));
  const signature = sign(null, Buffer.from(payloadB64, "utf8"), privateKey);
  return `D18.${payloadB64}.${base64urlEncode(signature)}`;
}

const pemPath = process.argv[2];
if (!pemPath) {
  console.error("Usage: node tools/backfill-ledger.mjs <path-to-private.pem>");
  process.exit(1);
}

const privateKey = createPrivateKey(readFileSync(pemPath, "utf8"));

// Load existing data
const processed = existsSync(PROCESSED_PATH)
  ? JSON.parse(readFileSync(PROCESSED_PATH, "utf8"))
  : {};

const ledger = existsSync(LEDGER_PATH)
  ? JSON.parse(readFileSync(LEDGER_PATH, "utf8"))
  : [];

const existingEmails = new Set(ledger.map(e => (e.email || '').toLowerCase()));

let added = 0;
for (const [email, info] of Object.entries(processed)) {
  const lowerEmail = email.toLowerCase();
  if (existingEmails.has(lowerEmail)) {
    console.log(`  skip ${lowerEmail} (already in ledger)`);
    continue;
  }

  const key = generateMasterKey(privateKey, lowerEmail);
  ledger.push({
    name: info.name || '',
    tier: 'master',
    email: lowerEmail,
    plugins: ['*'],
    key,
    generatedAt: info.processedAt || new Date().toISOString(),
  });

  // Also save the key back to processed-subscribers for reference
  info.key = key;

  console.log(`  ✓ ${lowerEmail} — ${info.name || '(no name)'}`);
  added++;
}

writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + "\n");
writeFileSync(PROCESSED_PATH, JSON.stringify(processed, null, 2) + "\n");
console.log(`\nBackfill complete: ${added} entries added to ledger.json (${ledger.length} total).`);
