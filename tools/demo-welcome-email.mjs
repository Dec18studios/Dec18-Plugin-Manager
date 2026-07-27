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
  try {
    await d1("ALTER TABLE downloads ADD COLUMN welcome_sent INTEGER DEFAULT 0");
    console.log("Migrated: added downloads.welcome_sent column.");
  } catch (e) {
    const msg = String(e.stderr || e.message || e);
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
const SITE = "https://tools.dec18studios.com/color-grading-tools/photochemist";

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const SUBJECT = "Thanks for trying Photo Chemist — a few tips to get the best out of the demo";

function emailHTML({ unsub }) {
  const link = (href, label) =>
    `<a href="${href}" style="color:#4a8aff;text-decoration:none;font-weight:600">${esc(label)} →</a>`;
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f1116;font-family:system-ui,-apple-system,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1116;padding:40px 20px">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">
  <tr><td style="padding-bottom:28px">
    <span style="font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#4a8aff">Dec 18 Studios</span>
  </td></tr>
  <tr><td style="background:#13151c;border:1px solid #2a2d3a;border-radius:12px;padding:36px 32px">
    <p style="margin:0 0 6px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#888;font-weight:600">Photo Chemist demo</p>
    <h1 style="margin:0 0 18px;font-size:26px;font-weight:700;color:#e8eaf0;line-height:1.25">Thanks for taking Photo&nbsp;Chemist for a spin</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#cfd2d8;line-height:1.65">
      You grabbed the free demo of Photo Chemist — spectral film-stock emulation for DaVinci Resolve.
      It's the same engine as the full plugin, so everything you dial in here translates directly.
      A few things that help people get good results fast:
    </p>
    <table cellpadding="0" cellspacing="0" style="width:100%;background:#1a1d24;border:1px solid #2a2d3a;border-radius:8px;margin:0 0 24px">
      <tr><td style="padding:16px 18px">
        <p style="margin:0;font-size:13px;color:#cfd2d8;line-height:1.7">
          <b style="color:#e8eaf0">The #1 setup gotcha:</b> Photo Chemist expects a
          <b style="color:#e8eaf0">DaVinci Wide Gamut / Linear</b> input. Add a CST with
          <b style="color:#e8eaf0">no tone mapping</b> on the node just before it.<br>
          <b style="color:#e8eaf0">On macOS:</b> if the system asks, choose <i>Allow Anyway</i> in
          Privacy &amp; Security, then reopen Resolve.
        </p>
      </td></tr>
    </table>
    <p style="margin:0 0 10px;font-size:15px;color:#cfd2d8;line-height:1.9">
      ${link(`${SITE}/quickstart/`, "Quick-start guide")}<br>
      ${link(`${SITE}/complete-guide/`, "The complete guide")}<br>
      ${link(`${SITE}/Workflows/`, "Node-tree workflows")}
    </p>
    <p style="margin:24px 0 20px;font-size:15px;color:#cfd2d8;line-height:1.65">
      When you're ready for the clean, unrestricted version — plus the rest of the premium kit,
      installed and auto-updated through the Tool Box Manager:
    </p>
    <a href="https://dec18studios.com/clients?join=1" style="display:inline-block;background:#4a8aff;color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:13px 28px;border-radius:8px;letter-spacing:.01em">Get the premium tools →</a>
    <p style="margin:26px 0 0;font-size:14px;color:#cfd2d8;line-height:1.65">
      Stuck on anything, or got footage that's misbehaving? Just reply to this email — it comes straight to me and I'll help.
    </p>
    <p style="margin:24px 0 0;font-size:12px;color:#555;line-height:1.6">
      You're getting this one-time note because you downloaded the Photo Chemist demo from
      <a href="https://tools.dec18studios.com" style="color:#555">tools.dec18studios.com</a> and asked for
      setup tips and release notes. We don't send many.<br><br>
      <a href="${unsub}" style="color:#555">Unsubscribe from Photo Chemist demo emails</a>
    </p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// ── Brevo ─────────────────────────────────────────────────────────────────────
async function brevoSend(to, subject, html) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": BREVO_KEY, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ sender: FROM, to: [{ email: to }], subject, htmlContent: html }),
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

  if (!DL_SECRET) throw new Error("Missing DOWNLOAD_LOGGER_SECRET (needed for unsubscribe links).");

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
