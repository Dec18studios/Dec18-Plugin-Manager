#!/usr/bin/env node
/**
 * License Manager — local server.
 *
 * Usage:   node tools/license-server.mjs
 *
 * Reads/writes ledger.json + processed-subscribers.json in tools/license-keys/.
 * Signs new keys with private.pem (Ed25519).  Auto-opens the browser.
 */

import { createServer } from "node:http";
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = join(__dirname, "license-keys");
const LEDGER_PATH = join(KEYS_DIR, "ledger.json");
const SUBS_PATH = join(KEYS_DIR, "processed-subscribers.json");
const PEM_PATH = join(KEYS_DIR, "private.pem");
const HTML_PATH = join(__dirname, "license-manager.html");

const PORT = parseInt(process.env.PORT || "9218", 10);

// ── Helpers ────────────────────────────────────────────────────────

function loadJSON(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function base64urlEncode(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateMasterKey(privateKey, tier, email, plugins, exp) {
  const payload = { t: tier, e: email, p: plugins };
  if (exp) payload.exp = exp;
  const json = JSON.stringify(payload);
  const payloadB64 = base64urlEncode(Buffer.from(json, "utf8"));
  const signature = sign(null, Buffer.from(payloadB64, "utf8"), privateKey);
  return `D18.${payloadB64}.${base64urlEncode(signature)}`;
}

/** Calculate unix-seconds expiration timestamp for a tier, or null for permanent. */
function expirationForTier(tier) {
  const now = Math.floor(Date.now() / 1000);
  if (tier === "free")   return now + 30 * 86400;   // 30 days
  if (tier === "annual") return now + 365 * 86400;   // 1 year
  return null; // master / permanent
}

let privateKey = null;
if (existsSync(PEM_PATH)) {
  privateKey = createPrivateKey(readFileSync(PEM_PATH, "utf8"));
}

// ── HTTP server ────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1e6) { reject(new Error("Body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, status, body) {
  const str = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(str),
  });
  res.end(str);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── Serve the HTML UI ──
  if (url.pathname === "/" && req.method === "GET") {
    const html = readFileSync(HTML_PATH, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // ── GET /api/data — load everything ──
  if (url.pathname === "/api/data" && req.method === "GET") {
    const ledger = loadJSON(LEDGER_PATH, []);
    const subscribers = loadJSON(SUBS_PATH, {});
    json(res, 200, {
      ledger,
      subscribers,
      hasPrivateKey: !!privateKey,
    });
    return;
  }

  // ── POST /api/generate-key — issue a new key ──
  if (url.pathname === "/api/generate-key" && req.method === "POST") {
    if (!privateKey) {
      json(res, 400, { error: "No private.pem found in license-keys/" });
      return;
    }
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { json(res, 400, { error: "Invalid JSON" }); return; }

    const { name, email, tier } = body;
    if (!email || !email.includes("@")) {
      json(res, 400, { error: "Valid email required" });
      return;
    }
    const safeTier = typeof tier === "string" && tier ? tier : "master";
    const plugins = safeTier === "master" ? ["*"] : [safeTier];
    const exp = expirationForTier(safeTier);
    const key = generateMasterKey(privateKey, safeTier, email.toLowerCase(), plugins, exp);
    const now = new Date().toISOString();

    // Append to ledger and save
    const ledger = loadJSON(LEDGER_PATH, []);
    const entry = { name: name || "", tier: safeTier, email: email.toLowerCase(), plugins, key, generatedAt: now };
    if (exp) entry.expiresAt = new Date(exp * 1000).toISOString();
    ledger.push(entry);
    saveJSON(LEDGER_PATH, ledger);

    json(res, 200, { key, entry });
    return;
  }

  // ── POST /api/save-ledger — overwrite ledger with provided data ──
  if (url.pathname === "/api/save-ledger" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { json(res, 400, { error: "Invalid JSON" }); return; }

    if (!Array.isArray(body)) {
      json(res, 400, { error: "Expected array" });
      return;
    }
    saveJSON(LEDGER_PATH, body);
    json(res, 200, { ok: true });
    return;
  }

  // ── 404 ──
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`License Manager running at ${url}`);
  try { execSync(`open "${url}"`); } catch {}
});
