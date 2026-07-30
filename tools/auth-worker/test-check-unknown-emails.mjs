#!/usr/bin/env node
/**
 * Tests for check-unknown-emails.mjs.
 *
 * Serves fixture orders from a local HTTP server (SQUARESPACE_API_BASE) and a
 * fixture D1 result set (UNKNOWN_EMAILS_FIXTURE), against a throwaway ledger in
 * a temp dir. Touches no real credentials, no network, no database, and never
 * reads the production ledger.
 *
 *   node test-check-unknown-emails.mjs
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "check-unknown-emails.mjs");

// Must be the ASYNC exec: the fixture server lives in this process, and
// execFileSync would block the event loop so the child's request could never
// be answered — the parent would wait on a child waiting on the parent.
const execFileAsync = promisify(execFile);

const envFor = (dir, port, extra = {}) => ({
  ...process.env,
  SQUARESPACE_API_KEY: "test-key",
  SQUARESPACE_API_BASE: `http://127.0.0.1:${port}`,
  LICENSE_LEDGER_DIR: dir,
  UNKNOWN_EMAILS_FIXTURE: "",
  CI: "",
  ...extra,
});

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? `  → ${detail}` : ""}`);
  }
}

// A real signed key would need the private key; the tool only ever decodes the
// payload, so an unsigned-but-well-formed token exercises every path it takes.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const keyFor = (email) => `D18.${b64({ t: "annual", e: email, p: ["*"], exp: 1816855874 })}.sig`;

const OLD = "old.customer@outlook.com";
const NEW = "new.customer@proton.me";
const STRANGER = "never.bought@example.com";

function ledgerFixture() {
  return {
    "someone.else@gmail.com": {
      processedAt: "2026-01-02T00:00:00.000Z",
      orderId: "order-aaa",
      orderNumber: "100",
      name: "Someone Else",
      tier: "annual",
      key: keyFor("someone.else@gmail.com"),
    },
    [OLD]: {
      processedAt: "2026-07-29T10:11:14.596Z",
      orderId: "order-bbb",
      orderNumber: "115",
      name: "Old Customer",
      tier: "annual",
      key: keyFor(OLD),
    },
  };
}

function ordersFixture({ driftedEmail, linkedOrder = false } = {}) {
  const orders = [
    {
      id: "order-aaa",
      orderNumber: "100",
      customerId: "cust-1",
      customerEmail: "someone.else@gmail.com",
      lineItems: [{ productName: "Happy Little Noders" }],
    },
    {
      id: "order-bbb",
      orderNumber: "115",
      customerId: "cust-2",
      customerEmail: driftedEmail ?? OLD,
      lineItems: [{ productName: "Happy Little Noders" }],
    },
    {
      id: "order-ccc",
      orderNumber: "116",
      customerId: "cust-9",
      customerEmail: "unrelated@example.com",
      lineItems: [{ productName: "Some Other Product" }],
    },
  ];
  // The case the drift detector CANNOT see: order 115 still reports the old
  // address, but the customer placed a second order under the new one. That
  // order id is absent from the ledger, so the only thing tying the two
  // addresses together is the customerId they share.
  if (linkedOrder) {
    orders.push({
      id: "order-ddd",
      orderNumber: "117",
      customerId: "cust-2",
      customerEmail: NEW,
      lineItems: [{ productName: "Happy Little Noders" }],
    });
  }
  return orders;
}

/** Serve orders in two pages so cursor pagination is genuinely exercised. */
function startServer(orders) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      if (!/^Bearer /.test(req.headers.authorization || "")) {
        res.writeHead(401).end("{}");
        return;
      }
      const cursor = url.searchParams.get("cursor");
      const body = cursor
        ? { result: orders.slice(1), pagination: { hasNextPage: false } }
        : { result: orders.slice(0, 1), pagination: { hasNextPage: true, nextPageCursor: "page2" } };
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function run(dir, { unknownRows, args = [], port, resetLedger = true }) {
  if (resetLedger) {
    writeFileSync(join(dir, "processed-subscribers.json"), JSON.stringify(ledgerFixture(), null, 2) + "\n");
  }
  const fixturePath = join(dir, "unknown.json");
  writeFileSync(fixturePath, JSON.stringify(unknownRows ?? []));
  const { stdout } = await execFileAsync("node", [SCRIPT, "--reveal", ...args], {
    encoding: "utf8",
    env: envFor(dir, port, { UNKNOWN_EMAILS_FIXTURE: unknownRows?.length ? fixturePath : "" }),
  });
  const ledger = JSON.parse(readFileSync(join(dir, "processed-subscribers.json"), "utf8"));
  return { out: stdout, ledger };
}

