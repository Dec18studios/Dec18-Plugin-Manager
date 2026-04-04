#!/usr/bin/env node

/**
 * Generate an Ed25519 key pair for license signing.
 * Run once:  node tools/license-keygen.mjs
 *
 * Outputs:
 *   tools/license-keys/private.pem  (KEEP SECRET — gitignored)
 *   tools/license-keys/public.pem   (committed, embedded in app)
 *   tools/license-keys/public.b64   (SPKI DER as base64, for JS embedding)
 */

import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const keysDir = join(__dirname, "license-keys");
mkdirSync(keysDir, { recursive: true });

const privatePath = join(keysDir, "private.pem");
if (existsSync(privatePath)) {
  console.error("Key pair already exists at", keysDir);
  console.error("Delete the files manually if you want to regenerate.");
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

writeFileSync(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), "utf8");
writeFileSync(join(keysDir, "public.pem"), publicKey.export({ type: "spki", format: "pem" }), "utf8");

const pubDer = publicKey.export({ type: "spki", format: "der" });
writeFileSync(join(keysDir, "public.b64"), pubDer.toString("base64"), "utf8");

console.log("Key pair generated:");
console.log(`  Private: ${privatePath}`);
console.log(`  Public:  ${join(keysDir, "public.pem")}`);
console.log(`  Public (base64 SPKI DER): ${join(keysDir, "public.b64")}`);
console.log("");
console.log("⚠️  Keep private.pem SECRET. It is gitignored.");
console.log("Copy the contents of public.b64 into src/main.js LICENSE_PUBLIC_KEY.");
