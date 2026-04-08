#!/usr/bin/env node
/**
 * License fulfillment — polls Squarespace Commerce Orders API for purchases
 * of the "Happy Little Noders" subscription product, generates master license
 * keys, and emails them via Gmail API.
 *
 * Required env vars:
 *   SQUARESPACE_API_KEY          — Squarespace API key (Commerce Orders permission)
 *   LICENSE_SIGNING_PRIVATE_KEY  — Ed25519 PEM private key (contents, not path)
 *   GMAIL_CREDENTIALS            — Google OAuth client JSON (contents)
 *   GMAIL_TOKEN                  — Google OAuth token JSON (contents)
 *
 * Optional workflow env:
 *   FROM_EMAIL                   — Sender address
 *   FROM_NAME                    — Sender display name
 */

import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROCESSED_PATH = join(__dirname, "license-keys", "processed-subscribers.json");
const LEDGER_PATH = join(__dirname, "license-keys", "ledger.json");

/** The Squarespace product name that triggers license fulfillment. */
const TARGET_PRODUCT = "Happy Little Noders";

// ── Base64url helpers ──────────────────────────────────────────────

function base64urlEncode(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ── License key generation ─────────────────────────────────────────

function generateLicenseKeyFromTier(privateKey, email, tier) {
  const plugins = (tier === "master" || tier === "annual") ? ["*"] : [tier];
  const payload = { t: tier, e: email, p: plugins };

  // Add expiration for non-permanent tiers
  const now = Math.floor(Date.now() / 1000);
  if (tier === "free")   payload.exp = now + 30 * 86400;
  if (tier === "annual") payload.exp = now + 365 * 86400;

  const json = JSON.stringify(payload);
  const payloadB64 = base64urlEncode(Buffer.from(json, "utf8"));
  const signature = sign(null, Buffer.from(payloadB64, "utf8"), privateKey);
  return `D18.${payloadB64}.${base64urlEncode(signature)}`;
}

/**
 * Determine license tier from a Squarespace order.
 * All "Happy Little Noder Subscription" purchasers get "master".
 * Extend this to inspect line item variant/SKU if you add more tiers.
 */
function determineTier(/* order */) {
  return "annual";
}

// ── Squarespace Commerce Orders API ────────────────────────────────

/**
 * Fetch all orders that contain the target product.
 * Uses cursor-based pagination via the Commerce Orders endpoint.
 * Does not filter by fulfillment status — digital subscriptions
 * may not have an explicit fulfillment state.
 */
async function fetchSubscriptionOrders(apiKey) {
  const orders = [];
  let cursor = null;

  while (true) {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    const url = `https://api.squarespace.com/1.0/commerce/orders?${params}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`Squarespace Orders API ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();

    for (const order of data.result ?? []) {
      const hasTarget = (order.lineItems ?? []).some(
        (li) => li.productName === TARGET_PRODUCT
      );
      if (hasTarget) {
        orders.push(order);
      }
    }

    if (data.pagination?.hasNextPage && data.pagination.nextPageCursor) {
      cursor = data.pagination.nextPageCursor;
    } else {
      break;
    }
  }

  return orders;
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
    "Thanks for your purchase! Here's your Dec 18 Studios license key:",
    "",
    licenseKey,
    "",
    "Paste this key into the Dec 18 Studios Plugin Manager to unlock all plugins.",
    "",
    "If you haven't downloaded the Plugin Manager yet, grab it from:",
    "https://github.com/Dec18studios/Dec18-Plugin-Manager/releases/latest/",
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

function loadLedger() {
  if (!existsSync(LEDGER_PATH)) return [];
  return JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
}

function saveLedger(ledger) {
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + "\n");
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.SQUARESPACE_API_KEY;
  const privateKeyPem = process.env.LICENSE_SIGNING_PRIVATE_KEY;
  const credentialsJson = process.env.GMAIL_CREDENTIALS;
  const tokenJson = process.env.GMAIL_TOKEN;

  if (!apiKey || !privateKeyPem || !credentialsJson || !tokenJson) {
    console.log("Missing required env vars — skipping. Set all secrets to enable fulfillment.");
    console.log({
      SQUARESPACE_API_KEY: !!apiKey,
      LICENSE_SIGNING_PRIVATE_KEY: !!privateKeyPem,
      GMAIL_CREDENTIALS: !!credentialsJson,
      GMAIL_TOKEN: !!tokenJson,
    });
    return;
  }

  const privateKey = createPrivateKey(privateKeyPem);
  const credentials = JSON.parse(credentialsJson);
  const token = JSON.parse(tokenJson);

  // 1. Fetch all Squarespace orders containing the target product
  console.log(`Polling Squarespace orders for "${TARGET_PRODUCT}" purchases...`);
  const orders = await fetchSubscriptionOrders(apiKey);
  console.log(`Found ${orders.length} fulfilled order(s) with "${TARGET_PRODUCT}".`);

  // 2. Load already-processed ledger
  const processed = loadProcessed();
  const keyLedger = loadLedger();
  const newPurchasers = [];

  for (const order of orders) {
    const email = order.customerEmail?.trim().toLowerCase();
    if (!email) continue;
    if (processed[email]) continue;

    const ba = order.billingAddress ?? order.shippingAddress ?? {};
    const name = [ba.firstName, ba.lastName].filter(Boolean).join(" ") || null;
    const total = order.grandTotal?.value ?? "unknown";
    const tier = determineTier(order);
    newPurchasers.push({ email, name, orderId: order.id, orderNumber: order.orderNumber, amount: total, tier });
  }

  if (!newPurchasers.length) {
    console.log("No new purchasers to process.");
    return;
  }

  console.log(`Processing ${newPurchasers.length} new purchaser(s)...`);

  // 3. Get Gmail access token
  const accessToken = await refreshAccessToken(credentials, token);

  // 4. Generate key + send email for each new purchaser
  for (const purchaser of newPurchasers) {
    try {
      const licenseKey = generateLicenseKeyFromTier(privateKey, purchaser.email, purchaser.tier);
      const rawEmail = buildLicenseEmail(purchaser.email, purchaser.name, licenseKey);
      await sendEmail(accessToken, rawEmail);

      processed[purchaser.email] = {
        processedAt: new Date().toISOString(),
        orderId: purchaser.orderId,
        orderNumber: purchaser.orderNumber,
        name: purchaser.name,
        amount: purchaser.amount,
        tier: purchaser.tier,
        key: licenseKey,
      };

      const ledgerEntry = {
        name: purchaser.name || '',
        tier: purchaser.tier,
        email: purchaser.email,
        plugins: (purchaser.tier === "master" || purchaser.tier === "annual") ? ['*'] : [purchaser.tier],
        key: licenseKey,
        generatedAt: new Date().toISOString(),
      };
      // Add expiresAt for time-limited tiers
      if (purchaser.tier === "free") ledgerEntry.expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
      if (purchaser.tier === "annual") ledgerEntry.expiresAt = new Date(Date.now() + 365 * 86400000).toISOString();

      keyLedger.push(ledgerEntry);

      console.log(`✓ Sent ${purchaser.tier} key to ${purchaser.email} (order #${purchaser.orderNumber}, $${purchaser.amount})`);
    } catch (err) {
      console.error(`✗ Failed for ${purchaser.email}: ${err.message}`);
    }
  }

  // 5. Save updated ledger + subscriber list
  saveProcessed(processed);
  saveLedger(keyLedger);
  console.log(`Done. Processed ${Object.keys(processed).length} total subscriber(s), ${keyLedger.length} ledger entries.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
