#!/usr/bin/env node
/*
 * monthly-update-announce.mjs
 *
 * The monthly update newsletter, in two versions, to two audiences that do not
 * overlap. Never runs on a schedule. A human dispatches every send, and the
 * default of a bare invocation is a dry run that cannot send.
 *
 * Modelled on tools/photochemist-lite-announce.mjs: same D1-backed state, same
 * masked logging, same Brevo transactional send, same house email layout as
 * tools/demo-welcome-email.mjs and tools/license-email-template.mjs.
 *
 * ── THE TWO AUDIENCES ────────────────────────────────────────────────────────
 *
 *   member  the people who bought a licence. Source of truth is
 *           processed-subscribers.json in the PRIVATE license-ledger repo,
 *           pointed at by LICENSE_LEDGER_DIR (same convention as
 *           fulfill-licenses.mjs and auth-worker/import-subscribers.mjs). It is
 *           a dict keyed by customer email. Read only: nothing from it is
 *           written anywhere, and no address from it is ever printed unmasked.
 *
 *   free    the people who only ever took a free tool at the website download
 *           gate. Source of truth is the download-logger D1
 *           (dec18-downloads.downloads), reached with wrangler from
 *           tools/download-logger. Rows are per (email, tool), so everything is
 *           aggregated per email.
 *
 * ── DE-DUPLICATION: MEMBERS WIN, ALWAYS ──────────────────────────────────────
 *
 * Plenty of members grabbed a free tool before they bought, so they sit in both
 * lists. The rule is one email per person and the paid version wins:
 *
 *   memberSet = every email in the ledger, trimmed and lowercased
 *   freeSet   = every email in D1 downloads, trimmed and lowercased,
 *               MINUS memberSet
 *
 * The subtraction happens in this script, in JS, against a Set. It is not done
 * in SQL, because the ledger lives in a private repo and its addresses must
 * never be interpolated into a query that could end up in a public Actions log.
 * The Worker already lowercases on /log and the ledger reader lowercases here,
 * so a plain lowercased string compare is the whole key. Nobody receives both
 * versions, and a member who is also a downloader gets the member version.
 *
 * ── SUPPRESSION AND IDEMPOTENCE ──────────────────────────────────────────────
 *
 * lite_announce_sent was a one-off column on downloads. This is a monthly
 * campaign, so a column per month does not scale and members are not all in
 * downloads at all. Same semantics, moved into its own table keyed by campaign:
 *
 *   state 0 / absent  not told yet
 *   state 1           sent, never send again
 *   state 2           retired: invalid address or a permanent Brevo reject,
 *                     never retried, for THIS or any later campaign
 *
 * A person is eligible when all of these hold:
 *
 *   no row in newsletter_optouts                     (newsletter opt-out)
 *   no campaign_sends row for CAMPAIGN with state<>0 (not already told)
 *   no campaign_sends row at all with state = 2      (known undeliverable)
 *   no downloads row with unsubscribed = 1           (opting out of ANY tool counts)
 *   no downloads row with welcome_sent = 2           (known undeliverable)
 *
 * A successful send writes campaign_sends state 1 BEFORE the next send, so a
 * crash mid-run never double-sends anyone already marked, and a rerun resumes
 * where it stopped.
 *
 * ── MIGRATION ──────────────────────────────────────────────────────────
 *
 * Both tables live in tools/download-logger/schema.sql, which is the one copy
 * of the schema. They were applied to dec18-downloads on 2026-10-20. To rebuild
 * the database, or to check the live schema still matches the repo:
 *
 *   cd tools/download-logger
 *   npx --yes wrangler@4 d1 execute dec18-downloads --remote --file=schema.sql
 *
 * Every statement in that file is CREATE ... IF NOT EXISTS, so running it again
 * is a no-op. This script never migrates anything itself: it refuses to send
 * live if either table is missing, and says which one.
 *
 * ── UNSUBSCRIBE ──────────────────────────────────────────────────────────────
 *
 * Every recipient gets the same real one-click link, GET /newsletter-optout on
 * the download-logger Worker, signed with newsletterToken(). It is keyed on the
 * address alone, so it works for buyers who never used the free download gate
 * and have no downloads row to flag. Clicking it writes newsletter_optouts AND
 * sets unsubscribed = 1 on any downloads rows the address has, because somebody
 * clicking unsubscribe means stop the marketing mail, not stop one list of it.
 *
 * Each send also carries List-Unsubscribe and List-Unsubscribe-Post, so Gmail
 * and Yahoo show their own native unsubscribe button and POST the same route
 * (RFC 8058). Bulk mail without that pair gets treated as a spam signal. The
 * headers go out only when the link is a real https /newsletter-optout URL,
 * never for a preview, since the POST has to actually work if we advertise it.
 *
 * The Worker's older per-tool GET /unsubscribe route is untouched and still
 * serves release-announce mail. This campaign does not use it: one address can
 * own a dozen tools, and opting out of the newsletter is not per-tool.
 *
 * ── Env ──────────────────────────────────────────────────────────────────────
 *   DRY_RUN                 defaults to ON. Lists masked recipients, sends
 *                           nothing, marks nothing. DRY_RUN=0 alone does NOT
 *                           arm a live send.
 *   CONFIRM_SEND=yes-send-for-real
 *                           the ONLY way to arm a live dispatch. Without it,
 *                           every invocation is a dry run.
 *   TEST_EMAIL=addr         send one of EACH version to addr (two emails),
 *                           mark nothing, touch no state.
 *   RENDER_TO=path          write the HTML and plain text to disk and exit. If
 *                           path is a directory (or ends in a slash) it writes
 *                           newsletter-free.html, newsletter-free.txt,
 *                           newsletter-member.html, newsletter-member.txt into
 *                           it. Otherwise it writes path with ".free" / ".member"
 *                           before the extension, lite-announce style. Uses a
 *                           placeholder unsubscribe link.
 *   AUDIENCE=free|member|both     default both.
 *   LICENSE_LEDGER_DIR      checkout of the private license-ledger repo.
 *                           Required for the member audience.
 *   CLOUDFLARE_API_TOKEN    only if wrangler is not already logged in. A normal
 *                           `wrangler login` with d1 write covers everything here.
 *   BREVO_API_KEY           required for live sends and for TEST_EMAIL.
 *   DOWNLOAD_LOGGER_SECRET  the Worker's ADMIN_SECRET, used to build the same
 *                           opt-out token the Worker verifies. Optional: falls
 *                           back to tools/license-keys/download-logger-secret.txt,
 *                           which is where it actually lives and is gitignored.
 *   SKIP_MASTER=1           drop ledger entries whose key decodes to tier
 *                           "master". Off by default: the 6 master keys hold
 *                           full toolbox access and do get the member version.
 *   MAX_SENDS               per-run cap, default 75.
 *   DAILY_BUDGET            newsletter sends allowed per calendar day (UTC),
 *                           default 225, leaving 75 of Brevo's 300 for
 *                           transactional mail. The run caps itself at whatever
 *                           is left of this and stops cleanly at zero.
 *
 * ── BATCHING MATHS ───────────────────────────────────────────────────────────
 *
 * Brevo's free tier is 300 emails a day and this campaign does not get it to
 * itself. The hourly demo-welcome run, licence fulfillment and the sign-in OTP
 * mail all draw on the same 300, and OTP is the one that must never bounce off
 * a quota wall, because a member who cannot sign in cannot install anything.
 *
 * The reserve is sized from measured traffic, not a guess. Over 2026-10-01 to
 * 10-22 the download gate averaged about 10 distinct addresses a day and peaked
 * at 34 on release day, and welcome mail is one per new address. So 75 a day is
 * roughly twice the observed peak with room for licence and OTP mail on top,
 * which leaves 225 for the newsletter.
 *
 * Do not reach for the full 300. Going past 250 buys literally no time: 926
 * recipients is 4 days at 250 and still 4 days at 300, so the last 50 a day
 * only costs you the entire safety margin. If a release lands mid-newsletter,
 * that margin is what keeps new buyers getting their keys.
 *
 * You do not have to do that arithmetic yourself. Before each batch the script
 * counts the campaign_sends rows already written today (every campaign, and
 * retired addresses too, since a Brevo rejection still spent a send), subtracts
 * that from DAILY_BUDGET, and caps the batch at whichever of that and MAX_SENDS
 * is smaller. At zero it stops without sending and tells you to come back
 * tomorrow. Every run ends by saying whether to run it again now or tomorrow,
 * and how many are still waiting.
 *
 * So the whole dispatch is: run the same command, read the last line, do what
 * it says. Reruns are safe, because a sent address is marked before the next
 * send goes out and marked addresses are not eligible again.
 *
 * MAX_SENDS=75 with DAILY_BUDGET=225 means three batches a day. Both audiences
 * together came to about 930 addresses in October, so a full newsletter is five
 * days of dispatches, not an evening. Run the dry run first every time: it
 * prints today's remaining budget, how many go out on the next run, and roughly
 * how many days the whole list takes.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = join(__dirname, "download-logger");

const WORKER_URL = "https://dec18-download-logger.dec18studios.workers.dev";
const D1_NAME = "dec18-downloads";

const CAMPAIGN = "monthly-2026-10";
const TAG = "monthly-update-2026-10";

// The ONLY way to arm a live send. DRY_RUN=0 on its own is still a dry run.
const LIVE = process.env.CONFIRM_SEND === "yes-send-for-real";
const DRY_RUN = !LIVE;
const TEST_EMAIL = (process.env.TEST_EMAIL || "").trim();
const RENDER_TO = (process.env.RENDER_TO || "").trim();
const AUDIENCE = (process.env.AUDIENCE || "both").trim().toLowerCase();
const SKIP_MASTER = process.env.SKIP_MASTER === "1";
const MAX_SENDS = Number(process.env.MAX_SENDS || "75");
// Brevo's free tier is 300 emails/day across EVERY sender in this repo: hourly
// welcome mail, licence delivery and OTP sign-in all draw on the same bucket.
// Reserve half of it for that transactional traffic, because a colourist who
// cannot sign in is a worse outcome than a newsletter that takes an extra day.
const DAILY_BUDGET = Number(process.env.DAILY_BUDGET || "225");

const BREVO_KEY = (process.env.BREVO_API_KEY || "").trim();
// The Worker's ADMIN_SECRET, used to sign unsubscribe links. Nothing exports it
// into the shell, and a missing one is invisible: the links still build, they just
// get rejected as bad tokens after the mail has gone out. So fall back to the
// gitignored file it actually lives in. The env var still wins when it is set.
const DL_SECRET_FILE = join(__dirname, "license-keys", "download-logger-secret.txt");
function loadDlSecret() {
  const fromEnv = (process.env.DOWNLOAD_LOGGER_SECRET || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(DL_SECRET_FILE, "utf8").trim();
  } catch {
    return "";
  }
}
const DL_SECRET = loadDlSecret();
const LEDGER_DIR = (process.env.LICENSE_LEDGER_DIR || "").trim();

const FROM = { name: "Dec 18 Studios", email: "create@dec18studios.com" };

if (!["free", "member", "both"].includes(AUDIENCE)) {
  console.error(`AUDIENCE must be free, member or both (got ${JSON.stringify(AUDIENCE)}).`);
  process.exit(1);
}

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
const mask = (e) => String(e).replace(/^(.).*(@.*)$/, "$1***$2");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (e) => String(e).trim().toLowerCase();

function looksSendable(email) {
  const m = /^[^\s@,;]+@([^\s@,;.]+\.)+([A-Za-z]{2,})$/.exec(email);
  return !!m && email.length <= 254;
}

// ── the private ledger: member audience, read only ────────────────────────────
function base64urlDecode(str) {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

// Same key format as auth-worker/import-subscribers.mjs: D18.<payload>.<sig>
function decodeKeyTier(key) {
  try {
    const parts = String(key).split(".");
    if (parts.length !== 3 || parts[0] !== "D18") return null;
    return JSON.parse(base64urlDecode(parts[1]).toString("utf8")).t || null;
  } catch {
    return null;
  }
}

/**
 * Member addresses, lowercased. Returns { emails, masterCount } and nothing
 * else: no names, no keys, no notes. Deliberately narrow so this script cannot
 * leak ledger fields into a log.
 */
