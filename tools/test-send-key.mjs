#!/usr/bin/env node
/**
 * Send yourself the purchase-fulfillment email, to see it in a real client.
 * Usage: node tools/test-send-key.mjs
 *
 * No licence key involved: the email does not carry one any more, so this
 * needs nothing but the Gmail credentials.
 */

import { readFileSync } from "node:fs";
import {
  LICENSE_EMAIL_SUBJECT,
  licenseEmailHTML,
  licenseEmailText,
} from "./license-email-template.mjs";

const email = "g.enright47@gmail.com";

// 1. Load Gmail credentials
const creds = JSON.parse(
  readFileSync("/Volumes/Server Sync Files/Other Scripts/Gmail Board/gmail_credentials.json", "utf8")
);
const token = JSON.parse(
  readFileSync("/Volumes/Server Sync Files/Other Scripts/Gmail Board/gmail_token.json", "utf8")
);

// 2. Refresh access token
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

// 3. Build email \u2014 the real fulfillment template, so this doubles as a preview
const args = { name: "Greg", email };
const boundary = "----=_d18_license_alt_boundary";
const part = (mime, content) =>
  [
    `--${boundary}`,
    `Content-Type: ${mime}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(content, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
  ].join("\r\n");

const raw = [
  "From: Dec 18 Studios <create@dec18studios.com>",
  "To: g.enright47@gmail.com",
  `Subject: ${LICENSE_EMAIL_SUBJECT} (DRY RUN TEST)`,
  "MIME-Version: 1.0",
  `Content-Type: multipart/alternative; boundary="${boundary}"`,
  "",
  part("text/plain", licenseEmailText(args)),
  part("text/html", licenseEmailHTML(args)),
  `--${boundary}--`,
  "",
].join("\r\n");

const rawB64 = Buffer.from(raw).toString("base64url");

// 4. Send
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
