#!/usr/bin/env node
/**
 * One-off dry run: generate a license key and email it.
 * Usage: node tools/test-send-key.mjs
 */

import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function base64urlEncode(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// 1. Generate license key
const pem = readFileSync(join(__dirname, "license-keys", "private.pem"), "utf8");
const privateKey = createPrivateKey(pem);

const email = "g.enright47@gmail.com";
const payload = {
  t: "master",
  e: email,
  p: ["*"],
};
const payloadB64 = base64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
const sig = sign(null, Buffer.from(payloadB64, "utf8"), privateKey);
const licenseKey = `D18.${payloadB64}.${base64urlEncode(sig)}`;

console.log("Generated license key:", licenseKey);

// 2. Load Gmail credentials
const creds = JSON.parse(
  readFileSync("/Volumes/Server Sync Files/Other Scripts/Gmail Board/gmail_credentials.json", "utf8")
);
const token = JSON.parse(
  readFileSync("/Volumes/Server Sync Files/Other Scripts/Gmail Board/gmail_token.json", "utf8")
);

// 3. Refresh access token
const { client_id, client_secret } = creds.installed;
const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id,
    client_secret,
    refresh_token: token.refresh_token,
    grant_type: "refresh_token",
  }),
});
if (!tokenRes.ok) {
  console.error("Token refresh failed:", await tokenRes.text());
  process.exit(1);
}
const accessToken = (await tokenRes.json()).access_token;
console.log("Refreshed Gmail access token");

// 4. Build email
const body = [
  "Hi Greg,",
  "",
  "Thanks for your purchase! Here is your Dec 18 Studios license key:",
  "",
  licenseKey,
  "",
  "Paste this key into the Dec 18 Studios Plugin Manager to unlock all plugins.",
  "",
  "If you haven't downloaded the Plugin Manager yet, grab it from:",
  "https://github.com/Dec18studios/Dec18-Plugin-Manager/releases/latest/",
  "",
  "Cheers,",
  "Greg \u2014 Dec 18 Studios",
  "",
  "--- DRY RUN TEST ---",
].join("\n");

const raw = [
  "From: Dec 18 Studios <create@dec18studios.com>",
  "To: g.enright47@gmail.com",
  "Subject: Your Dec 18 Studios License Key (DRY RUN TEST)",
  "Content-Type: text/plain; charset=UTF-8",
  "",
  body,
].join("\r\n");

const rawB64 = Buffer.from(raw).toString("base64url");

// 5. Send
const sendRes = await fetch(
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: rawB64 }),
  }
);

if (!sendRes.ok) {
  console.error("Send failed:", await sendRes.text());
  process.exit(1);
}

const result = await sendRes.json();
console.log("Email sent to g.enright47@gmail.com");
console.log("Gmail message ID:", result.id);