function readMemberEmails() {
  if (!LEDGER_DIR) {
    throw new Error(
      "Missing LICENSE_LEDGER_DIR. Set it to a checkout of the private license-ledger repo, " +
        "or run with AUDIENCE=free."
    );
  }
  const path = join(LEDGER_DIR, "processed-subscribers.json");
  const ledger = JSON.parse(readFileSync(path, "utf8"));
  const emails = [];
  let masterCount = 0;
  for (const [emailRaw, rec] of Object.entries(ledger)) {
    const email = norm(emailRaw);
    if (!email) continue;
    const tier = (rec && rec.tier) || decodeKeyTier(rec && rec.key);
    if (tier === "master") {
      masterCount++;
      if (SKIP_MASTER) continue;
    }
    emails.push(email);
  }
  return { emails: [...new Set(emails)], masterCount };
}

// Newsletter opt-out. Keyed on the address alone, not on a tool, so it works for
// buyers who never used the free download gate and therefore have no downloads
// row to flag. Must match newsletterToken() in download-logger/worker.js. The
// Worker's older per-tool /unsubscribe route still serves release-announce mail;
// this campaign does not use it, because one address can own many tools.
function newsletterToken(email) {
  return createHash("sha256")
    .update(`newsletter-optout:${email}:${DL_SECRET}`)
    .digest("hex")
    .slice(0, 16);
}
function newsletterUnsubUrl(email) {
  return `${WORKER_URL}/newsletter-optout?email=${encodeURIComponent(email)}&token=${newsletterToken(email)}`;
}

// ── shared links ──────────────────────────────────────────────────────────────
const MANAGER_URL = "https://github.com/Dec18studios/Dec18-Plugin-Manager/releases/latest/";
const ALL_TOOLS_URL = "https://dec18studios.com/all-tools";
const ACCOUNT_URL = "https://dec18studios.com/account";
const SITE = "https://tools.dec18studios.com/color-grading-tools";
const COLOR_THEORY_URL = `${SITE}/color-theory/`;
const LOOK_NOTES_URL = `${SITE}/look-notes/`;
const PHOTOCHEMIST_URL = `${SITE}/photochemist`;
const PRICING_URL = `${SITE}/pricing/`;
const JOIN_URL = "https://dec18studios.com/clients?join=1";

// Public Discord for the tools. Also in demo-welcome-email.mjs,
// license-email-template.mjs and photochemist-lite-announce.mjs; change all
// four together. Must be a never-expiring invite ("expires_at": null from the
// Discord invites API).
const DISCORD_URL = "https://discord.gg/rvY88mZJPR";

const SUBJECTS = {
  free: "Color Theory 1.2.0 is out, and five new modes with it",
  member: "October: Technicolor DRT presets, GD DRT Pro, and a new halation default",
};

const PREHEADERS = {
  free: "Five new illusion modes, a dye layer breakdown that runs on your own footage, and a short note on what the paid tools got.",
  member: "Technicolor DRT gets a Preset Manager, Gradient Domain gets GD DRT Pro, and PhotoChemist changes its starting defaults.",
};

// ── house style, lifted from demo-welcome-email.mjs ──────────────────────────
const P = `margin:0 0 12px 0; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:24px; color:#c6ccd4;`;
const LI = `margin:0 0 10px 0; font-family:Arial, Helvetica, sans-serif; font-size:14px; line-height:22px; color:#c6ccd4;`;
const SMALL = `margin:0 0 12px 0; font-family:Arial, Helvetica, sans-serif; font-size:13px; line-height:20px; color:#8a9099;`;
const KICKER = `margin:0 0 8px 0; font-family:Arial, Helvetica, sans-serif; font-size:11px; letter-spacing:2px; color:#d9a441; text-transform:uppercase;`;
const H2 = `margin:0 0 12px 0; font-family:Georgia, 'Times New Roman', serif; font-size:22px; line-height:28px; color:#f4f1ea; font-weight:normal;`;

const bullet = (html) =>
  `<p style="${LI}"><span style="color:#d9a441;">&#9656;</span>&nbsp; ${html}</p>`;
const strong = (s) => `<strong style="color:#f4f1ea;">${s}</strong>`;

/** A padded content row inside the dark card. */
const row = (inner, pad = "8px 40px") =>
  `        <tr>
          <td style="background-color:#1a1f26; padding:${pad};" class="px">
${inner}
          </td>
        </tr>`;

/** A full-width primary (gold fill) button. */
const primaryBtn = (href, label) =>
  `            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 16px 0;">
              <tr>
                <td align="center" bgcolor="#d9a441" style="border-radius:6px;">
                  <a href="${href}" target="_blank" style="display:inline-block; padding:13px 28px; font-family:Arial, Helvetica, sans-serif; font-size:15px; font-weight:bold; color:#111418; text-decoration:none; border-radius:6px;">${label}</a>
                </td>
              </tr>
            </table>`;

/** An outlined secondary button. */
const ghostBtn = (href, label) =>
  `            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 12px 0;">
              <tr>
                <td align="center" style="border:1px solid #d9a441; border-radius:6px;">
                  <a href="${href}" target="_blank" style="display:inline-block; padding:12px 26px; font-family:Arial, Helvetica, sans-serif; font-size:15px; font-weight:bold; color:#d9a441; text-decoration:none; border-radius:6px;">${label}</a>
                </td>
              </tr>
            </table>`;

/** A nested panel, used for the per-plugin blocks. */
const panel = (kicker, heading, inner) =>
  `            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#22282f; border-radius:8px;">
              <tr>
                <td style="padding:24px 28px 16px 28px;">
                  <p style="${KICKER}">${kicker}</p>
                  <h2 style="${H2}">${heading}</h2>
${inner}
                </td>
              </tr>
            </table>`;

const divider = () =>
  row(
    `            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="border-top:1px solid #2c333d; font-size:0; line-height:0;">&nbsp;</td></tr>
            </table>`,
    "20px 40px"
  );

// ── the copy ──────────────────────────────────────────────────────────────────
// Per-plugin blocks are written once and reused, so the two versions never
// drift. displayName strings are verbatim from docs/plugins/index.json.

