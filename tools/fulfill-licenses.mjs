#!/usr/bin/env node
/**
 * License fulfillment — polls Squarespace newsletter form for new
 * subscribers, generates master license keys, emails them via Gmail API.
 *
 * Required env vars:
 *   SQUARESPACE_API_KEY          — Squarespace API key (Forms permission)
 *   LICENSE_SIGNING_PRIVATE_KEY  — Ed25519 PEM private key (contents, not path)
 *   GMAIL_CREDENTIALS            — Google OAuth client JSON (contents)
 *   GMAIL_TOKEN                  — Google OAuth token JSON (contents)
 *
 * Required workflow env:
 *   SQUARESPACE_FORM_ID          — Form block ID to poll
 *   FROM_EMAIL                   — Sender address
 *   FROM_NAME                    — Sender display name
 */

import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROCESSED_PATH = join(__dirname, "license-keys", "processed-subscribers.json");

// ── Base64url helpers ──────────────────────────────────────────────

function base64urlEncode(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ── License key generation ─────────────────────────────────────────

function generateMasterKey(privateKey, email) {
  const payload = {
    tier: "master",
    email,
    plugins: ["*"],
    issuedAt: new Date().toISOString(),
  };
  const json = JSON.stringify(payload);
  const payloadB64 = base64urlEncode(Buffer.from(json, "utf8"));
  const signature = sign(null, Buffer.from(payloadB64, "utf8"), privateKey);
  return `D18.${payloadB64}.${base64urlEncode(signature)}`;
}

// ── Squarespace API ────────────────────────────────────────────────

async function fetchFormSubmissions(apiKey, formId) {
  const url = `https://api.squarespace.com/1.0/commerce/forms/${formId}/submissions`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Squarespace API ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.result ?? [];
}

function extractEmail(submission) {
  // Squarespace form submissions have a `data` object with field labels as keys.
  // Newsletter forms typically have an "Email" or "email" field.
  const fields = submission.data ?? submission.formData ?? {};
  for (const [key, value] of Object.entries(fields)) {
    const k = key.toLowerCase();
    if (k === "email" || k === "email address" || k.includes("email")) {
      if (typeof value === "string" && value.includes("@")) return value.trim().toLowerCase();
    }
  }
  return null;
}

function extractName(submission) {
  const fields = submission.data ?? submission.formData ?? {};
  for (const [key, value] of Object.entries(fields)) {
    const k = key.toLowerCase();
    if (k === "name" || k === "first name" || k === "full name") {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

// ── Gmail API ──────────────────────────────────────────────────────

async function refreshAccessToken(credentials, token) {
  const { client_id, client_secret } = credentials.installed ?? credentials.web ?? credentials;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id,
      client_secret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

function buildLicenseEmail(toEmail, toName, licenseKey) {
  const name = toName ?? "there";
  const subject = "Your Dec 18 Studios License Key";
  const body = [
    `Hi ${name},`,
    "",
    "Thanks for registering with Dec 18 Studios! Here's your license key:",
    "",
    licenseKey,
    "",
    "Paste this key into the Dec 18 Studios Plugin Manager to unlock all plugins.",
    "",
    "If you haven't downloaded the Plugin Manager yet, grab it from:",
    "https://github.com/Dec18studios/Dec18-Plugin-Manager/releases",
    "",
    "Cheers,",
    "Greg — Dec 18 Studios",
  ].join("\n");

  const fromName = process.env.FROM_NAME ?? "Dec 18 Studios";
  const fromEmail = process.env.FROM_EMAIL ?? "create@dec18studios.com";

  const raw = [
    `From: ${fromName} <${fromEmail}>`,
    `To: ${toEmail}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
  ].join("\r\n");

  return Buffer.from(raw).toString("base64url");
}

async function sendEmail(accessToken, rawBase64) {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: rawBase64 }),
  });
  if (!res.ok) throw new Error(`Gmail send failed: ${await res.text()}`);
  return res.json();
}

// ── Processed subscribers ledger ───────────────────────────────────

function loadProcessed() {
  if (!existsSync(PROCESSED_PATH)) return {};
  return JSON.parse(readFileSync(PROCESSED_PATH, "utf8"));
}

function saveProcessed(ledger) {
  writeFileSync(PROCESSED_PATH, JSON.stringify(ledger, null, 2) + "\n");
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.SQUARESPACE_API_KEY;
  const privateKeyPem = process.env.LICENSE_SIGNING_PRIVATE_KEY;
  const credentialsJson = process.env.GMAIL_CREDENTIALS;
  const tokenJson = process.env.GMAIL_TOKEN;
  const formId = process.env.SQUARESPACE_FORM_ID;

  if (!apiKey || !privateKeyPem || !credentialsJson || !tokenJson || !formId) {
    console.log("Missing required env vars — skipping. Set all secrets to enable fulfillment.");
    console.log({
      SQUARESPACE_API_KEY: !!apiKey,
      LICENSE_SIGNING_PRIVATE_KEY: !!privateKeyPem,
      GMAIL_CREDENTIALS: !!credentialsJson,
      GMAIL_TOKEN: !!tokenJson,
      SQUARESPACE_FORM_ID: formId ?? "(not set)",
    });
    return;
  }

  const privateKey = createPrivateKey(privateKeyPem);
  const credentials = JSON.parse(credentialsJson);
  const token = JSON.parse(tokenJson);

  // 1. Fetch Squarespace form submissions
  console.log(`Polling Squarespace form ${formId}...`);
  const submissions = await fetchFormSubmissions(apiKey, formId);
  console.log(`Found ${submissions.length} total submissions.`);

  // 2. Load already-processed ledger
  const processed = loadProcessed();
  const newSubs = [];

  for (const sub of submissions) {
    const email = extractEmail(sub);
    if (!email) continue;
    if (processed[email]) continue;
    newSubs.push({ email, name: extractName(sub), submissionId: sub.id });
  }

  if (!newSubs.length) {
    console.log("No new subscribers to process.");
    return;
  }

  console.log(`Processing ${newSubs.length} new subscriber(s)...`);

  // 3. Get Gmail access token
  const accessToken = await refreshAccessToken(credentials, token);

  // 4. Generate key + send email for each new subscriber
  for (const sub of newSubs) {
    try {
      const licenseKey = generateMasterKey(privateKey, sub.email);
      const rawEmail = buildLicenseEmail(sub.email, sub.name, licenseKey);
      await sendEmail(accessToken, rawEmail);

      processed[sub.email] = {
        processedAt: new Date().toISOString(),
        submissionId: sub.submissionId,
        name: sub.name,
      };

      console.log(`✓ Sent key to ${sub.email}`);
    } catch (err) {
      console.error(`✗ Failed for ${sub.email}: ${err.message}`);
    }
  }

  // 5. Save updated ledger
  saveProcessed(processed);
  console.log(`Done. Processed ${Object.keys(processed).length} total subscribers.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
