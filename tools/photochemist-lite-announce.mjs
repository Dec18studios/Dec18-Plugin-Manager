#!/usr/bin/env node
/*
 * photochemist-lite-announce.mjs
 *
 * One-off announcement to EVERY free-tool downloader (all slugs in the
 * download-logger), one email per person: PhotoChemist 3.0 has a free Lite
 * edition that renders clean, with no watermark. Never runs on a schedule; a
 * human dispatches every send.
 *
 * Same data source and conventions as demo-welcome-email.mjs. Data AND state
 * live in the download-logger D1 (dec18-downloads.downloads), never in this
 * public repo, because the rows are customer email addresses.
 *
 * Rows are per (email, tool), so everything is aggregated per email:
 *
 *   eligible  = no row unsubscribed                    (opting out of ANY tool counts)
 *               AND no row welcome_sent = 2            (known undeliverable)
 *               AND no row lite_announce_sent <> 0     (not already told, or retired)
 *               AND no PC_SLUG row downloaded >= BEFORE (those already have Lite and
 *                                                        got the Lite welcome email)
 *   variant   = "demo" if they have a PC_SLUG row (so they had the watermarked
 *               build), else "general" (never downloaded PhotoChemist)
 *   per email → Brevo transactional send, tag "photochemist-lite-announce"
 *   success   → UPDATE lite_announce_sent = 1 on ALL of that email's rows
 *               (2 = undeliverable, never retried)
 *
 * The unsubscribe link uses the PC_SLUG row when there is one, else the
 * person's first tool. The Worker opts out that one (email, tool) row, which
 * is enough to keep them out of any rerun of this script.
 *
 * Env:
 *   CLOUDFLARE_API_TOKEN    required (wrangler d1 execute, run from tools/download-logger)
 *   BREVO_API_KEY           required for live sends
 *   DOWNLOAD_LOGGER_SECRET  required to send; the Worker's ADMIN_SECRET, for unsubscribe links
 *   DRY_RUN=1               list masked recipients, send nothing, mark nothing
 *   TEST_EMAIL=addr         send BOTH variants to addr (two emails), mark nothing
 *   RENDER_TO=path          write the general HTML to path and the demo variant to
 *                           path with ".demo" before the extension (placeholder
 *                           unsubscribe link), then exit
 *   BEFORE                  ISO cutoff, default the v3.0.3 release (first unwatermarked
 *                           build); set BEFORE=none to include recent Lite downloaders
 *   MAX_SENDS               per-run cap, default 100. Brevo free tier is 300/day, shared
 *                           with the hourly welcome, licence and OTP mail, so ~560 people
 *                           go out over three days at 200 a dispatch.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = join(__dirname, "download-logger");

const WORKER_URL = "https://dec18-download-logger.dec18studios.workers.dev";
const D1_NAME = "dec18-downloads";

const DRY_RUN = process.env.DRY_RUN === "1";
const TEST_EMAIL = (process.env.TEST_EMAIL || "").trim();
const RENDER_TO = (process.env.RENDER_TO || "").trim();
const PC_SLUG = "photochemist-demo";
// PhotoChemist-Demo v3.0.3 published_at: the first build with no watermark.
const BEFORE_RAW = (process.env.BEFORE || "2026-09-12T23:37:01Z").trim();
const BEFORE = BEFORE_RAW.toLowerCase() === "none" ? "" : BEFORE_RAW;
const MAX_SENDS = Number(process.env.MAX_SENDS || "100");
const TAG = "photochemist-lite-announce";

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

async function ensureAnnounceColumn() {
  // Probe first: wrangler reports a duplicate-column ALTER as exit 1 with the
  // API error on STDOUT (stderr is empty), so catching it by message is fragile.
  const cols = await d1("PRAGMA table_info(downloads)");
  if (cols.some((c) => c.name === "lite_announce_sent")) return;
  try {
    await d1("ALTER TABLE downloads ADD COLUMN lite_announce_sent INTEGER DEFAULT 0");
    console.log("Migrated: added downloads.lite_announce_sent column.");
  } catch (e) {
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
const SITE = "https://tools.dec18studios.com/color-grading-tools/photochemist";

// Public Discord for the tools. Also in demo-welcome-email.mjs and
// license-email-template.mjs; change all three together. Must be a
// never-expiring invite ("expires_at": null from the Discord invites API).
const DISCORD_URL = "https://discord.gg/rvY88mZJPR";

const SUBJECTS = {
  general: "PhotoChemist Lite: my film emulation plugin is now free",
  demo: "PhotoChemist Lite is here, and the watermark is gone",
};

const P = `margin:0 0 12px 0; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:24px; color:#c6ccd4;`;
const LI = `margin:0 0 8px 0; font-family:Arial, Helvetica, sans-serif; font-size:14px; line-height:22px; color:#c6ccd4;`;

// variant "demo" = had the watermarked PhotoChemist demo; "general" = any other free tool.
function emailHTML({ unsub, variant = "general" }) {
  const demo = variant === "demo";
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>PhotoChemist Lite: Free, No Watermark</title>
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
  ${demo
    ? "The free edition of PhotoChemist 3.0 renders clean now. Grab the new build and use it on real work."
    : "My spectral film emulation plugin for Resolve has a free edition now. Clean renders, no watermark."}
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
            <p style="margin:0 0 10px 0; font-family:Arial, Helvetica, sans-serif; font-size:11px; letter-spacing:2px; color:#d9a441; text-transform:uppercase;">${demo ? "New in PhotoChemist 3.0" : "Free for Resolve"}</p>
            <h1 class="h1" style="margin:0 0 16px 0; font-family:Georgia, 'Times New Roman', serif; font-size:30px; line-height:38px; color:#f4f1ea; font-weight:normal;">
              ${demo ? "The watermark is gone" : "PhotoChemist Lite is free, with no watermark"}
            </h1>
            <p style="${P}">
              Hi there!
            </p>
${demo ? `
            <p style="${P}">
              A while back you downloaded the PhotoChemist demo. Thanks again for giving it a shot. I know a watermark across the frame made it hard to do anything real with it.
            </p>
            <p style="${P}">
              So with version 3.0 the demo is now <strong style="color:#f4f1ea;">PhotoChemist Lite</strong>, and it renders clean. <strong style="color:#f4f1ea;">No watermark.</strong> It&rsquo;s free, it&rsquo;s yours to keep, and you can put it on actual client work.
            </p>` : `
            <p style="${P}">
              A while back you grabbed one of my free tools. Thanks for that! I wanted to give you a heads up about a new free one I think you&rsquo;ll actually use.
            </p>
            <p style="${P}">
              <strong style="color:#f4f1ea;">PhotoChemist</strong> is my spectral film emulation plugin for DaVinci Resolve. Instead of stacking a LUT on top, it runs your image through a simulated negative and print, the way film really works.
            </p>
            <p style="${P}">
              With version 3.0 there&rsquo;s a free edition, <strong style="color:#f4f1ea;">PhotoChemist Lite</strong>, and it renders clean. <strong style="color:#f4f1ea;">No watermark.</strong> It&rsquo;s yours to keep, and you can put it on actual client work.
            </p>`}
          </td>
        </tr>

        <!-- What's in Lite -->
        <tr>
          <td style="background-color:#1a1f26; padding:8px 40px 8px 40px;" class="px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#22282f; border-radius:8px;">
              <tr>
                <td style="padding:24px 28px 16px 28px;">
                  <p style="margin:0 0 12px 0; font-family:Arial, Helvetica, sans-serif; font-size:11px; letter-spacing:2px; color:#d9a441; text-transform:uppercase;">What You Get in Lite</p>
                  <p style="${LI}"><span style="color:#d9a441;">&#10003;</span>&nbsp; Clean renders, no watermark</p>
                  <p style="${LI}"><span style="color:#d9a441;">&#10003;</span>&nbsp; The same spectral film engine as the full plugin, negative through print</p>
                  <p style="${LI}"><span style="color:#d9a441;">&#10003;</span>&nbsp; Film stocks and projectors picked from presets</p>
                  <p style="${LI}"><span style="color:#d9a441;">&#10003;</span>&nbsp; macOS, Windows and Linux</p>
                  <p style="margin:12px 0 8px 0; font-family:Arial, Helvetica, sans-serif; font-size:13px; line-height:20px; color:#8a9099;">
                    The deep stuff (Film Stock Editor, Textures editor, Film Motion, Preset Manager, LUT export) stays in the full version.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Download CTA -->
        <tr>
          <td style="background-color:#1a1f26; padding:24px 40px 8px 40px;" class="px">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;">
              <tr>
                <td align="center" bgcolor="#d9a441" style="border-radius:6px;">
                  <a href="${SITE}/#demo" target="_blank" style="display:inline-block; padding:13px 28px; font-family:Arial, Helvetica, sans-serif; font-size:15px; font-weight:bold; color:#111418; text-decoration:none; border-radius:6px;">Download PhotoChemist Lite</a>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 8px 0; font-family:Arial, Helvetica, sans-serif; font-size:14px; line-height:22px; color:#8a9099;">
              ${demo
                ? "Your old demo won&rsquo;t update itself. Delete the old PhotoChemist Demo bundle from your OFX plugins folder, drop in the new one, and restart Resolve. Same setup rule as before: feed it DaVinci Wide Gamut / Linear (a CST with no tone mapping on the node before)."
                : "It&rsquo;s an OFX plugin. Drop it in your OFX plugins folder and restart Resolve. The one setup rule: feed it DaVinci Wide Gamut / Linear (a CST with no tone mapping on the node before)."}
            </p>
            <p style="margin:0 0 12px 0; font-family:Arial, Helvetica, sans-serif; font-size:14px; line-height:22px;">
              <a href="${SITE}/quickstart/" target="_blank" style="color:#f4f1ea; text-decoration:none; font-weight:bold;">Quick-Start Guide &rarr;</a>
            </p>
          </td>
        </tr>

        <!-- Video block -->
        <tr>
          <td style="background-color:#1a1f26; padding:16px 40px 8px 40px;" class="px">
            <p style="margin:0 0 12px 0; font-family:Arial, Helvetica, sans-serif; font-size:11px; letter-spacing:2px; color:#d9a441; text-transform:uppercase;">Where I&rsquo;d Start &bull; 16 Min</p>
            <a href="https://www.youtube.com/watch?v=GFryQzEsaC8" target="_blank" style="text-decoration:none;">
              <img src="https://i.ytimg.com/vi/GFryQzEsaC8/maxresdefault.jpg" width="520" alt="Video: Simulating the Physics of Printer Lights" style="width:100%; max-width:520px; height:auto; border-radius:8px; display:block;">
            </a>
            <p style="margin:14px 0 4px 0; font-family:Georgia, 'Times New Roman', serif; font-size:17px; line-height:23px;">
              <a href="https://www.youtube.com/watch?v=GFryQzEsaC8" target="_blank" style="color:#f4f1ea; text-decoration:none;">Simulating the Physics of Printer Lights &#9654;</a>
            </p>
            <p style="margin:0 0 12px 0; font-family:Arial, Helvetica, sans-serif; font-size:14px; line-height:22px; color:#8a9099;">
              Skip the deep settings and learn to work the printer lights first. Once you can grade the way a color timer would, the whole tool makes sense.
            </p>
          </td>
        </tr>

        <!-- Discord block -->
        <tr>
          <td style="background-color:#1a1f26; padding:20px 40px 8px 40px;" class="px">
            <p style="margin:0 0 6px 0; font-family:Arial, Helvetica, sans-serif; font-size:11px; letter-spacing:2px; color:#d9a441; text-transform:uppercase;">Come Say Hi</p>
            <h2 style="margin:0 0 12px 0; font-family:Georgia, 'Times New Roman', serif; font-size:22px; line-height:28px; color:#f4f1ea; font-weight:normal;">Show us what you make with it</h2>
            <p style="margin:0 0 20px 0; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:24px; color:#c6ccd4;">
              There&rsquo;s a free, public Discord full of people running these tools on real work. Post a frame, swap node trees, ask questions, or just lurk. I am in there most days. And if you&rsquo;d rather keep it private, just reply to this email. It comes straight to me.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px 0;">
              <tr>
                <td align="center" style="border:1px solid #d9a441; border-radius:6px;">
                  <a href="${DISCORD_URL}" target="_blank" style="display:inline-block; padding:12px 26px; font-family:Arial, Helvetica, sans-serif; font-size:15px; font-weight:bold; color:#d9a441; text-decoration:none; border-radius:6px;">Join the Discord</a>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 12px 0; font-family:Arial, Helvetica, sans-serif; font-size:13px; line-height:20px; color:#8a9099;">
              <a href="${DISCORD_URL}" target="_blank" style="color:#8a9099; text-decoration:underline;">${DISCORD_URL.replace("https://", "")}</a>
            </p>
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
            <p style="margin:0 0 6px 0; font-family:Arial, Helvetica, sans-serif; font-size:11px; letter-spacing:2px; color:#d9a441; text-transform:uppercase;">When You Want Everything</p>
            <h2 style="margin:0 0 10px 0; font-family:Georgia, 'Times New Roman', serif; font-size:22px; line-height:28px; color:#f4f1ea; font-weight:normal;">The whole Tool Box is $47.34</h2>
            <p style="${P}">
              That unlocks the full PhotoChemist, plus <strong style="color:#f4f1ea;">every premium DCTL and OFX plugin</strong> in the Tool Box and a year of updates, new tools, and real human support. Your tools keep working even if you never renew, and your rate locks in for good.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 12px 0;">
              <tr>
                <td align="center" style="border:1px solid #d9a441; border-radius:6px;">
                  <a href="https://dec18studios.com/clients?join=1" target="_blank" style="display:inline-block; padding:12px 26px; font-family:Arial, Helvetica, sans-serif; font-size:15px; font-weight:bold; color:#d9a441; text-decoration:none; border-radius:6px;">Get the Whole Tool Box</a>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 8px 0; font-family:Arial, Helvetica, sans-serif; font-size:13px; line-height:20px; color:#8a9099;">
              No pressure. Lite is yours either way.
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
              You&rsquo;re receiving this because you downloaded ${demo ? "the PhotoChemist demo" : "a free tool from Dec. 18 Studios"}.
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
    body: JSON.stringify({ sender: FROM, to: [{ email: to }], subject, htmlContent: html, tags: [TAG] }),
  });
  if (res.status === 201 || res.status === 202) return true;
  let detail = "";
  try { detail = JSON.stringify(await res.json()); } catch {}
  const err = new Error(`Brevo send ${res.status} for ${to}: ${detail}`);
  err.status = res.status;
  throw err;
}

// 4xx other than timeout / rate limit means Brevo will never take this address.
const isPermanentReject = (e) =>
  typeof e?.status === "number" && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;

function looksSendable(email) {
  const m = /^[^\s@,;]+@([^\s@,;.]+\.)+([A-Za-z]{2,})$/.exec(email);
  return !!m && email.length <= 254;
}

const mask = (e) => e.replace(/^(.).*(@.*)$/, "$1***$2");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (RENDER_TO) {
    const unsub = `${WORKER_URL}/unsubscribe?preview=1`;
    const demoPath = /\.[^./]+$/.test(RENDER_TO) ? RENDER_TO.replace(/(\.[^./]+)$/, ".demo$1") : `${RENDER_TO}.demo`;
    writeFileSync(RENDER_TO, emailHTML({ unsub, variant: "general" }));
    writeFileSync(demoPath, emailHTML({ unsub, variant: "demo" }));
    console.log(`Rendered general to ${RENDER_TO} and demo to ${demoPath}. Nothing sent.`);
    return;
  }

  console.log(`\nPhotoChemist Lite announcement, all free-tool downloaders${BEFORE ? `, skipping ${PC_SLUG} downloads since ${BEFORE}` : ""}${DRY_RUN ? "  (DRY RUN)" : ""}${TEST_EMAIL ? `  (TEST to ${TEST_EMAIL})` : ""}\n`);

  if (!DRY_RUN && !DL_SECRET) throw new Error("Missing DOWNLOAD_LOGGER_SECRET (needed for unsubscribe links).");

  if (TEST_EMAIL) {
    if (!BREVO_KEY) throw new Error("Missing BREVO_API_KEY.");
    for (const variant of ["general", "demo"]) {
      await brevoSend(TEST_EMAIL, `[TEST ${variant}] ${SUBJECTS[variant]}`, emailHTML({ unsub: unsubUrl(TEST_EMAIL, PC_SLUG), variant }));
    }
    console.log(`Sent both variants to ${TEST_EMAIL}. Nothing marked in D1.\n`);
    return;
  }

  if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error("Missing CLOUDFLARE_API_TOKEN (needed for D1).");
  if (!DRY_RUN && !BREVO_KEY) throw new Error("Missing BREVO_API_KEY.");

  // Dry run must not alter the schema, so only probe there.
  const cols = await d1("PRAGMA table_info(downloads)");
  const hasCol = cols.some((c) => c.name === "lite_announce_sent");
  if (!DRY_RUN) await ensureAnnounceColumn();
  const notYet = hasCol || !DRY_RUN ? "AND MAX(COALESCE(lite_announce_sent, 0)) = 0 " : "";
  const notRecentLite = BEFORE
    ? `AND MAX(CASE WHEN tool_slug = ${sq(PC_SLUG)} AND last_downloaded >= ${sq(BEFORE)} THEN 1 ELSE 0 END) = 0 `
    : "";

  // The Worker lowercases on /log, so email is already the per-person key.
  const rows = await d1(
    `SELECT email, ` +
    `MAX(CASE WHEN tool_slug = ${sq(PC_SLUG)} THEN 1 ELSE 0 END) AS had_demo, ` +
    `MIN(tool_slug) AS first_slug, COUNT(*) AS tools, MAX(last_downloaded) AS last_downloaded ` +
    `FROM downloads GROUP BY email ` +
    `HAVING MAX(unsubscribed) = 0 AND MAX(COALESCE(welcome_sent, 0)) <> 2 ` +
    `${notYet}${notRecentLite}` +
    `ORDER BY had_demo DESC, last_downloaded DESC`
  );

  const demoCount = rows.filter((r) => Number(r.had_demo) === 1).length;
  console.log(`Eligible people: ${rows.length}  (demo variant: ${demoCount}, general: ${rows.length - demoCount})`);
  for (const r of rows) {
    const v = Number(r.had_demo) === 1 ? "demo" : "general";
    console.log(`  ${mask(r.email).padEnd(28)} ${v.padEnd(8)} tools:${String(r.tools).padEnd(3)} last:${(r.last_downloaded || "").slice(0, 10)}`);
  }
  console.log("");

  if (DRY_RUN) { console.log("Dry run: nothing sent, nothing marked.\n"); return; }
  if (!rows.length) { console.log("Nothing to do.\n"); return; }

  const batch = rows.slice(0, MAX_SENDS);
  if (rows.length > batch.length) {
    console.log(`Capped at MAX_SENDS=${MAX_SENDS}; ${rows.length - batch.length} left for the next dispatch.\n`);
  }

  // Mark every row for the person, so a rerun never picks them up via another tool.
  const mark = (email, v) =>
    d1(`UPDATE downloads SET lite_announce_sent = ${v} WHERE email = ${sq(email)}`);

  let sent = 0, failed = 0, skipped = 0;
  for (const r of batch) {
    const email = r.email.trim().toLowerCase();
    const variant = Number(r.had_demo) === 1 ? "demo" : "general";
    const unsubSlug = variant === "demo" ? PC_SLUG : r.first_slug;
    if (!looksSendable(email)) {
      await mark(r.email, 2);
      skipped++;
      console.log(`  - ${mask(email)}: not a valid address, retired`);
      continue;
    }
    try {
      await brevoSend(email, SUBJECTS[variant], emailHTML({ unsub: unsubUrl(email, unsubSlug), variant }));
      await mark(r.email, 1);
      sent++;
      console.log(`  ✓ ${mask(email)} (${variant})`);
    } catch (e) {
      const msg = String(e.message || e).slice(0, 200);
      if (isPermanentReject(e)) {
        await mark(r.email, 2);
        skipped++;
        console.log(`  - ${mask(email)}: rejected by Brevo, retired: ${msg}`);
      } else {
        failed++;
        console.log(`  ✖ ${mask(email)}: ${msg}`);
      }
    }
    await sleep(200);
  }

  console.log(`\nDone. sent:${sent}  skipped:${skipped} (retired)  failed:${failed} (retry next dispatch)\n`);
  if (failed && !sent) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