const CT_LEAD = [
  bullet(
    `${strong("Dye Layer Stack.")} Three dye layers stack in density, so light passing through multiplies. Compare a film layer against a flat veil, watch overlapping dyes build new colours, then pull the layers apart and stack them back together.`
  ),
  bullet(
    `${strong("Dye Layer Separation.")} This one runs on your own clip. It splits the picture into its cyan, magenta and yellow dye layers, lets you switch, gain or kill each one, and restacks them. View a single layer, the density, or side by side strips.`
  ),
  bullet(
    `${strong("Surround A/B.")} Two identical patches, one on a bright surround and one on a dark surround, set in stops around mid grey. Master exposure, a link that increments and decrements together, and a readout that says SAME VALUE when the numbers really do match.`
  ),
  bullet(
    `${strong("Crispening Ladder.")} Even steps in stops on a surround you control, laid out as a row, as pairs, or as a grid that climbs both ways from a black corner. The steps nearest the surround are the ones that look the most different.`
  ),
  bullet(
    `${strong("Viewing Matte.")} Shrinks your clip onto a uniform matte. Store a dark matte and a bright matte, flip between them, and watch the same picture change.`
  ),
  `<p style="${SMALL}">Every new mode ships with Demo presets that set the sliders for you, so you can see the thing working before you start poking at it.</p>`,
].join("\n");

const CT_SINCE_LAUNCH = [
  bullet(
    `Four scene linear test frames: Blue Bar, Red Christmas Lights, Light Saber and Diver. Each one names the colour space it is stored in and says where a poor picture formation breaks the picture. Output is untouched linear by default, so put a Colour Space Transform after the node and judge your own pipeline.`
  ),
  bullet(
    `Image Options gained a DaVinci Wide Gamut / Intermediate output. Rec.709, sRGB and ARRI Wide Gamut 4 sources get converted and encoded with the Intermediate curve, no clamp, so the node drops straight into a DWG/I timeline.`
  ),
  bullet(
    `Palette Reconstruction gained a Sampled From Image preset. It reads the frame every render, finds the colours that cover most of it, and fills the palette in coverage order, Colour 1 being the most common. Colour Count still sets how many.`
  ),
  bullet(
    `RGB Chips: a clean chip chart with primaries, secondaries and ramps, now matching the RGB Chips DCTL control for control. Output leaves the node raw, so put a Colour Space Transform after it.`
  ),
  bullet(
    `Perceived Luminance Visualizer: a hue sweep with grey ramp shutters and markers where the grey matches the hue. Shutter Count 0 turns the shutters off and leaves just the sweep, and the corner swatch reads out the perceived luminance percentage.`
  ),
  `<p style="${SMALL}">The download is about 51 MB now, because the test frames are bundled in.</p>`,
].join("\n");

const TDRT_BLOCK = [
  `<p style="${P}">The big one this month. Two releases, and between them the whole preset and editor side got rebuilt.</p>`,
  bullet(
    `${strong("Preset Manager.")} Save, update, rename, delete, import and export your own presets as .json for Full Preset, Full Neg Preset, Neg Sensitivity, Neg Dye, Neg HD Curve, Dye Shaping and Textures. It also lists your PhotoChemist presets read only, with PhotoChemist Full presets showing under Full Neg.`
  ),
  bullet(
    `${strong("Full Preset menu with four built in looks:")} Modern (Single Stock plus Xenon), 3 Strip (Process 4 plus White Flame arc), 2 Strip (Process 3 plus Carbon Arc) and 2 Strip Blue (Process 3 plus Xenon). Your own saved whole looks live in the same menu, and every preset menu now shows "(Custom)" the moment you change anything, including curves you draw in the Film Stock Editor.`
  ),
  bullet(
    `${strong("Auto Calibrate")} keeps mid grey printing neutral at your Calibration Target when you change stock, dyes or process. It works in Single Stock, Process 3 and Process 4.`
  ),
  bullet(
    `${strong("Halation Model choice:")} Roadshow or Roadshow 2.0, where brighter sources glow more and the glow takes the colour of the source. There is also a new hue and amount puck in the Textures editor, so halation colour and strength are one drag.`
  ),
  bullet(
    `${strong("Grain Model choice:")} Classic or Emulsion. Grain no longer goes blotchy at high Grain Intensity, which was most obvious on 16mm.`
  ),
  bullet(
    `${strong("MTF rework.")} New MTF Pressure slider plus per channel Bump Width and Fine Crispness. High Pressure settings no longer ring or fringe.`
  ),
  bullet(
    `${strong("Input Primaries")} for ARRI Wide Gamut 3, DaVinci Wide Gamut, Sony S-Gamut3 and ACES AP0. Classic keeps the old behaviour, so nothing you already graded moves.`
  ),
  bullet(
    `${strong("Editors follow the clip.")} With Follow clip on, the Film Stock Editor, Textures and Dye Designer jump to the matching node when you change clips, on Mac and Windows. Each editor has a node picker to step between nodes on the clip, and a Link button to grab the right one when the editor is pointing somewhere else. Edits saving to the wrong node is fixed.`
  ),
  bullet(
    `${strong("Live preview light")} in the editors: a dot reads Live, Connecting or Not live, with a note on turning on Resolve's external scripting when it is not connected.`
  ),
  bullet(
    `Carbon Arc and White Flame bulbs are rescaled to 100 percent brightness, so they stop scorching highlights.`
  ),
  bullet(
    `Fixed a startup crash when Technically Technicolor DRT was loaded alongside other Dec 18 plugins.`
  ),
  `<p style="${SMALL}">Mac: editor windows remember where you put them, open in dark mode, and Textures and the Film Stock Editor open in Single View on the page you asked for. Single View now pans and zooms, drag to pan, scroll to zoom up to 20x, double click to jump in on a spot and again to come back. The Dye Designer scrolls and resizes like the rest. Windows: the viewer always catches up to your last edit, and the Film Stock Editor got live preview too.</p>`,
].join("\n");

const GD_BLOCK = [
  bullet(
    `${strong("New tool: GD DRT Pro.")} A display render built on the gradient solve, with the Records tonal engine. The picture is built from three overlapping film like records and recombined as dye density, so colour gradations stay smooth and the neutral axis stays put.`
  ),
  bullet(
    `${strong("Built in looks.")} Balanced Modernity, Faded Glory or Silver Screen from the Preset menu, or Save, Export and Import your own.`
  ),
  bullet(
    `${strong("White Mode menu.")} SDR sets 100 nits. SDR as HDR 203 Nits Diffuse sets 406 nits with the body of the picture sitting at 203.`
  ),
  bullet(
    `${strong("Reference Monitor and Display Encode.")} Grade on a Gamma 2.4 monitor and switch to PQ or HLG without the look changing character. SDR Monitor White and Black trim to match the monitor you actually grade on.`
  ),
  bullet(
    `${strong("Film Textures (Beta).")} Grain and halation picked by gauge, 65mm, 35mm or 16mm, with a Grain Strength slider. Off by default.`
  ),
  bullet(
    `${strong("Much faster at 4K on Mac.")} GD DRT Pro went from about 7 fps to about 40 fps on a 4K timeline, with the exact same picture coming out the other end.`
  ),
  bullet(
    `${strong("Windows and Linux:")} Razzle Dazzle, HDR Restore, Structure Metric and the Achromatic Test and Colour Leak views now render on CUDA, and GPU memory is reused between frames for smoother playback.`
  ),
].join("\n");

const PC_BLOCK = [
  bullet(
    `${strong("Roadshow 2.0 is the new default halation model.")} The glow scales with how bright the source is, so practicals and specular hits bloom more than a white wall does.`
  ),
  bullet(
    `${strong("Auto Calibrate")} keeps mid grey printing neutral as you change stocks or development, and Calibration Target sets where that grey lands, 40 IRE by default. It no longer re-solves when you change Film Development, so push, pull, bleach bypass and the rest are yours to grade back with the printer lights, like a lab would.`
  ),
  bullet(
    `${strong("New intensity trims:")} Grain Intensity, Halation Intensity, Halation Spread and MTF Intensity. They push the current look up or down without touching the underlying settings.`
  ),
  bullet(
    `${strong("Textures editor:")} halation puck with per channel controls, and a cleaned up layout across Textures and the Film Stock Editor. Printer Calibration has its own group now, and Lamp Ceiling plus the Deep Black controls moved into Advanced Trims.`
  ),
  bullet(
    `${strong("Editor live preview is legible at last.")} Both editors show a small Live / Not live indicator so you know whether the viewer will update as you edit, with a short note on turning it on when it is off. Previews no longer jump to a random clip or frame when you change a setting, the link label stops flickering when a timeline node and clip nodes are both in play, and a linked editor says "Linked to the timeline PhotoChemist node" and stays that way.`
  ),
  bullet(
    `${strong("Negative Spectral Sharpening")} now starts at 0.2 instead of 0.5 on new nodes, which reads closer to the print side.`
  ),
  bullet(
    `${strong("Fixes:")} on Linux, the crash as soon as PhotoChemist was added to a node is gone. On Windows, the viewer lands on the final frame after a drag in the editors instead of sticking on an in-between one.`
  ),
].join("\n");

