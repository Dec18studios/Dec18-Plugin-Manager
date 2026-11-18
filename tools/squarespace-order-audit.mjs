#!/usr/bin/env node
/**
 * Squarespace order audit — READ ONLY.
 *
 * Fulfillment (tools/fulfill-licenses.mjs) only matches ONE hardcoded product
 * name, so any order whose line items are named anything else is silently
 * discarded while the run still reports success. This script exists to show
 * what the Orders API actually returns, so the matcher can be fixed against
 * real data instead of a guess.
 *
 * It never writes, never mails, never touches the ledger.
 *
 * Workflow logs on this repo are PUBLIC. This prints order numbers, product
 * names, statuses and dates only — never a customer email or address.
 *
 * Required env:
 *   SQUARESPACE_API_KEY  — Commerce Orders read permission
 * Optional env:
 *   SINCE_DAYS           — detail window in days (default 21)
 *   RECENT_COUNT         — how many newest orders to list (default 25)
 */

const TARGET_PRODUCT = "Happy Little Noders";
const SINCE_DAYS = parseInt(process.env.SINCE_DAYS || "21", 10);
const RECENT_COUNT = parseInt(process.env.RECENT_COUNT || "25", 10);

async function fetchAllOrders(apiKey) {
  const orders = [];
  let cursor = null;
  let pages = 0;
  while (true) {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    const url = `https://api.squarespace.com/1.0/commerce/orders?${params}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "dec18-order-audit" },
    });
    if (!res.ok) {
      throw new Error(`Squarespace Orders API ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    const batch = data.result ?? [];
    orders.push(...batch);
    pages++;
    console.log(`  page ${pages}: ${batch.length} order(s), running total ${orders.length}`);
    if (data.pagination?.hasNextPage && data.pagination.nextPageCursor) {
      cursor = data.pagination.nextPageCursor;
    } else break;
  }
  return orders;
}

const num = (o) => Number(o.orderNumber) || 0;
const names = (o) => (o.lineItems ?? []).map((li) => li.productName ?? "(unnamed)");

async function main() {
  const apiKey = process.env.SQUARESPACE_API_KEY;
  if (!apiKey) {
    console.error("Missing SQUARESPACE_API_KEY");
    process.exit(1);
  }

  console.log("Fetching every order from the Commerce Orders API...");
  const orders = await fetchAllOrders(apiKey);
  console.log(`\nTOTAL ORDERS RETURNED BY THE API: ${orders.length}\n`);

  // ── Exact product-name histogram ────────────────────────────────
  // Quoted via JSON.stringify so trailing spaces, curly apostrophes,
  // non-breaking spaces and plural differences are all visible.
  const hist = new Map();
  for (const o of orders) {
    for (const n of names(o)) hist.set(n, (hist.get(n) ?? 0) + 1);
  }
  console.log(`DISTINCT PRODUCT NAMES ACROSS ALL LINE ITEMS: ${hist.size}`);
  console.log("(count — exact name, JSON-quoted so whitespace is visible)");
  for (const [n, c] of [...hist].sort((a, b) => b[1] - a[1])) {
    const flag = n === TARGET_PRODUCT ? "  <-- MATCHES the fulfillment filter" : "";
    console.log(`  ${String(c).padStart(4)} — ${JSON.stringify(n)}${flag}`);
  }

  const matching = orders.filter((o) => names(o).some((n) => n === TARGET_PRODUCT));
  console.log(`\nOrders matching the current filter exactly: ${matching.length}`);
  console.log(`Orders the current filter DISCARDS:         ${orders.length - matching.length}`);

  // ── Fulfillment status spread ───────────────────────────────────
  const byStatus = new Map();
  for (const o of orders) {
    const k = o.fulfillmentStatus ?? "(none)";
    byStatus.set(k, (byStatus.get(k) ?? 0) + 1);
  }
  console.log("\nFULFILLMENT STATUS SPREAD (all orders):");
  for (const [k, c] of [...byStatus].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(c).padStart(4)} — ${k}`);
  }

  // ── Order-number range and gaps ─────────────────────────────────
  const nums = orders.map(num).filter(Boolean).sort((a, b) => a - b);
  if (nums.length) {
    const lo = nums[0], hi = nums[nums.length - 1];
    const have = new Set(nums);
    const gaps = [];
    for (let i = lo; i <= hi; i++) if (!have.has(i)) gaps.push(i);
    console.log(`\nORDER NUMBER RANGE: #${lo} .. #${hi} (${nums.length} returned)`);
    console.log(`Numbers in that range NOT returned by the API: ${gaps.length}` +
      (gaps.length ? ` -> ${gaps.join(", ")}` : ""));
  }

  // ── Recent detail ───────────────────────────────────────────────
  const sorted = [...orders].sort((a, b) => num(b) - num(a));
  console.log(`\nNEWEST ${Math.min(RECENT_COUNT, sorted.length)} ORDERS BY NUMBER:`);
  for (const o of sorted.slice(0, RECENT_COUNT)) {
    const hit = names(o).some((n) => n === TARGET_PRODUCT) ? "MATCH " : "SKIP  ";
    const created = (o.createdOn ?? "").slice(0, 16);
    const total = o.grandTotal?.value ?? "?";
    console.log(`  ${hit}#${o.orderNumber}  ${created}  ${String(total).padStart(8)}  ` +
      `${o.fulfillmentStatus ?? "-"}  ${JSON.stringify(names(o))}`);
  }

  // ── The window the user is asking about ─────────────────────────
  const cutoff = Date.now() - SINCE_DAYS * 86400_000;
  const recent = orders.filter((o) => Date.parse(o.createdOn ?? 0) >= cutoff);
  console.log(`\nORDERS CREATED IN THE LAST ${SINCE_DAYS} DAYS: ${recent.length}`);
  for (const o of recent.sort((a, b) => Date.parse(a.createdOn) - Date.parse(b.createdOn))) {
    const hit = names(o).some((n) => n === TARGET_PRODUCT) ? "MATCH " : "SKIP  ";
    console.log(`  ${hit}#${o.orderNumber}  ${o.createdOn}  ` +
      `${o.fulfillmentStatus ?? "-"}  test=${o.testmode ?? false}  ${JSON.stringify(names(o))}`);
  }

  console.log("\nAudit complete. No data was written, no mail was sent.");
}

main().catch((err) => {
  console.error(`Audit failed: ${err.message}`);
  process.exit(1);
});