const dir = mkdtempSync(join(tmpdir(), "d18-unknown-"));
const { server, port } = await startServer(ordersFixture({ driftedEmail: NEW }));
// Second server: order 115 has NOT drifted, so anything found here was found
// through the customerId join alone.
const { server: linkedServer, port: linkedPort } = await startServer(ordersFixture({ linkedOrder: true }));

try {
  console.log("— drift detector —");
  {
    const { out, ledger } = await run(dir, { unknownRows: [], args: ["--skip-d1"], port });
    check("spots the changed customerEmail", out.includes(`${OLD} -> ${NEW}`));
    check("reads both pagination pages", out.includes("2 Happy Little Noders order(s)"));
    check("ignores non-target products", !out.includes("unrelated@example.com"));
    check("leaves untouched customers alone", !out.includes("someone.else@gmail.com ->"));
    check("writes nothing without --apply", !(NEW in ledger));
    check("says it is report-only", out.includes("Report only"));
  }

  console.log("\n— locked-out detector (customerId join) —");
  {
    const rows = [{ email: NEW, attempts: 3, first_ts: 1785000000, last_ts: 1785300000, status: "new" }];
    const { out } = await run(dir, { unknownRows: rows, port: linkedPort });
    // Scope this one to the drift section: the migration summary at the end
    // prints the same "old -> new" line, and that IS the expected outcome.
    const driftSection = out.slice(out.indexOf("── drift"), out.indexOf("── locked out"));
    check("drift alone would have missed it", driftSection.includes("none"));
    check("matches via stable customerId", out.includes(`MATCH  ${NEW}`) && out.includes(`<- ${OLD}`));
    check("cites the linking order", out.includes("customerId on order 117"));
    check("reports the attempt count", out.includes("(3x, last 2026-07-29)"));
  }
  {
    const rows = [{ email: STRANGER, attempts: 1, first_ts: 1785000000, last_ts: 1785300000, status: "new" }];
    const { out } = await run(dir, { unknownRows: rows, port: linkedPort });
    check("does NOT match a stranger", !out.includes("MATCH"));
    check("reports them as never-purchased", out.includes(`NONE   ${STRANGER}`));
    check("offers no migration", out.includes("Nothing to migrate"));
  }

  console.log("\n— --apply —");
  {
    const { out, ledger } = await run(dir, { unknownRows: [], args: ["--skip-d1", "--apply"], port });
    check("adds the new address", NEW in ledger);
    check("KEEPS the old address", OLD in ledger);
    check("carries the same key across", ledger[NEW].key === ledger[OLD].key);
    check("records provenance both ways", ledger[NEW].emailChangedFrom === OLD && ledger[OLD].emailChangedTo === NEW);
    check("preserves the order id", ledger[NEW].orderId === "order-bbb");
    check("does not disturb other customers", ledger["someone.else@gmail.com"].key === keyFor("someone.else@gmail.com"));
    check("entry count grew by exactly one", Object.keys(ledger).length === 3);
    check("emits the D1 upsert", out.includes("INSERT INTO accounts") && out.includes(NEW));
    check("upsert carries the tier/expiry from the key", out.includes("'annual'") && out.includes("1816855874"));
  }

  console.log("\n— idempotency —");
  {
    // Second pass over an already-migrated ledger must find nothing new.
    await run(dir, { unknownRows: [], args: ["--skip-d1", "--apply"], port });
    const before = readFileSync(join(dir, "processed-subscribers.json"), "utf8");
    const { out } = await run(dir, {
      unknownRows: [],
      args: ["--skip-d1", "--apply"],
      port,
      resetLedger: false, // keep the migrated ledger from the previous run
    });
    const after = readFileSync(join(dir, "processed-subscribers.json"), "utf8");
    check("re-run is a no-op", out.includes("Nothing to migrate"));
    check("ledger byte-identical on re-run", before === after);
  }

  console.log("\n— masking —");
  {
    writeFileSync(join(dir, "processed-subscribers.json"), JSON.stringify(ledgerFixture(), null, 2) + "\n");
    // No --reveal here: that is the flag under test.
    const { stdout: out } = await execFileAsync("node", [SCRIPT, "--skip-d1"], {
      encoding: "utf8",
      env: envFor(dir, port, { CI: "1" }),
    });
    check("masks addresses when CI is set", !out.includes(NEW) && out.includes("n***@proton.me"));

    // --apply would print the raw key, which masking does not cover.
    let refused = "";
    try {
      await execFileAsync("node", [SCRIPT, "--skip-d1", "--apply"], {
        encoding: "utf8",
        env: envFor(dir, port, { CI: "1" }),
      });
    } catch (err) {
      refused = `${err.stderr || ""}${err.stdout || ""}`;
    }
    check("refuses --apply under CI", refused.includes("refused under CI"));
  }
} finally {
  server.close();
  linkedServer.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