const LN_BLOCK = [
  `<p style="${P}">Look Notes is Look Notes Pro now and it is part of the membership, so it is already yours. Three releases, and the client-facing export side is the headline.</p>`,
  bullet(
    `${strong("Export All Looks.")} Pick a folder and it switches to each look in turn, saves a still of the frame named with that look's label and the date, then puts your original look back.`
  ),
  bullet(
    `${strong("Build Grid.")} Export All Looks also saves a Look Grid image with every look side by side, ready to send to a client.`
  ),
  bullet(
    `${strong("Export Current Look.")} One click saves the frame exactly as it is right now into your last export folder and shows you the file. Export again after changes and it adds _2, _3 and so on.`
  ),
  bullet(
    `${strong("Still Format:")} PNG, JPG or 16 bit TIFF. The Look Grid is not available with JPG.`
  ),
  bullet(
    `${strong("Reframe.")} Bottom Strip or Side Panel. The picture shrinks to fit and the notes get their own panel instead of sitting on the image, with Panel Size, Background and Background Brightness controls.`
  ),
  bullet(
    `${strong("Palette.")} 3 to 12 colour swatches pulled from the image and shown in the reframe panel. Sort by hue, dominance or brightness, and skip near blacks, near whites and greys.`
  ),
  bullet(
    `Node toggling works on Windows now, which needs Python 3 from python.org, and it is always on, so the Toggle Look Nodes switch is gone. EB Garamond is bundled, so Garamond mode works even without a system Garamond. Saved projects keep their looks, notes and settings.`
  ),
].join("\n");

// ── FREE VERSION ──────────────────────────────────────────────────────────────
function freeBody() {
  return [
    row(
      `            <p style="${KICKER}">Out today, still free</p>
            <h1 class="h1" style="margin:0 0 16px 0; font-family:Georgia, 'Times New Roman', serif; font-size:30px; line-height:38px; color:#f4f1ea; font-weight:normal;">Color Theory 1.2.0, and five new ways to break your own eyes</h1>
            <p style="${P}">Hi there,</p>
            <p style="${P}">You grabbed one of my free tools at some point, so here is the monthly note on where they stand. ${strong("Color Theory")} shipped a new version today and it is the bulk of this email. There is a short, honest paragraph at the bottom about what the paid tools got, and you can ignore it without hurting my feelings.</p>`,
      "40px 40px 8px 40px"
    ),

    row(
      panel(
        "New in 1.2.0",
        "Five new modes",
        `                  <p style="${P}">Color Theory draws colour vision illusions straight onto your timeline, one at a time, with a commentary overlay that explains what you are looking at. The Reveal slider gives the trick away, and you can keyframe it to wipe the answer in on camera. No key, no watermark, no sign up.</p>
${CT_LEAD}`
      )
    ),

    row(
      `            <p style="${KICKER}">If you are still on the first build</p>
            <h2 style="${H2}">Everything else added since launch</h2>
            <p style="${P}">Color Theory only went out in late September, so there is a decent chance you have 1.0.0 and have not seen any of this.</p>
${CT_SINCE_LAUNCH}`,
      "24px 40px 8px 40px"
    ),

    row(`${primaryBtn(COLOR_THEORY_URL, "Get Color Theory")}`, "8px 40px 0 40px"),

    divider(),

    row(
      `            <p style="${KICKER}">Easy to miss</p>
            <h2 style="${H2}">Two more free editions</h2>
            <p style="${P}">Neither of these is new this month, but people keep telling me they did not know they existed.</p>
${bullet(`${strong("PhotoChemist Lite.")} The free edition of my spectral film emulation plugin. It renders clean, no watermark, and you get the whole preset library plus the Film Stock Editor, so you can draw your own sensitivity, dye and H&amp;D curves. <a href="${PHOTOCHEMIST_URL}" target="_blank" style="color:#d9a441; text-decoration:none;">Have a look &rarr;</a>`)}
${bullet(`${strong("Look Notes Lite.")} Burns a look label and notes into the frame for client sessions, and flips your look nodes for you when you change the active look. Clip level or timeline level, split looks included. <a href="${LOOK_NOTES_URL}" target="_blank" style="color:#d9a441; text-decoration:none;">Have a look &rarr;</a>`)}
            <p style="${SMALL}">Both are free and yours to keep.</p>`,
      "0 40px 8px 40px"
    ),

    divider(),

    row(
      `            <p style="${KICKER}">For the record</p>
            <h2 style="${H2}">What the paid tools got this month</h2>
            <p style="${P}">Not a pitch, just so you know what is going on over there.</p>
${bullet(`${strong("Technically Technicolor DRT")} picked up a full Preset Manager, four built in looks, an Auto Calibrate that holds mid grey neutral when you change stock or process, a second halation model where brighter sources glow more, a new grain model, and an MTF rework that stops high pressure settings ringing.`)}
${bullet(`${strong("Gradient Domain Grading Tools")} got a whole new tool, GD DRT Pro: a display render built on the gradient solve, with three overlapping records recombined as dye density. It also went from about 7 fps to about 40 fps at 4K on Mac for the same picture.`)}
${bullet(`${strong("PhotoChemist 3.0")} made Roadshow 2.0 the default halation model, so the glow scales with how bright the source is, and added Auto Calibrate with a Calibration Target plus intensity trims for grain, halation and MTF.`)}
${bullet(`${strong("Look Notes Pro")} added Export All Looks, which steps through every look, saves a still of each, and builds a side by side Look Grid you can hand to a client.`)}
            <p style="${P}">All of that lives in the Tool Box, which is one price for every premium plugin and a year of updates. Your tools keep working if you never renew, and the rate you join at is the rate you keep. There is no trap in it.</p>
            <p style="${P}">And if you only ever use the free tools, that is genuinely fine. That is what they are for.</p>
${ghostBtn(PRICING_URL, "How the pricing works")}`,
      "0 40px 8px 40px"
    ),

    divider(),

    row(
      `            <p style="${KICKER}">One click to update</p>
            <h2 style="${H2}">Open the Plugin Manager</h2>
            <p style="${P}">The Plugin Manager installs and updates the free tools too, and it does not ask you to sign in for those. Open it, look at the Free tab, and anything with an update waiting will say so. If you would rather do it by hand, the download page for each tool is linked above.</p>
${primaryBtn(MANAGER_URL, "Get the Plugin Manager")}`,
      "0 40px 8px 40px"
    ),

    discordBlock(),
    signOff(),
  ].join("\n");
}

// ── MEMBER VERSION ────────────────────────────────────────────────────────────
function memberBody() {
  return [
    row(
      `            <p style="${KICKER}">Monthly update &bull; October 2026</p>
            <h1 class="h1" style="margin:0 0 16px 0; font-family:Georgia, 'Times New Roman', serif; font-size:30px; line-height:38px; color:#f4f1ea; font-weight:normal;">Five plugins moved this month</h1>
            <p style="${P}">Hi there,</p>
            <p style="${P}">Here is what changed across the Tool Box since 20 September. Most substantial first. One thing will change how your old projects render, so it is in a box before anything else.</p>`,
      "40px 40px 8px 40px"
    ),

    row(
      `            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#2a211a; border-left:3px solid #d9a441; border-radius:4px;">
              <tr>
                <td style="padding:20px 24px 10px 24px;">
                  <p style="${KICKER}">Read this before you update</p>
                  <p style="${P}">${strong("PhotoChemist 3.0 changed its starting defaults in 3.1.0.")} Halation, acutance, spectral sharpening, layer bias and Deep Black Neutral all start somewhere new, and Roadshow 2.0 is the default halation model. New nodes get the new defaults. Grades that leaned on the old ones will render differently, so put an old project up against a reference render before you sign off on it.</p>
                  <p style="${SMALL}">Technically Technicolor DRT has the same new halation model but keeps Roadshow selectable, and its new Input Primaries setting has a Classic option that holds the old behaviour, so nothing you already graded there moves on its own.</p>
                </td>
              </tr>
            </table>`,
      "8px 40px 16px 40px"
    ),

    row(
      panel("v12.2.0 and v12.2.1", "Technically Technicolor DRT", TDRT_BLOCK)
    ),

    row(panel("v1.2.0 and v1.2.1", "Gradient Domain Grading Tools", GD_BLOCK), "16px 40px 8px 40px"),

    row(panel("v3.1.0 to v3.1.2", "PhotoChemist 3.0", PC_BLOCK), "16px 40px 8px 40px"),

    row(panel("v1.0.0 to v1.2.0", "Look Notes Pro", LN_BLOCK), "16px 40px 8px 40px"),

    row(
      panel(
        "Free, v1.2.0",
        "Color Theory",
        `                  <p style="${P}">This one is free and it is not in your member downloads by default, so you may not have noticed it. It draws colour vision illusions straight onto the timeline with a commentary overlay, and the Reveal slider wipes the answer in. It is a teaching and reference tool, and it is useful in a client room when you need to explain why the thing they are looking at is not the thing they think they are looking at.</p>
                  <p style="${P}">${strong("1.2.0 landed today")} with five new modes: Dye Layer Stack, Dye Layer Separation (splits your clip into cyan, magenta and yellow dye layers and restacks them), Surround A/B, Crispening Ladder and Viewing Matte. Earlier releases added four scene linear test frames, a DaVinci Wide Gamut / Intermediate output, RGB Chips and the Perceived Luminance Visualizer.</p>
                  <p style="${SMALL}">No key needed. It shows up in the Plugin Manager alongside everything else.</p>
${ghostBtn(COLOR_THEORY_URL, "Color Theory page")}`
      ),
      "16px 40px 8px 40px"
    ),

    divider(),

    row(
      `            <p style="${KICKER}">One click to update</p>
            <h2 style="${H2}">Open the Plugin Manager</h2>
            <p style="${P}">Everything above is live. Open the Plugin Manager, sign in with the address this email arrived at, and update the lot from one screen. If you have auto update on it has probably already pulled most of it down. Prefer to grab installers by hand? Every tool is listed on the member page.</p>
${primaryBtn(MANAGER_URL, "Open the Plugin Manager")}
            <p style="${SMALL}">Member downloads: <a href="${ALL_TOOLS_URL}" target="_blank" style="color:#8a9099; text-decoration:underline;">${ALL_TOOLS_URL.replace("https://", "")}</a></p>`,
      "0 40px 8px 40px"
    ),

    discordBlock(),
    signOff(),
  ].join("\n");
}

