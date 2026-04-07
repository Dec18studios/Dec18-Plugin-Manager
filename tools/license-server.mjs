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
const GMAIL_CREDS_PATH = join(KEYS_DIR, "gmail-credentials.json");
const GMAIL_TOKEN_PATH = join(KEYS_DIR, "gmail-token.json");

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

  // ── POST /api/update-entry — update name/email on a ledger entry by index ──
  if (url.pathname === "/api/update-entry" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { json(res, 400, { error: "Invalid JSON" }); return; }

    const { index, name, email } = body;
    const ledger = loadJSON(LEDGER_PATH, []);
    if (typeof index !== "number" || index < 0 || index >= ledger.length) {
      json(res, 400, { error: "Invalid index" }); return;
    }

    const entry = ledger[index];
    const changed = {};
    if (typeof name === "string") { entry.name = name; changed.name = name; }
    if (typeof email === "string" && email.includes("@")) {
      const oldEmail = entry.email;
      entry.email = email.toLowerCase();
      changed.email = entry.email;
      // If email changed and key exists, regenerate key with new email
      if (privateKey && oldEmail !== entry.email && entry.key && entry.key.startsWith("D18.")) {
        const tier = entry.tier || "master";
        const plugins = entry.plugins || (tier === "master" ? ["*"] : [tier]);
        const exp = entry.expiresAt ? Math.floor(new Date(entry.expiresAt).getTime() / 1000) : expirationForTier(tier);
        entry.key = generateMasterKey(privateKey, tier, entry.email, plugins, exp);
        changed.key = entry.key;
      }
    }

    saveJSON(LEDGER_PATH, ledger);
    json(res, 200, { ok: true, entry, changed });
    return;
  }

  // ── POST /api/send-key-email — send a license key via Gmail API ──
  if (url.pathname === "/api/send-key-email" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { json(res, 400, { error: "Invalid JSON" }); return; }

    const { email, name, key } = body;
    if (!email || !key) { json(res, 400, { error: "email and key required" }); return; }

    // Load Gmail credentials from local files
    if (!existsSync(GMAIL_CREDS_PATH) || !existsSync(GMAIL_TOKEN_PATH)) {
      json(res, 400, { error: "Gmail credentials not found. Place gmail-credentials.json and gmail-token.json in tools/license-keys/" });
      return;
    }

    try {
      const credentials = JSON.parse(readFileSync(GMAIL_CREDS_PATH, "utf8"));
      const token = JSON.parse(readFileSync(GMAIL_TOKEN_PATH, "utf8"));

      // Refresh access token
      const creds = credentials.installed ?? credentials.web ?? credentials;
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: creds.client_id,
          client_secret: creds.client_secret,
          refresh_token: token.refresh_token,
          grant_type: "refresh_token",
        }),
      });
      if (!tokenRes.ok) throw new Error(`Token refresh failed: ${await tokenRes.text()}`);
      const { access_token } = await tokenRes.json();

      // Build email
      const displayName = name || "there";
      const subject = "Your Dec 18 Studios License Key";
      const emailBody = [
        `Hi ${displayName},`,
        "",
        "Thanks for your purchase! Here's your Dec 18 Studios license key:",
        "",
        key,
        "",
        "Paste this key into the Dec 18 Studios Plugin Manager to unlock all plugins.",
        "",
        "If you haven't downloaded the Plugin Manager yet, grab it from:",
        "https://github.com/Dec18studios/Dec18-Plugin-Manager/releases",
        "",
        "Cheers,",
        "Greg \u2014 Dec 18 Studios",
      ].join("\n");

      const raw = [
        `From: Dec 18 Studios <create@dec18studios.com>`,
        `To: ${email}`,
        `Subject: ${subject}`,
        "Content-Type: text/plain; charset=UTF-8",
        "",
        emailBody,
      ].join("\r\n");

      const rawBase64 = Buffer.from(raw).toString("base64url");

      // Send via Gmail API
      const sendRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw: rawBase64 }),
      });
      if (!sendRes.ok) throw new Error(`Gmail send failed: ${await sendRes.text()}`);
      const result = await sendRes.json();
      json(res, 200, { ok: true, messageId: result.id });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return;
  }

  // ── GET /api/email-status — check if Gmail creds are available ──
  if (url.pathname === "/api/email-status" && req.method === "GET") {
    json(res, 200, { hasGmailCreds: existsSync(GMAIL_CREDS_PATH) && existsSync(GMAIL_TOKEN_PATH) });
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
