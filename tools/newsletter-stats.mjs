#!/usr/bin/env node
/**
 * newsletter-stats.mjs: what the monthly newsletter actually did.
 *
 * Reads two sources and prints one report:
 *
 *   D1 campaign_sends   how many we handed to Brevo, and how many we retired
 *   Brevo statistics    what happened to them after that: delivered, opened,
 *                       clicked, bounced, unsubscribed
 *
 * ── WHY THIS IS NOT THE BREVO DASHBOARD'S CAMPAIGN REPORT ────────────────────
 *
 * The newsletter does not go out as a Brevo "campaign". monthly-update-announce
 * .mjs posts one transactional email per recipient to /v3/smtp/email, so the
 * Campaigns tab in Brevo shows nothing at all for it. The numbers live under
 * the transactional statistics endpoints instead, filtered by the tag the
 * sender stamps on every message:
 *
 *   monthly-update-<campaign without the "monthly-" prefix>
 *
 * which for CAMPAIGN=monthly-2026-10 is monthly-update-2026-10. Same derivation
 * as the sender, so the two always agree.
 *
 * ── PRIVACY ──────────────────────────────────────────────────────────────────
 *
 * The Brevo events endpoint returns one row per event WITH the address on it,
 * and this repo is public, so every Actions log is world readable. Nothing here
 * prints an address, not even masked. Addresses are used only to size Sets for
 * unique counts and are never written to stdout. Keep it that way.
 *
 * ── ENVIRONMENT ──────────────────────────────────────────────────────────────
 *
 *   BREVO_API_KEY         required. Secret-only, so this runs in Actions.
 *   CLOUDFLARE_API_TOKEN  for the D1 half. Without it the Brevo half still
 *                         prints and the send counts are skipped.
 *   CAMPAIGN              default monthly-2026-10.
 *   DAYS                  window, default 14, max 90 (Brevo's own limit).
 *   START_DATE/END_DATE   YYYY-MM-DD, overrides DAYS. Both or neither.
 *
 * Opens are undercounted on purpose by Apple, not by us. See the caveats the
 * report prints at the end before reading anything into an open rate.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = join(__dirname, "download-logger");
const D1_NAME = "dec18-downloads";

const CAMPAIGN = (process.env.CAMPAIGN || "monthly-2026-10").trim();
const TAG = `monthly-update-${CAMPAIGN.replace(/^monthly-/, "")}`;
const BREVO_KEY = (process.env.BREVO_API_KEY || "").trim();
const HAVE_CF = Boolean((process.env.CLOUDFLARE_API_TOKEN || "").trim());

const START_DATE = (process.env.START_DATE || "").trim();
const END_DATE = (process.env.END_DATE || "").trim();
const DAYS = Math.min(Math.max(Number(process.env.DAYS || "14"), 1), 90);

if (!BREVO_KEY) {
  console.error("No BREVO_API_KEY. It is a GitHub secret only, so run this through Actions.");
  process.exit(1);
}
if (Boolean(START_DATE) !== Boolean(END_DATE)) {
  console.error("START_DATE and END_DATE go together. Set both or neither.");
  process.exit(1);
}

// Brevo wants either a date range or a day count, never both.
const WINDOW = START_DATE ? { startDate: START_DATE, endDate: END_DATE } : { days: String(DAYS) };

async function brevo(path, params = {}) {
  const url = new URL(`https://api.brevo.com/v3/smtp/${path}`);
  for (const [k, v] of Object.entries({ ...WINDOW, ...params })) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { "api-key": BREVO_KEY, accept: "application/json" },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Brevo ${path} ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

async function d1(sql) {
  const { stdout } = await execFileP(
    "npx",
    ["--yes", "wrangler@4", "d1", "execute", D1_NAME, "--remote", "--json", "--command", sql],
    { cwd: WORKER_DIR, env: process.env, maxBuffer: 16 * 1024 * 1024 }
  );
  return JSON.parse(stdout)[0]?.results || [];
}

// Every event page is 2500 rows. Stop at 40 pages: 100k events is far past any
// plausible month and a runaway loop here burns API quota for nothing.
async function eventPages(event, extra = {}) {
  const out = [];
  for (let page = 0; page < 40; page++) {
    const { events = [] } = await brevo("statistics/events", {
      event,
      limit: "2500",
      offset: String(page * 2500),
      ...extra,
    });
    out.push(...events);
    if (events.length < 2500) break;
  }
  return out;
}

// The documented tags filter on this endpoint came back empty against a window
// that the aggregated report says has clicks in it, so do not trust it. Try it
// first because it is the cheap path, then fall back to pulling every event in
// the window and matching on the tag each row carries. Volume makes that safe:
// the whole account is capped at 300 sends a day, so even 90 days of events is
// a handful of pages.
async function allEvents(event) {
  const tagged = await eventPages(event, { tags: JSON.stringify([TAG]) });
  if (tagged.length) return tagged;
  const everything = await eventPages(event);
  const mine = everything.filter((e) => e.tag === TAG);
  if (everything.length && !mine.length) return [];
  if (mine.length) {
    console.log(`  (tags filter returned nothing for ${event}; matched ${mine.length} of ${everything.length} events on the tag instead)`);
  }
  return mine;
}

const pct = (n, of) => (of > 0 ? `${((n / of) * 100).toFixed(1)}%` : "n/a");
const pad = (s, w) => String(s).padEnd(w);
const num = (n, w = 7) => String(n).padStart(w);

function heading(s) {
  console.log(`\n${s}`);
  console.log("-".repeat(s.length));
}

async function sendCounts() {
  // state: 0 queued/attempted, 1 sent, 2 undeliverable and never retried.
  const rows = await d1(
    `SELECT state, COUNT(*) AS n, MIN(updated_at) AS first, MAX(updated_at) AS last
       FROM campaign_sends WHERE campaign = '${CAMPAIGN}' GROUP BY state`
  );
  const by = new Map(rows.map((r) => [Number(r.state), r]));
  const sent = Number(by.get(1)?.n || 0);
  const retired = Number(by.get(2)?.n || 0);
  const queued = Number(by.get(0)?.n || 0);

  heading(`Handed to Brevo, campaign ${CAMPAIGN}`);
  console.log(`  sent            ${num(sent)}`);
  console.log(`  retired         ${num(retired)}   rejected address, never retried`);
  if (queued) console.log(`  still queued    ${num(queued)}   attempted, will retry next run`);
  const first = by.get(1)?.first;
  const last = by.get(1)?.last;
  if (first) console.log(`  first send      ${first}`);
  if (last) console.log(`  last send       ${last}`);
  return sent;
}

async function optouts(sinceISO) {
  const rows = await d1(
    `SELECT source, COUNT(*) AS n FROM newsletter_optouts
      WHERE opted_out_at >= '${sinceISO}' GROUP BY source ORDER BY n DESC`
  );
  const total = rows.reduce((a, r) => a + Number(r.n), 0);
  const all = await d1("SELECT COUNT(*) AS n FROM newsletter_optouts");

  heading("Opt-outs");
  console.log(`  since ${sinceISO.slice(0, 10)}  ${num(total)}`);
  for (const r of rows) console.log(`    ${pad(r.source || "(no source)", 22)} ${num(r.n)}`);
  console.log(`  all time        ${num(Number(all[0]?.n || 0))}`);
  console.log(`
  These are rows in newsletter_optouts, written by the Worker when somebody
  clicks the unsubscribe link or their mail client POSTs the one-click header.
  That is the number that suppresses future sends. Brevo's own "unsubscribed"
  count below is a different thing and will usually be lower, because it only
  sees the one-click presses that went through Brevo.`);
}

async function main() {
  console.log(`Newsletter report: ${CAMPAIGN}  (Brevo tag ${TAG})`);
  console.log(`Window: ${START_DATE ? `${START_DATE} to ${END_DATE}` : `last ${DAYS} days`}`);

  let sent = 0;
  if (HAVE_CF) {
    try {
      sent = await sendCounts();
    } catch (e) {
      console.log(`\nD1 send counts unavailable: ${e.message.slice(0, 200)}`);
    }
  } else {
    console.log("\nNo CLOUDFLARE_API_TOKEN, so the D1 send counts are skipped.");
  }

  const agg = await brevo("statistics/aggregatedReport", { tag: TAG });

  heading("What Brevo did with them");
  const rows = [
    ["requests", agg.requests, null, "messages Brevo accepted from us"],
    ["delivered", agg.delivered, agg.requests, "reached the mailbox"],
    ["hard bounces", agg.hardBounces, agg.requests, "address is dead"],
    ["soft bounces", agg.softBounces, agg.requests, "full or temporarily refusing"],
    ["blocked", agg.blocked, agg.requests, "Brevo refused to send"],
    ["invalid", agg.invalid, agg.requests, "malformed address"],
    ["spam reports", agg.spamReports, agg.delivered, "marked us as junk"],
    ["unsubscribed", agg.unsubscribed, agg.delivered, "one-click, as Brevo saw it"],
  ];
  for (const [label, n, of, why] of rows) {
    const v = Number(n || 0);
    console.log(`  ${pad(label, 15)} ${num(v)}  ${pad(of ? pct(v, Number(of)) : "", 7)} ${why}`);
  }

  heading("Engagement");
  const delivered = Number(agg.delivered || 0);
  const uOpens = Number(agg.uniqueOpens || 0);
  const uClicks = Number(agg.uniqueClicks || 0);
  console.log(`  opens           ${num(Number(agg.opens || 0))}  total, repeats included`);
  console.log(`  unique opens    ${num(uOpens)}  ${pct(uOpens, delivered)} of delivered`);
  console.log(`  clicks          ${num(Number(agg.clicks || 0))}  total`);
  console.log(`  unique clicks   ${num(uClicks)}  ${pct(uClicks, delivered)} of delivered`);
  console.log(`  click-to-open   ${pad("", 6)}  ${pct(uClicks, uOpens)} of the people who opened`);

  // Per-day, so a send batch can be lined up against the opens it produced.
  const daily = await brevo("statistics/reports", { tag: TAG, sort: "asc" });
  const days = daily.reports || [];
  if (days.length) {
    heading("Day by day");
    console.log(`  ${pad("date", 12)}${num("sent")}${num("deliv")}${num("opens")}${num("clicks")}${num("unsub")}`);
    for (const d of days) {
      if (!Number(d.requests)) continue;
      console.log(
        `  ${pad(d.date, 12)}${num(d.requests)}${num(d.delivered)}${num(d.uniqueOpens ?? d.opens)}` +
          `${num(d.uniqueClicks ?? d.clicks)}${num(d.unsubscribed || 0)}`
      );
    }
  }

  // Which links people actually pressed. This is the part worth acting on:
  // it says what the list wanted, not just that they looked.
  const clicks = await allEvents("clicks");
  if (clicks.length) {
    const byLink = new Map();
    for (const e of clicks) {
      const link = e.link || "(unknown link)";
      if (!byLink.has(link)) byLink.set(link, { total: 0, people: new Set() });
      const row = byLink.get(link);
      row.total++;
      if (e.email) row.people.add(e.email.toLowerCase());
    }
    const ranked = [...byLink.entries()].sort((a, b) => b[1].people.size - a[1].people.size);
    heading("Links pressed");
    console.log(`  ${pad("people", 8)}${pad("clicks", 8)}link`);
    for (const [link, row] of ranked) {
      console.log(`  ${pad(row.people.size, 8)}${pad(row.total, 8)}${link}`);
    }
  }

  // Apple Mail Privacy Protection fetches images from a proxy whether or not
  // the human ever looked. Brevo files those as loadedByProxy instead of
  // opened, which is the honest call but means the open rate above is a floor.
  const proxied = await allEvents("loadedByProxy");
  if (proxied.length) {
    const people = new Set(proxied.map((e) => (e.email || "").toLowerCase()).filter(Boolean));
    heading("Privacy-proxy loads");
    console.log(`  ${num(proxied.length)} events from ${people.size} addresses, counted as neither open nor not.`);
  }

  if (HAVE_CF) {
    const since = START_DATE || new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
    try {
      await optouts(`${since}T00:00:00Z`);
    } catch (e) {
      console.log(`\nOpt-out counts unavailable: ${e.message.slice(0, 200)}`);
    }
  }

  heading("Read it with these in mind");
  console.log(`  - Open rates are a floor, never a ceiling. Image blocking and Apple's
    proxy both hide real opens, so the honest read is "at least this many".
  - Clicks are the number to trust. A pressed link is a human.
  - requests here (${Number(agg.requests || 0)}) and our own sent count${sent ? ` (${sent})` : ""} can differ: the
    window above may be shorter than the campaign, and test sends carry the
    same tag.
  - Nothing in this report identifies anybody. It is counts only, on purpose,
    because this repo is public and so are its Actions logs.`);
  console.log("");
}

main().catch((e) => {
  console.error(`\nFailed: ${e.message}`);
  process.exit(1);
});