function discordBlock() {
  return row(
    `            <p style="${KICKER}">Come say hi</p>
            <h2 style="${H2}">Tell me where this is wrong</h2>
            <p style="${P}">There is a free, public Discord full of people running these tools on real work. Post a frame, swap node trees, ask questions, or just lurk. I am in there most days, and a lot of what is in this email started as someone complaining in there. If you would rather keep it private, reply to this email. It comes straight to me.</p>
${ghostBtn(DISCORD_URL, "Join the Discord")}
            <p style="${SMALL}"><a href="${DISCORD_URL}" target="_blank" style="color:#8a9099; text-decoration:underline;">${DISCORD_URL.replace("https://", "")}</a></p>`,
    "16px 40px 8px 40px"
  );
}

function signOff() {
  return `        <tr>
          <td style="background-color:#1a1f26; padding:8px 40px 40px 40px; border-radius:0 0 12px 12px;" class="px">
            <p style="margin:0; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:24px; color:#c6ccd4;">
              Happy grading,<br>
              <span style="color:#f4f1ea;">Greg</span><br>
              <span style="font-size:13px; color:#8a9099;">Dec. 18 Studios</span>
            </p>
          </td>
        </tr>`;
}

/** variant "free" or "member". */
function emailHTML({ unsub, variant }) {
  const member = variant === "member";
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>Dec. 18 Studios &bull; October 2026 Update</title>
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
  ${PREHEADERS[variant]}
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

        <!-- Card top -->
        <tr>
          <td style="background-color:#1a1f26; border-radius:12px 12px 0 0; font-size:0; line-height:0; height:8px;">&nbsp;</td>
        </tr>

${member ? memberBody() : freeBody()}

        <!-- Footer -->
        <tr>
          <td align="center" style="padding:28px 40px 8px 40px;" class="px">
            <p style="margin:0 0 8px 0; font-family:Arial, Helvetica, sans-serif; font-size:12px; line-height:18px; color:#6b727c;">
              Dec. 18 Studios &bull; <a href="https://dec18studios.com" style="color:#8a9099; text-decoration:underline;">dec18studios.com</a>
            </p>
            <p style="margin:0 0 8px 0; font-family:Arial, Helvetica, sans-serif; font-size:12px; line-height:18px; color:#6b727c;">
              ${member
                ? `You&rsquo;re receiving this because you bought access to the Dec. 18 Studios Tool Box. <a href="${ACCOUNT_URL}" style="color:#8a9099; text-decoration:underline;">Manage your subscription</a>`
                : "You&rsquo;re receiving this because you downloaded a free tool from Dec. 18 Studios."}
            </p>
            <p style="margin:0; font-family:Arial, Helvetica, sans-serif; font-size:12px; line-height:18px; color:#6b727c;">
              <a href="${unsub}" style="color:#8a9099; text-decoration:underline;">Unsubscribe from these emails</a>
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

// ── plain text alternative ────────────────────────────────────────────────────
// Sent alongside the HTML, never on its own. Same convention as
// licenseEmailText() in license-email-template.mjs.
function emailText({ unsub, variant }) {
  const L = [];
  if (variant === "free") {
    L.push(
      "Hi there,",
      "",
      "You grabbed one of my free tools at some point, so here is the monthly note on",
      "where they stand. Color Theory shipped a new version today and it is the bulk of",
      "this email. There is a short, honest paragraph at the bottom about what the paid",
      "tools got, and you can ignore it without hurting my feelings.",
      "",
      "Color Theory 1.2.0, five new modes (out today)",
      "",
      "Color Theory draws colour vision illusions straight onto your timeline, one at a",
      "time, with a commentary overlay that explains what you are looking at. The Reveal",
      "slider gives the trick away, and you can keyframe it to wipe the answer in on",
      "camera. No key, no watermark, no sign up.",
      "",
      "* Dye Layer Stack. Three dye layers stack in density, so light passing through",
      "  multiplies. Compare a film layer against a flat veil, watch overlapping dyes",
      "  build new colours, then pull the layers apart and stack them back together.",
      "* Dye Layer Separation. This one runs on your own clip. It splits the picture into",
      "  its cyan, magenta and yellow dye layers, lets you switch, gain or kill each one,",
      "  and restacks them. View a single layer, the density, or side by side strips.",
      "* Surround A/B. Two identical patches, one on a bright surround and one on a dark",
      "  surround, set in stops around mid grey. Master exposure, a link that increments",
      "  and decrements together, and a readout that says SAME VALUE when the numbers",
      "  really do match.",
      "* Crispening Ladder. Even steps in stops on a surround you control, laid out as a",
      "  row, as pairs, or as a grid that climbs both ways from a black corner. The steps",
      "  nearest the surround are the ones that look the most different.",
      "* Viewing Matte. Shrinks your clip onto a uniform matte. Store a dark matte and a",
      "  bright matte, flip between them, and watch the same picture change.",
      "",
      "Every new mode ships with Demo presets that set the sliders for you.",
      "",
      "Everything else added since launch",
      "",
      "Color Theory only went out in late September, so there is a decent chance you have",
      "1.0.0 and have not seen any of this.",
      "",
      "* Four scene linear test frames: Blue Bar, Red Christmas Lights, Light Saber and",
      "  Diver. Each one names the colour space it is stored in and says where a poor",
      "  picture formation breaks the picture. Output is untouched linear by default, so",
      "  put a Colour Space Transform after the node and judge your own pipeline.",
      "* Image Options gained a DaVinci Wide Gamut / Intermediate output. Rec.709, sRGB",
      "  and ARRI Wide Gamut 4 sources get converted and encoded with the Intermediate",
      "  curve, no clamp, so the node drops straight into a DWG/I timeline.",
      "* Palette Reconstruction gained a Sampled From Image preset. It reads the frame",
      "  every render, finds the colours that cover most of it, and fills the palette in",
      "  coverage order, Colour 1 being the most common.",
      "* RGB Chips: a clean chip chart with primaries, secondaries and ramps, now matching",
      "  the RGB Chips DCTL control for control. Output leaves the node raw, so put a",
      "  Colour Space Transform after it.",
      "* Perceived Luminance Visualizer: a hue sweep with grey ramp shutters and markers",
      "  where the grey matches the hue. Shutter Count 0 turns the shutters off, and the",
      "  corner swatch reads out the perceived luminance percentage.",
      "",
      "The download is about 51 MB now, because the test frames are bundled in.",
      "",
      `Get Color Theory: ${COLOR_THEORY_URL}`,
      "",
      "Two more free editions, easy to miss",
      "",
      "* PhotoChemist Lite. The free edition of my spectral film emulation plugin. It",
      "  renders clean, no watermark, and you get the whole preset library plus the Film",
      "  Stock Editor, so you can draw your own sensitivity, dye and H&D curves.",
      `  ${PHOTOCHEMIST_URL}`,
      "* Look Notes Lite. Burns a look label and notes into the frame for client sessions,",
      "  and flips your look nodes for you when you change the active look. Clip level or",
      "  timeline level, split looks included.",
      `  ${LOOK_NOTES_URL}`,
      "",
      "Both are free and yours to keep.",
      "",
      "What the paid tools got this month",
      "",
      "Not a pitch, just so you know what is going on over there.",
      "",
      "* Technically Technicolor DRT picked up a full Preset Manager, four built in looks,",
      "  an Auto Calibrate that holds mid grey neutral when you change stock or process, a",
      "  second halation model where brighter sources glow more, a new grain model, and an",
      "  MTF rework that stops high pressure settings ringing.",
      "* Gradient Domain Grading Tools got a whole new tool, GD DRT Pro: a display render",
      "  built on the gradient solve, with three overlapping records recombined as dye",
      "  density. It also went from about 7 fps to about 40 fps at 4K on Mac for the same",
      "  picture.",
      "* PhotoChemist 3.0 made Roadshow 2.0 the default halation model, so the glow scales",
      "  with how bright the source is, and added Auto Calibrate with a Calibration Target",
      "  plus intensity trims for grain, halation and MTF.",
      "* Look Notes Pro added Export All Looks, which steps through every look, saves a",
      "  still of each, and builds a side by side Look Grid you can hand to a client.",
      "",
      "All of that lives in the Tool Box, which is one price for every premium plugin and",
      "a year of updates. Your tools keep working if you never renew, and the rate you",
      "join at is the rate you keep. There is no trap in it.",
      "",
      "And if you only ever use the free tools, that is genuinely fine. That is what they",
      "are for.",
      "",
      `How the pricing works: ${PRICING_URL}`,
      "",
      "Open the Plugin Manager",
      "",
      "The Plugin Manager installs and updates the free tools too, and it does not ask you",
      "to sign in for those. Open it, look at the Free tab, and anything with an update",
      "waiting will say so.",
      "",
      `  ${MANAGER_URL}`,
      ""
    );
  } else {
    L.push(
      "Hi there,",
      "",
      "Here is what changed across the Tool Box since 20 September. Most substantial",
      "first. One thing will change how your old projects render, so it is up front.",
      "",
      "Read this before you update",
      "",
      "PhotoChemist 3.0 changed its starting defaults in 3.1.0. Halation, acutance,",
      "spectral sharpening, layer bias and Deep Black Neutral all start somewhere new, and",
      "Roadshow 2.0 is the default halation model. New nodes get the new defaults. Grades",
      "that leaned on the old ones will render differently, so put an old project up",
      "against a reference render before you sign off on it.",
      "",
      "Technically Technicolor DRT has the same new halation model but keeps Roadshow",
      "selectable, and its new Input Primaries setting has a Classic option that holds the",
      "old behaviour, so nothing you already graded there moves on its own.",
      "",
      "Technically Technicolor DRT, v12.2.0 and v12.2.1",
      "",
      "The big one this month. Two releases, and between them the whole preset and editor",
      "side got rebuilt.",
      "",
      "* Preset Manager. Save, update, rename, delete, import and export your own presets",
      "  as .json for Full Preset, Full Neg Preset, Neg Sensitivity, Neg Dye, Neg HD Curve,",
      "  Dye Shaping and Textures. It also lists your PhotoChemist presets read only, with",
      "  PhotoChemist Full presets showing under Full Neg.",
      "* Full Preset menu with four built in looks: Modern (Single Stock plus Xenon), 3",
      "  Strip (Process 4 plus White Flame arc), 2 Strip (Process 3 plus Carbon Arc) and 2",
      "  Strip Blue (Process 3 plus Xenon). Your own saved whole looks live in the same",
      "  menu, and every preset menu shows (Custom) the moment you change anything,",
      "  including curves you draw in the Film Stock Editor.",
      "* Auto Calibrate keeps mid grey printing neutral at your Calibration Target when you",
      "  change stock, dyes or process. Works in Single Stock, Process 3 and Process 4.",
      "* Halation Model choice: Roadshow or Roadshow 2.0, where brighter sources glow more",
      "  and the glow takes the colour of the source. New hue and amount puck in the",
      "  Textures editor, so halation colour and strength are one drag.",
      "* Grain Model choice: Classic or Emulsion. Grain no longer goes blotchy at high",
      "  Grain Intensity, which was most obvious on 16mm.",
      "* MTF rework. New MTF Pressure slider plus per channel Bump Width and Fine",
      "  Crispness. High Pressure settings no longer ring or fringe.",
      "* Input Primaries for ARRI Wide Gamut 3, DaVinci Wide Gamut, Sony S-Gamut3 and ACES",
      "  AP0. Classic keeps the old behaviour, so nothing you already graded moves.",
      "* Editors follow the clip. With Follow clip on, the Film Stock Editor, Textures and",
      "  Dye Designer jump to the matching node when you change clips, on Mac and Windows.",
      "  Each editor has a node picker to step between nodes on the clip, and a Link button",
      "  to grab the right one. Edits saving to the wrong node is fixed.",
      "* Live preview light in the editors: a dot reads Live, Connecting or Not live, with",
      "  a note on turning on Resolve's external scripting when it is not connected.",
      "* Carbon Arc and White Flame bulbs are rescaled to 100 percent brightness, so they",
      "  stop scorching highlights.",
      "* Fixed a startup crash when Technically Technicolor DRT was loaded alongside other",
      "  Dec 18 plugins.",
      "",
      "Mac: editor windows remember where you put them, open in dark mode, and Textures",
      "and the Film Stock Editor open in Single View on the page you asked for. Single View",
      "pans and zooms, drag to pan, scroll to zoom up to 20x, double click to jump in on a",
      "spot and again to come back. The Dye Designer scrolls and resizes like the rest.",
      "Windows: the viewer always catches up to your last edit, and the Film Stock Editor",
      "got live preview too.",
      "",
      "Gradient Domain Grading Tools, v1.2.0 and v1.2.1",
      "",
      "* New tool: GD DRT Pro. A display render built on the gradient solve, with the",
      "  Records tonal engine. The picture is built from three overlapping film like records",
      "  and recombined as dye density, so colour gradations stay smooth and the neutral",
      "  axis stays put.",
      "* Built in looks. Balanced Modernity, Faded Glory or Silver Screen from the Preset",
      "  menu, or Save, Export and Import your own.",
      "* White Mode menu. SDR sets 100 nits. SDR as HDR 203 Nits Diffuse sets 406 nits with",
      "  the body of the picture sitting at 203.",
      "* Reference Monitor and Display Encode. Grade on a Gamma 2.4 monitor and switch to PQ",
      "  or HLG without the look changing character. SDR Monitor White and Black trim to",
      "  match the monitor you actually grade on.",
      "* Film Textures (Beta). Grain and halation picked by gauge, 65mm, 35mm or 16mm, with",
      "  a Grain Strength slider. Off by default.",
      "* Much faster at 4K on Mac. GD DRT Pro went from about 7 fps to about 40 fps on a 4K",
      "  timeline, with the exact same picture coming out the other end.",
      "* Windows and Linux: Razzle Dazzle, HDR Restore, Structure Metric and the Achromatic",
      "  Test and Colour Leak views now render on CUDA, and GPU memory is reused between",
      "  frames for smoother playback.",
      "",
      "PhotoChemist 3.0, v3.1.0 to v3.1.2",
      "",
      "* Roadshow 2.0 is the new default halation model. The glow scales with how bright the",
      "  source is, so practicals and specular hits bloom more than a white wall does.",
      "* Auto Calibrate keeps mid grey printing neutral as you change stocks or development,",
      "  and Calibration Target sets where that grey lands, 40 IRE by default. It no longer",
      "  re-solves when you change Film Development, so push, pull, bleach bypass and the",
      "  rest are yours to grade back with the printer lights, like a lab would.",
      "* New intensity trims: Grain Intensity, Halation Intensity, Halation Spread and MTF",
      "  Intensity. They push the current look up or down without touching the underlying",
      "  settings.",
      "* Textures editor: halation puck with per channel controls, and a cleaned up layout",
      "  across Textures and the Film Stock Editor. Printer Calibration has its own group,",
      "  and Lamp Ceiling plus the Deep Black controls moved into Advanced Trims.",
      "* Editor live preview is legible at last. Both editors show a small Live / Not live",
      "  indicator so you know whether the viewer will update as you edit, with a short note",
      "  on turning it on when it is off. Previews no longer jump to a random clip or frame,",
      "  the link label stops flickering when a timeline node and clip nodes are both in",
      "  play, and a linked editor says it is linked to the timeline node and stays that way.",
      "* Negative Spectral Sharpening now starts at 0.2 instead of 0.5 on new nodes, which",
      "  reads closer to the print side.",
      "* Fixes: on Linux, the crash as soon as PhotoChemist was added to a node is gone. On",
      "  Windows, the viewer lands on the final frame after a drag in the editors.",
      "",
      "Look Notes Pro, v1.0.0 to v1.2.0",
      "",
      "Look Notes is Look Notes Pro now and it is part of the membership, so it is already",
      "yours. Three releases, and the client-facing export side is the headline.",
      "",
      "* Export All Looks. Pick a folder and it switches to each look in turn, saves a still",
      "  of the frame named with that look's label and the date, then puts your original",
      "  look back.",
      "* Build Grid. Export All Looks also saves a Look Grid image with every look side by",
      "  side, ready to send to a client.",
      "* Export Current Look. One click saves the frame exactly as it is right now into your",
      "  last export folder and shows you the file. Export again after changes and it adds",
      "  _2, _3 and so on.",
      "* Still Format: PNG, JPG or 16 bit TIFF. The Look Grid is not available with JPG.",
      "* Reframe. Bottom Strip or Side Panel. The picture shrinks to fit and the notes get",
      "  their own panel instead of sitting on the image, with Panel Size, Background and",
      "  Background Brightness controls.",
      "* Palette. 3 to 12 colour swatches pulled from the image and shown in the reframe",
      "  panel. Sort by hue, dominance or brightness, and skip near blacks, near whites and",
      "  greys.",
      "* Node toggling works on Windows now, which needs Python 3 from python.org, and it is",
      "  always on, so the Toggle Look Nodes switch is gone. EB Garamond is bundled, so",
      "  Garamond mode works even without a system Garamond.",
      "",
      "Color Theory, free, v1.2.0",
      "",
      "This one is free and it is not in your member downloads by default, so you may not",
      "have noticed it. It draws colour vision illusions straight onto the timeline with a",
      "commentary overlay, and the Reveal slider wipes the answer in. Useful in a client",
      "room when you need to explain why the thing they are looking at is not the thing",
      "they think they are looking at.",
      "",
      "1.2.0 landed today with five new modes: Dye Layer Stack, Dye Layer Separation",
      "(splits your clip into cyan, magenta and yellow dye layers and restacks them),",
      "Surround A/B, Crispening Ladder and Viewing Matte. Earlier releases added four scene",
      "linear test frames, a DaVinci Wide Gamut / Intermediate output, RGB Chips and the",
      "Perceived Luminance Visualizer. No key needed.",
      "",
      `  ${COLOR_THEORY_URL}`,
      "",
      "Open the Plugin Manager",
      "",
      "Everything above is live. Open the Plugin Manager, sign in with the address this",
      "email arrived at, and update the lot from one screen. If you have auto update on it",
      "has probably already pulled most of it down.",
      "",
      `  ${MANAGER_URL}`,
      "",
      `Member downloads by hand: ${ALL_TOOLS_URL}`,
      ""
    );
  }

  L.push(
    "Come say hi on Discord",
    "",
    `  ${DISCORD_URL}`,
    "",
    "There is a free, public Discord full of people running these tools on real work. Post",
    "a frame, swap node trees, ask questions, or just lurk. I am in there most days, and a",
    "lot of what is in this email started as someone complaining in there. If you would",
    "rather keep it private, reply to this email. It comes straight to me.",
    "",
    "Happy grading,",
    "Greg",
    "Dec. 18 Studios",
    "",
    "Dec. 18 Studios, dec18studios.com"
  );
  if (variant === "member") L.push(`Manage your subscription: ${ACCOUNT_URL}`);
  L.push(`Unsubscribe from these emails: ${unsub}`);
  return L.join("\n");
}

// ── Brevo ─────────────────────────────────────────────────────────────────────
async function brevoSend(to, subject, html, text, unsub) {
  // Gmail and Yahoo want a one-click unsubscribe on bulk mail (RFC 8058) and treat
  // its absence as a spam signal. Only send the pair when we have a real https
  // opt-out URL: List-Unsubscribe-Post promises the POST route works, so claiming
  // it for a preview or mailto link would be worse than omitting both.
  const oneClick =
    unsub && unsub.startsWith("http") && unsub.includes("/newsletter-optout")
      ? {
          "List-Unsubscribe": `<${unsub}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        }
      : {};
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": BREVO_KEY, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      sender: FROM,
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
      tags: [TAG],
      ...(Object.keys(oneClick).length ? { headers: oneClick } : {}),
    }),
  });
  if (res.status === 201 || res.status === 202) return true;
  let detail = "";
  try { detail = JSON.stringify(await res.json()); } catch {}
  const err = new Error(`Brevo send ${res.status} for ${mask(to)}: ${detail}`);
  err.status = res.status;
  throw err;
}

// 4xx other than timeout / rate limit means Brevo will never take this address.
const isPermanentReject = (e) =>
  typeof e?.status === "number" && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;

// ── render mode ───────────────────────────────────────────────────────────────
function renderToDisk(target) {
  const unsub = `${WORKER_URL}/newsletter-optout?preview=1`;
  let isDir = target.endsWith("/");
  if (!isDir) {
    try { isDir = statSync(target).isDirectory(); } catch {}
  }
  if (!isDir && !/\.[^./]+$/.test(basename(target))) isDir = true;

  const out = [];
  for (const variant of ["free", "member"]) {
    const html = emailHTML({ unsub, variant });
    const text = emailText({ unsub, variant });
    let htmlPath, textPath;
    if (isDir) {
      mkdirSync(target, { recursive: true });
      htmlPath = join(target, `newsletter-${variant}.html`);
      textPath = join(target, `newsletter-${variant}.txt`);
    } else {
      // lite-announce convention: suffix before the extension.
      htmlPath = target.replace(/(\.[^./]+)$/, `.${variant}$1`);
      textPath = htmlPath.replace(/\.[^./]+$/, ".txt");
    }
    writeFileSync(htmlPath, html);
    writeFileSync(textPath, text);
    out.push(htmlPath, textPath);
  }
  console.log("Rendered, nothing sent:");
  for (const p of out) console.log(`  ${p}`);
  console.log(`\nSubjects:\n  free   ${SUBJECTS.free}\n  member ${SUBJECTS.member}\n`);
}

// ── audience assembly ─────────────────────────────────────────────────────────
async function loadSuppression() {
  const tables = await d1(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('campaign_sends','newsletter_optouts')"
  );
  const have = new Set(tables.map((t) => t.name));
  const missing = ["campaign_sends", "newsletter_optouts"].filter((t) => !have.has(t));

  const optouts = new Set();
  const done = new Set();
  const retired = new Set();

  if (have.has("newsletter_optouts")) {
    for (const r of await d1("SELECT email FROM newsletter_optouts")) optouts.add(norm(r.email));
  }
  if (have.has("campaign_sends")) {
    for (const r of await d1(
      `SELECT email, campaign, state FROM campaign_sends WHERE state <> 0`
    )) {
      if (Number(r.state) === 2) retired.add(norm(r.email));
      if (r.campaign === CAMPAIGN) done.add(norm(r.email));
    }
  }

  // Download-side suppression: one unsubscribed or undeliverable row retires the
  // whole person, exactly as in photochemist-lite-announce.mjs.
  const dlBad = new Set();
  for (const r of await d1(
    "SELECT email FROM downloads GROUP BY email " +
      "HAVING MAX(unsubscribed) = 1 OR MAX(COALESCE(welcome_sent, 0)) = 2"
  )) {
    dlBad.add(norm(r.email));
  }

  return { missing, optouts, done, retired, dlBad };
}

async function loadDownloaderRows() {
  // The Worker lowercases on /log, so email is already the per-person key.
  return d1(
    "SELECT email, MIN(tool_slug) AS first_slug, COUNT(*) AS tools, " +
      "MAX(last_downloaded) AS last_downloaded FROM downloads GROUP BY email " +
      "ORDER BY last_downloaded DESC"
  );
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (RENDER_TO) return renderToDisk(RENDER_TO);

  const wantFree = AUDIENCE === "free" || AUDIENCE === "both";
  const wantMember = AUDIENCE === "member" || AUDIENCE === "both";

  console.log(
    `\nDec. 18 Studios monthly update, campaign "${CAMPAIGN}", audience ${AUDIENCE}` +
      `${DRY_RUN ? "  (DRY RUN, nothing will be sent)" : "  (LIVE)"}` +
      `${TEST_EMAIL ? `  (TEST to ${mask(TEST_EMAIL)})` : ""}\n`
  );
  if (process.env.DRY_RUN === "0" && !LIVE) {
    console.log("Note: DRY_RUN=0 does not arm a live send. Set CONFIRM_SEND=yes-send-for-real.\n");
  }

  if (TEST_EMAIL) {
    if (!BREVO_KEY) throw new Error("Missing BREVO_API_KEY.");
    for (const variant of ["free", "member"]) {
      const unsub = DL_SECRET ? newsletterUnsubUrl(TEST_EMAIL) : `${WORKER_URL}/newsletter-optout?preview=1`;
      await brevoSend(
        TEST_EMAIL,
        `[TEST ${variant}] ${SUBJECTS[variant]}`,
        emailHTML({ unsub, variant }),
        emailText({ unsub, variant }),
        unsub
      );
      console.log(`  sent ${variant} to ${mask(TEST_EMAIL)}`);
    }
    console.log("\nBoth versions sent to the test address. No state written.\n");
    return;
  }

  // Member audience comes off the local private ledger and needs no network.
  let memberEmails = [];
  let masterCount = 0;
  if (wantMember) {
    const m = readMemberEmails();
    memberEmails = m.emails;
    masterCount = m.masterCount;
    console.log(
      `Ledger: ${memberEmails.length} member address(es)` +
        `${masterCount ? `, of which ${masterCount} decode to tier "master"${SKIP_MASTER ? " and were dropped (SKIP_MASTER=1)" : " and were kept (set SKIP_MASTER=1 to drop them)"}` : ""}.`
    );
  }
  // Members always win the de-dup, even when only the free audience is being sent.
  const memberSet = new Set(wantMember ? memberEmails : readMemberEmailsQuietly());

  // D1 reachability, probed rather than inferred. An API token is one way in, but
  // a plain `wrangler login` is another, and gating on CLOUDFLARE_API_TOKEN alone
  // refuses to send from a perfectly authenticated checkout while also silently
  // skipping every suppression list. Ask the database instead.
  let haveD1 = false;
  let d1Why = "";
  try {
    await d1("SELECT 1 AS ok");
    haveD1 = true;
  } catch (err) {
    d1Why = String(err?.message || err).split("\n").find((l) => l.trim()) || "unknown error";
  }
  if (!haveD1) {
    if (!DRY_RUN) {
      throw new Error(
        `Cannot reach D1: ${d1Why}\n` +
          "Run `npx wrangler login` from tools/download-logger, or export CLOUDFLARE_API_TOKEN. " +
          "Refusing to send, because without D1 there is no opt-out list and no record of who already got this."
      );
    }
    console.log(
      `\n!! D1 is unreachable (${d1Why}), so none of it was read.\n` +
        "!! This preview is UNFILTERED: opt-outs, prior sends and undeliverable\n" +
        "!! addresses have NOT been applied, and the free audience cannot be\n" +
        "!! enumerated at all. Use it to review copy and counts only. Fix the\n" +
        "!! wrangler auth and dry-run again before you dispatch anything.\n"
    );
  }

  let sup = { missing: [], optouts: new Set(), done: new Set(), retired: new Set(), dlBad: new Set() };
  let downloaderRows = [];
  if (haveD1) {
    sup = await loadSuppression();
    if (sup.missing.length) {
      const msg = `Missing D1 table(s): ${sup.missing.join(", ")}. Apply tools/download-logger/schema.sql first.`;
      if (!DRY_RUN) throw new Error(msg);
      console.log(`!! ${msg}\n`);
    }
    if (wantFree) downloaderRows = await loadDownloaderRows();
    console.log(
      `Suppression: ${sup.optouts.size} newsletter opt-out(s), ${sup.done.size} already sent this campaign, ` +
        `${sup.retired.size} retired, ${sup.dlBad.size} unsubscribed or undeliverable on the download side.`
    );
  }

  const blocked = (email) =>
    sup.optouts.has(email) || sup.done.has(email) || sup.retired.has(email) || sup.dlBad.has(email);

  // Slug for the real token unsubscribe link, per person. Members without a
  // downloads row fall back to the mailto placeholder.

  const recipients = [];
  if (wantMember) {
    for (const email of memberEmails) {
      if (blocked(email)) continue;
      recipients.push({ email, variant: "member" });
    }
  }
  if (wantFree) {
    for (const r of downloaderRows) {
      const email = norm(r.email);
      if (memberSet.has(email)) continue; // de-dup: paid version wins
      if (blocked(email)) continue;
      recipients.push({ email, variant: "free", tools: r.tools, last: r.last_downloaded });
    }
  }

  const memberCount = recipients.filter((r) => r.variant === "member").length;
  const freeCount = recipients.length - memberCount;
  const bothLists = wantFree && wantMember
    ? downloaderRows.filter((r) => memberSet.has(norm(r.email))).length
    : 0;

  console.log(
    `\nEligible: ${recipients.length}  (member: ${memberCount}, free: ${freeCount})` +
      (bothLists ? `\nDe-duplicated: ${bothLists} member(s) are also in the download list and get the member version only.` : "")
  );
  for (const r of recipients) {
    console.log(`  ${mask(r.email).padEnd(28)} ${r.variant.padEnd(7)} unsub:one-click`);
  }
  console.log("");

  // Daily quota accounting. campaign_sends is the only record of what this repo's
  // newsletter traffic has already spent today, so count every campaign, not just
  // this one, and count retired addresses too: a Brevo rejection still consumed a
  // send. Transactional mail is invisible here, which is what DAILY_BUDGET's
  // reserve is for. This runs before the dry-run return on purpose: the whole
  // point of batching is knowing how many days the list takes BEFORE you commit.
  const today = new Date().toISOString().slice(0, 10);
  let spentToday = 0;
  let quotaKnown = false;
  if (haveD1) {
    const spentRows = await d1(
      `SELECT COUNT(*) AS n FROM campaign_sends ` +
        `WHERE state <> 0 AND substr(updated_at, 1, 10) = ${sq(today)}`
    );
    spentToday = Number(spentRows?.[0]?.n || 0);
    quotaKnown = true;
  }
  const remainingToday = Math.max(0, DAILY_BUDGET - spentToday);

  if (quotaKnown) {
    console.log(
      `Quota: ${spentToday} newsletter send(s) already today, ` +
        `${remainingToday} of the ${DAILY_BUDGET} daily budget left ` +
        `(Brevo allows 300/day; the rest is reserved for licence, welcome and sign-in mail).`
    );
  } else {
    console.log(
      `Quota: unknown, D1 was unreachable. Assuming the whole ${DAILY_BUDGET}/day budget is free.`
    );
  }

  if (DRY_RUN) {
    const firstBatch = Math.min(MAX_SENDS, remainingToday);
    const runsPerDay = Math.max(1, Math.ceil(DAILY_BUDGET / MAX_SENDS));
    let days = 0;
    let carry = recipients.length;
    if (remainingToday > 0) {
      days = 1;
      carry -= remainingToday;
    }
    if (carry > 0) days += Math.ceil(carry / DAILY_BUDGET);
    console.log(
      `Batching: ${firstBatch} go out on the next run, up to ${runsPerDay} run(s) of ` +
        `${MAX_SENDS} per day, so ${recipients.length} recipient(s) takes about ${days} day(s). ` +
        `Every run picks up exactly where the last one stopped.`
    );
    console.log("\nDry run. Nothing sent, nothing marked.");
    console.log(`To send for real: CONFIRM_SEND=yes-send-for-real (cap MAX_SENDS=${MAX_SENDS}).\n`);
    return;
  }

  if (!DL_SECRET) {
    throw new Error(
      "No unsubscribe signing secret. Set DOWNLOAD_LOGGER_SECRET, or put the Worker's " +
      `ADMIN_SECRET in ${DL_SECRET_FILE}. Without it every opt-out link in the mail ` +
      "is rejected as a bad token, which you only find out after sending."
    );
  }
  if (!BREVO_KEY) throw new Error("Missing BREVO_API_KEY.");
  if (!recipients.length) { console.log("Nothing to do.\n"); return; }

  if (!remainingToday) {
    console.log(
      `\nToday's budget is spent. ${recipients.length} recipient(s) still waiting.\n` +
        `Run the same command tomorrow and it picks up exactly where it stopped.\n`
    );
    return;
  }

  const cap = Math.min(MAX_SENDS, remainingToday);
  const batch = recipients.slice(0, cap);
  const left = recipients.length - batch.length;
  if (left) {
    const why = cap === remainingToday && remainingToday < MAX_SENDS ? "daily budget" : `MAX_SENDS=${MAX_SENDS}`;
    const when = remainingToday - batch.length > 0 ? "Run it again now" : "Run it again tomorrow";
    console.log(`Capped at ${cap} by ${why}; ${left} left after this batch. ${when}.`);
  }
  console.log("");

  const markSql = (email, variant, state) =>
    `INSERT INTO campaign_sends (email, campaign, audience, state, updated_at) ` +
    `VALUES (${sq(email)}, ${sq(CAMPAIGN)}, ${sq(variant)}, ${state}, ${sq(new Date().toISOString())}) ` +
    `ON CONFLICT(email, campaign) DO UPDATE SET state = excluded.state, ` +
    `audience = excluded.audience, updated_at = excluded.updated_at`;

  let sent = 0, failed = 0, skipped = 0;
  for (const r of batch) {
    const { email, variant } = r;
    if (!looksSendable(email)) {
      await d1(markSql(email, variant, 2));
      skipped++;
      console.log(`  - ${mask(email)}: not a valid address, retired`);
      continue;
    }
    const unsub = newsletterUnsubUrl(email);
    try {
      await brevoSend(
        email,
        SUBJECTS[variant],
        emailHTML({ unsub, variant }),
        emailText({ unsub, variant }),
        unsub
      );
      await d1(markSql(email, variant, 1));
      sent++;
      console.log(`  + ${mask(email)} (${variant})`);
    } catch (e) {
      const msg = String(e.message || e).slice(0, 200);
      if (isPermanentReject(e)) {
        await d1(markSql(email, variant, 2));
        skipped++;
        console.log(`  - ${mask(email)}: rejected by Brevo, retired: ${msg}`);
      } else {
        failed++;
        console.log(`  x ${mask(email)}: ${msg}`);
      }
    }
    await sleep(200);
  }

  console.log(`\nDone. sent:${sent}  skipped:${skipped} (retired)  failed:${failed} (retry next dispatch)`);

  const stillWaiting = recipients.length - batch.length + failed;
  if (stillWaiting > 0) {
    const budgetLeft = Math.max(0, remainingToday - (sent + skipped));
    console.log(
      budgetLeft > 0
        ? `${stillWaiting} still to go and ${budgetLeft} of today's budget left. Run the same command again now.\n`
        : `${stillWaiting} still to go, today's budget is spent. Run the same command tomorrow.\n`
    );
  } else {
    console.log(`Audience "${AUDIENCE}" is complete for campaign ${CAMPAIGN}.\n`);
  }
  if (failed && !sent) process.exit(1);
}

/**
 * Member addresses for de-dup only, when the member version is not being sent.
 * Silent, and it returns an empty list rather than throwing if the ledger is not
 * configured, because a missing ledger must not be able to turn a free-audience
 * dispatch into something that mails members the wrong version. It logs loudly
 * instead, since an empty set means no de-dup happened.
 */
function readMemberEmailsQuietly() {
  try {
    return readMemberEmails().emails;
  } catch (e) {
    console.log(
      `\n!! Could not read the licence ledger for de-duplication: ${String(e.message || e)}\n` +
        "!! Members who also downloaded a free tool would receive the FREE version.\n" +
        "!! Set LICENSE_LEDGER_DIR before dispatching the free audience.\n"
    );
    if (!DRY_RUN) {
      throw new Error("Refusing to send the free audience without the ledger for de-duplication.");
    }
    return [];
  }
}

main().catch((e) => {
  // Configuration mistakes are the common case, so print the message, not a
  // stack. DEBUG=1 for the stack.
  console.error(`\n${process.env.DEBUG === "1" ? e.stack || e : String(e.message || e)}\n`);
  process.exit(1);
});
