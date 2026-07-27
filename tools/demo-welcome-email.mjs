#!/usr/bin/env node
/*
 * demo-welcome-email.mjs
 *
 * Sends the one-time "thanks for trying the demo" email to PhotoChemist-demo
 * downloaders captured by the dec18-download-logger Worker.
 *
 * Data AND state live in the logger's D1 database (dec18-downloads.downloads) —
 * nothing is written to the repo, because this repo is public and the rows are
 * customer email addresses.
 *
 *   eligible  = tool_slug = SLUG AND unsubscribed = 0 AND COALESCE(welcome_sent,0) = 0
 *   per row   → Brevo transactional send (+ optional contact upsert into a list)
 *   success   → UPDATE welcome_sent = 1   (per-row, so a failed send self-heals
 *               on the next hourly run; a crash mid-run never double-sends
 *               anyone already marked)
 *
 * First enabled run therefore backfills every existing downloader; after that
 * the hourly cron catches new downloads within the hour.
 *
 * Env:
 *   CLOUDFLARE_API_TOKEN    — required (wrangler d1 execute, run from tools/download-logger)
 *   BREVO_API_KEY           — required for live sends (xkeysib-…)
 *   DOWNLOAD_LOGGER_SECRET  — required; = the Worker's ADMIN_SECRET, used to build
 *                             the same /unsubscribe token the Worker verifies
 *   DRY_RUN=1               — list masked recipients, send nothing, mark nothing
 *   TEST_EMAIL=addr         — send ONE rendered sample to addr, mark nothing
 *   SLUG                    — default "photochemist-demo"
 *   BREVO_LIST_ID           — contact-list upsert target, default 3; "" disables
 *   MAX_SENDS               — per-run cap, default 100 (Brevo free tier is
 *                             300/day shared with license + OTP mail; the
 *                             remainder is picked up by later runs)
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = join(__dirname, "download-logger");

const WORKER_URL = "https://dec18-download-logger.dec18studios.workers.dev";
const D1_NAME = "dec18-downloads";

const DRY_RUN = process.env.DRY_RUN === "1";
const TEST_EMAIL = (process.env.TEST_EMAIL || "").trim();
const SLUG = (process.env.SLUG || "photochemist-demo").trim();
const LIST_ID = process.env.BREVO_LIST_ID === "" ? null : Number(process.env.BREVO_LIST_ID || "3");
const MAX_SENDS = Number(process.env.MAX_SENDS || "100");

const BREVO_KEY = (process.env.BREVO_API_KEY || "").trim();
const DL_SECRET = (process.env.DOWNLOAD_LOGGER_SECRET || "").trim();

const FROM = { name: "Dec 18 Studios", email: "create@dec18studios.com" };

// ── D1 access (wrangler, cwd = the worker dir so wrangler.toml pins account) ──
async function d1(sql) {
  const { stdout } = await execFileP(
    "npx",
    ["--yes", "wrangler@4", "d1", "execute", D1_NAME, "--remote", "--json", "--command", sql],
    { cwd: WORKER_DIR, env: process.env, maxBuffer: 16 * 1024 * 1024 }
  );
  const parsed = JSON.parse(stdout);
  return parsed[0]?.results || [];
}

const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function ensureWelcomeSentColumn() {
  // Probe first: wrangler reports a duplicate-column ALTER as exit 1 with the
  // API error on STDOUT (stderr is empty), so catching it by message is fragile.
  const cols = await d1("PRAGMA table_info(downloads)");
  if (cols.some((c) => c.name === "welcome_sent")) return;
  try {
    await d1("ALTER TABLE downloads ADD COLUMN welcome_sent INTEGER DEFAULT 0");
    console.log("Migrated: added downloads.welcome_sent column.");
  } catch (e) {
    // Belt and braces: tolerate a concurrent run that added it first.
    const msg = `${e.stdout || ""}${e.stderr || ""}${e.message || e}`;
    if (!/duplicate column/i.test(msg)) throw e;
  }
}

// ── unsubscribe link — must match unsubToken() in download-logger/worker.js ──
function unsubToken(email, tool) {
  return createHash("sha256")
    .update(`unsub:${email}:${tool}:${DL_SECRET}`)
    .digest("hex")
    .slice(0, 16);
}
function unsubUrl(email, tool) {
  return `${WORKER_URL}/unsubscribe?email=${encodeURIComponent(email)}&tool=${encodeURIComponent(tool)}&token=${unsubToken(email, tool)}`;
}

// ── email content ─────────────────────────────────────────────────────────────
// Template: Greg's photochemist-thankyou-email.html draft (2026-07-27), with the
// Brevo tags swapped for values this sender controls:
//   {{ contact.FIRSTNAME }} → "there"  (the download gate only captures emails)
//   {{ unsubscribe }}       → the Worker's token /unsubscribe link
// plus a guide-links block after the video.
const SITE = "https://tools.dec18studios.com/color-grading-tools/photochemist";

const SUBJECT = "Thanks for taking PhotoChemist for a spin";

function emailHTML({ unsub }) {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>Thanks for Downloading PhotoChemist</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<![endif]-->
<style>
  body, table, td { margin:0; padding:0; }
  img { border:0; line-height:100%; outline:none; text-decoration:none; }
  table { border-collapse:collapse !important; }
  @media only screen and (max-width:620px) {
    .container { width:100% !important; }
    .px { padding-left:20px !important; padding-right:20px !important; }
    .h1 { font-size:26px !important; line-height:32px !important; }
  }
</style>
</head>
<body style="margin:0; padding:0; background-color:#111418;">

<!-- Preheader (hidden preview text) -->
<div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">
  A quick thank-you from Dec. 18 Studios, and a real person to reply to if you need a hand getting started.
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#111418;">
  <tr>
    <td align="center" style="padding:32px 12px;">

      <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px; max-width:600px;">

        <!-- Header -->
        <tr>
          <td align="center" style="padding:8px 0 24px 0;">
            <a href="https://dec18studios.com" style="text-decoration:none;">
              <span style="font-family:Georgia, 'Times New Roman', serif; font-size:22px; letter-spacing:3px; color:#f4f1ea;">DEC. 18 STUDIOS</span><br>
              <span style="font-family:Arial, Helvetica, sans-serif; font-size:11px; letter-spacing:2px; color:#8a9099; text-transform:uppercase;">Color Grading Tools</span>
            </a>
          </td>
        </tr>

        <!-- Hero card -->
        <tr>
          <td style="background-color:#1a1f26; border-radius:12px 12px 0 0; padding:40px 40px 8px 40px;" class="px">
            <h1 class="h1" style="margin:0 0 16px 0; font-family:Georgia, 'Times New Roman', serif; font-size:30px; line-height:38px; color:#f4f1ea; font-weight:normal;">
              Thanks for taking PhotoChemist for a spin
            </h1>
            <p style="margin:0 0 12px 0; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:24px; color:#c6ccd4;">
              Hi there!
            </p>
            <p style="margin:0 0 12px 0; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:24px; color:#c6ccd4;">
              You grabbed the PhotoChemist demo recently, and thank you for that. It means a lot every time someone gives these tools a shot.
            </p>
            <p style="margin:0 0 12px 0; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:24px; color:#c6ccd4;">
              What you&rsquo;ve got is, I believe, the most honest film simulator on the market. PhotoChemist doesn&rsquo;t chase the look with filters. It models the physics of film with math, from the light hitting the negative to the print on the projector.
            </p>
            <p style="margin:0 0 12px 0; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:24px; color:#c6ccd4;">
              And here&rsquo;s where I&rsquo;d start: skip the deep settings and learn to work the <strong style="color:#f4f1ea;">printer lights</strong> ... the historical color timing lab system, simulated perfectly with math. Once you can grade the way a color timer would, the whole tool makes sense.
            </p>
          </td>
        </tr>

        <!-- Video block -->
        <tr>
          <td style="background-color:#1a1f26; padding:8px 40px 8px 40px;" class="px">
            <p style="margin:0 0 12px 0; font-family:Arial, Helvetica, sans-serif; font-size:11px; letter-spacing:2px; color:#d9a441; text-transform:uppercase;">Watch First &bull; 16 Min</p>
            <a href="https://www.youtube.com/watch?v=GFryQzEsaC8" target="_blank" style="text-decoration:none;">
              <img src="https://i.ytimg.com/vi/GFryQzEsaC8/maxresdefault.jpg" width="520" alt="Video: Simulating the Physics of Printer Lights" style="width:100%; max-width:520px; height:auto; border-radius:8px; display:block;">
            </a>
            <p style="margin:14px 0 4px 0; font-family:Georgia, 'Times New Roman', serif; font-size:17px; line-height:23px;">
              <a href="https://www.youtube.com/watch?v=GFryQzEsaC8" target="_blank" style="color:#f4f1ea; text-decoration:none;">Simulating the Physics of Printer Lights &#9654;</a>
            </p>
            <p style="margin:0 0 12px 0; font-family:Arial, Helvetica, sans-serif; font-size:14px; line-height:22px; color:#8a9099;">
              I walk through the full logic chain (light through the negative, silver activation on the print), then set up a grade the way a lab would, and finish with something film never let you do: keying printer lights through a mask on your own node.
            </p>
          </td>
        </tr>

        <!-- Guides block -->
        <tr>
          <td style="background-color:#1a1f26; padding:16px 40px 8px 40px;" class="px">
            <p style="margin:0 0 10px 0; font-family:Arial, Helvetica, sans-serif; font-size:11px; letter-spacing:2px; color:#d9a441; text-transform:uppercase;">Go Deeper</p>
            <p style="margin:0 0 8px 0; font-family:Arial, Helvetica, sans-serif; font-size:14px; line-height:22px;">
              <a href="${SITE}/quickstart/" target="_blank" style="color:#f4f1ea; text-decoration:none; font-weight:bold;">Quick-Start Guide &rarr;</a><br>
              <span style="color:#8a9099;">Install, plus the one setup rule: feed it DaVinci Wide Gamut / Linear (a CST with no tone mapping on the node before). On macOS, &ldquo;Allow Anyway&rdquo; in Privacy &amp; Security if asked.</span>
            </p>
            <p style="margin:0 0 8px 0; font-family:Arial, Helvetica, sans-serif; font-size:14px; line-height:22px;">
              <a href="${SITE}/complete-guide/" target="_blank" style="color:#f4f1ea; text-decoration:none; font-weight:bold;">The Complete Guide &rarr;</a><br>
              <span style="color:#8a9099;">Every control explained, from stock selection to the print stage.</span>
            </p>
            <p style="margin:0 0 12px 0; font-family:Arial, Helvetica, sans-serif; font-size:14px; line-height:22px;">
              <a href="${SITE}/Workflows/" target="_blank" style="color:#f4f1ea; text-decoration:none; font-weight:bold;">Node-Tree Workflows &rarr;</a><br>
              <span style="color:#8a9099;">Where PhotoChemist sits in a real grade, with example trees.</span>
            </p>
          </td>
        </tr>

        <!-- Help block -->
        <tr>
          <td style="background-color:#1a1f26; padding:16px 40px 8px 40px;" class="px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#22282f; border-radius:8px;">
              <tr>
                <td style="padding:24px 28px;">
                  <h3 style="margin:0 0 8px 0; font-family:Georgia, 'Times New Roman', serif; font-size:18px; line-height:24px; color:#f4f1ea; font-weight:normal;">Stuck? Curious? Just reply.</h3>
                  <p style="margin:0; font-family:Arial, Helvetica, sans-serif; font-size:14px; line-height:22px; color:#c6ccd4;">
                    If you have any questions about PhotoChemist or need help getting set up (installation, first grade, anything), hit reply to this email. It goes straight to me, not a ticket system, and I answer every message.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Divider -->
        <tr>
          <td style="background-color:#1a1f26; padding:20px 40px;" class="px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="border-top:1px solid #2c333d; font-size:0; line-height:0;">&nbsp;</td></tr>
            </table>
          </td>
        </tr>

        <!-- Upgrade block -->
        <tr>
          <td style="background-color:#1a1f26; padding:0 40px 8px 40px;" class="px">
            <p style="margin:0 0 6px 0; font-family:Arial, Helvetica, sans-serif; font-size:11px; letter-spacing:2px; color:#d9a441; text-transform:uppercase;">When You&rsquo;re Ready</p>
            <h2 style="margin:0 0 10px 0; font-family:Georgia, 'Times New Roman', serif; font-size:22px; line-height:28px; color:#f4f1ea; font-weight:normal;">The whole Tool Box is $47.34. That&rsquo;s it.</h2>
            <p style="margin:0 0 12px 0; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:24px; color:#c6ccd4;">
              If the demo wins you over, $47.34 doesn&rsquo;t just unlock PhotoChemist. It gets you <strong style="color:#f4f1ea;">every premium DCTL and OFX plugin</strong> in the Tool Box, plus a full year of updates, new tools, and actual human support. No tiers, no upsells.
            </p>
            <p style="margin:0 0 20px 0; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:24px; color:#c6ccd4;">
              And it&rsquo;s not a subscription trap: your tools keep working even if you never renew, and the rate you join at locks in forever, even if you step away for a year or two and come back.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px 0;">
              <tr>
                <td align="center" bgcolor="#d9a441" style="border-radius:6px;">
                  <a href="https://dec18studios.com/clients?join=1" target="_blank" style="display:inline-block; padding:13px 28px; font-family:Arial, Helvetica, sans-serif; font-size:15px; font-weight:bold; color:#111418; text-decoration:none; border-radius:6px;">Get the Whole Tool Box for $47.34</a>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 12px 0; font-family:Arial, Helvetica, sans-serif; font-size:13px; line-height:20px; color:#8a9099;">
              Want the fine print? <a href="https://tools.dec18studios.com/color-grading-tools/pricing/" target="_blank" style="color:#8a9099; text-decoration:underline;">How the pricing works &rarr;</a>
            </p>
            <p style="margin:0 0 8px 0; font-family:Arial, Helvetica, sans-serif; font-size:13px; line-height:20px; color:#8a9099;">
              No pressure. The demo is yours either way. But if PhotoChemist ends up in your node tree every day, this is how you keep it there.
            </p>
          </td>
        </tr>

        <!-- Sign-off -->
        <tr>
          <td style="background-color:#1a1f26; padding:16px 40px 40px 40px; border-radius:0 0 12px 12px;" class="px">
            <p style="margin:0; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:24px; color:#c6ccd4;">
              Happy grading,<br>
              <span style="color:#f4f1ea;">Greg</span><br>
              <span style="font-size:13px; color:#8a9099;">Dec. 18 Studios</span>
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td align="center" style="padding:28px 40px 8px 40px;" class="px">
            <p style="margin:0 0 8px 0; font-family:Arial, Helvetica, sans-serif; font-size:12px; line-height:18px; color:#6b727c;">
              Dec. 18 Studios &bull; <a href="https://dec18studios.com" style="color:#8a9099; text-decoration:underline;">dec18studios.com</a>
            </p>
            <p style="margin:0 0 8px 0; font-family:Arial, Helvetica, sans-serif; font-size:12px; line-height:18px; color:#6b727c;">
              You&rsquo;re receiving this because you downloaded the PhotoChemist demo.
            </p>
            <p style="margin:0; font-family:Arial, Helvetica, sans-serif; font-size:12px; line-height:18px; color:#6b727c;">
              <a href="${unsub}" style="color:#8a9099; text-decoration:underline;">Unsubscribe</a>
            </p>
          </td>
        </tr>

      </table>

    </td>
  </tr>
</table>

</body>
</html>`;
}

// ── Brevo ─────────────────────────────────────────────────────────────────────
async function brevoSend(to, subject, html) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": BREVO_KEY, accept: "application/json", "content-type": "application/json" },
    // tags → filterable in Brevo's Transactional > Logs / Statistics, so this
    // campaign's opens/clicks/bounces can be read apart from OTP + license mail
    body: JSON.stringify({ sender: FROM, to: [{ email: to }], subject, htmlContent: html, tags: [`${SLUG}-welcome`] }),
  });
  if (res.status === 201 || res.status === 202) return true;
  let detail = "";
  try { detail = JSON.stringify(await res.json()); } catch {}
  throw new Error(`Brevo send ${res.status} for ${to}: ${detail}`);
}

async function brevoContactUpsert(email) {
  if (!LIST_ID) return;
  const res = await fetch("https://api.brevo.com/v3/contacts", {
    method: "POST",
    headers: { "api-key": BREVO_KEY, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ email, listIds: [LIST_ID], updateEnabled: true }),
  });
  // 201 created, 204 updated — anything else is non-fatal (the email still went out)
  if (res.status !== 201 && res.status !== 204) {
    console.log(`  (contact upsert ${res.status} for ${mask(email)} — non-fatal)`);
  }
}

const mask = (e) => e.replace(/^(.).*(@.*)$/, "$1***$2");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nDemo welcome emails — tool "${SLUG}"${DRY_RUN ? "  (DRY RUN)" : ""}${TEST_EMAIL ? `  (TEST → ${TEST_EMAIL})` : ""}\n`);

  // Unsubscribe links can only be built with the Worker's ADMIN_SECRET, so any
  // path that actually sends needs it; dry-run doesn't.
  if (!DRY_RUN && !DL_SECRET) throw new Error("Missing DOWNLOAD_LOGGER_SECRET (needed for unsubscribe links).");

  // Test mode: one rendered sample, no D1, no marking.
  if (TEST_EMAIL) {
    if (!BREVO_KEY) throw new Error("Missing BREVO_API_KEY.");
    const html = emailHTML({ unsub: unsubUrl(TEST_EMAIL, SLUG) });
    await brevoSend(TEST_EMAIL, `[TEST] ${SUBJECT}`, html);
    console.log(`Sent one test email to ${TEST_EMAIL}. Nothing marked in D1.\n`);
    return;
  }

  if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error("Missing CLOUDFLARE_API_TOKEN (needed for D1).");
  if (!DRY_RUN && !BREVO_KEY) throw new Error("Missing BREVO_API_KEY.");

  await ensureWelcomeSentColumn();

  const rows = await d1(
    `SELECT email, tool_name, first_downloaded, download_count FROM downloads ` +
    `WHERE tool_slug = ${sq(SLUG)} AND unsubscribed = 0 AND COALESCE(welcome_sent, 0) = 0 ` +
    `ORDER BY first_downloaded ASC`
  );

  console.log(`Eligible (never welcomed, not unsubscribed): ${rows.length}`);
  for (const r of rows) console.log(`  ${mask(r.email).padEnd(28)} first:${(r.first_downloaded || "").slice(0, 10)}  dls:${r.download_count}`);
  console.log("");

  if (DRY_RUN) {
    console.log("Dry run — nothing sent, nothing marked.\n");
    return;
  }
  if (!rows.length) {
    console.log("Nothing to do.\n");
    return;
  }

  const batch = rows.slice(0, MAX_SENDS);
  if (rows.length > batch.length) {
    console.log(`Capped at MAX_SENDS=${MAX_SENDS} this run; ${rows.length - batch.length} remaining will go out on later runs.\n`);
  }

  let sent = 0, failed = 0;
  for (const r of batch) {
    const email = r.email.trim().toLowerCase();
    try {
      const html = emailHTML({ unsub: unsubUrl(email, SLUG) });
      await brevoSend(email, SUBJECT, html);
      await brevoContactUpsert(email);
      await d1(`UPDATE downloads SET welcome_sent = 1 WHERE email = ${sq(email)} AND tool_slug = ${sq(SLUG)}`);
      sent++;
      console.log(`  ✓ ${mask(email)}`);
    } catch (e) {
      failed++;
      console.log(`  ✖ ${mask(email)} — ${String(e.message || e).slice(0, 200)}`);
    }
    await sleep(200); // gentle pacing for Brevo
  }

  console.log(`\nDone. sent:${sent}  failed:${failed} (failures retry next run)\n`);
  if (failed && !sent) process.exit(1); // everything failed → surface a red run
}

main().catch((e) => { console.error(e); process.exit(1); });
