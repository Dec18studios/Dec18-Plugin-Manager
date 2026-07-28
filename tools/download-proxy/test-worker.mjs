// End-to-end test of the download proxy worker.
// Throwaway Ed25519 keypair, stubbed D1, stubbed GitHub. No real secrets.
import worker from "./worker.js";

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const spki = Buffer.from(await crypto.subtle.exportKey("spki", kp.publicKey)).toString("base64");

async function mintToken(payload) {
  const p = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(p));
  return `D18.${p}.${b64url(sig)}`;
}

// ---- stub D1 -------------------------------------------------------------
function makeDB({ accounts = {}, denylist = {}, eventCount = 0, throwOn = null } = {}) {
  const inserted = [];
  return {
    inserted,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (throwOn && sql.includes(throwOn)) throw new Error("D1 down");
              if (sql.includes("key_denylist")) return denylist[args[0]] || null;
              if (sql.includes("FROM accounts")) return accounts[args[0]] || null;
              if (sql.includes("COUNT(*)")) return { n: eventCount };
              return null;
            },
            async run() {
              inserted.push({ sql, args });
              return {};
            },
          };
        },
      };
    },
  };
}

// ---- stub GitHub ---------------------------------------------------------
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("api.github.com")) {
    if (u.includes("/releases/tags/") || u.includes("/releases/latest")) {
      return new Response(
        JSON.stringify({ assets: [{ name: "Plugin-macOS.zip", url: "https://api.github.com/asset/1" }] }),
        { status: 200 }
      );
    }
    if (u.includes("/releases?per_page")) {
      return new Response(
        JSON.stringify([
          { tag_name: "v1.0", name: "v1.0", draft: false, prerelease: false, published_at: "2026-01-01T00:00:00Z" },
          { tag_name: "v2.0", name: "v2.0", draft: false, prerelease: false, published_at: "2026-06-01T00:00:00Z" },
        ]),
        { status: 200 }
      );
    }
    if (u.includes("/asset/1")) return new Response("ZIPBYTES", { status: 200 });
  }
  return realFetch(url, opts);
};

const ctx = { waitUntil: (p) => p };
const baseEnv = (over = {}) => ({
  PUBLIC_KEY_SPKI_B64: spki,
  GITHUB_PAT: "ghp_fake",
  GRANT_SECRET: "test-grant-secret-abcdefghijklmnop",
  IP_HASH_SALT: "salt",
  ...over,
});

const DL = (repo, tag, asset) =>
  `https://proxy.test/v1/Dec18studios/${repo}/releases/download/${tag}/${encodeURIComponent(asset)}`;

let pass = 0, fail = 0;
async function check(name, expectStatus, resp, extra) {
  const peek = resp.clone();
  const ok = resp.status === expectStatus && (!extra || (await extra(resp)));
  const body = await peek.text().catch(() => "");
  console.log(`${ok ? "  ok  " : "FAIL  "} ${name}  → ${resp.status} ${ok ? "" : body.slice(0, 120)}`);
  ok ? pass++ : fail++;
}

// ==========================================================================
const masterKey = await mintToken({ t: "master", e: "a@x.com", p: ["*"] });
const soloKey = await mintToken({ t: "photochemist", e: "b@x.com", p: ["photochemist"] });
const freeKey = await mintToken({ t: "free", e: "c@x.com", p: ["free"] });
const expiredKey = await mintToken({ t: "annual", e: "d@x.com", p: ["*"], exp: 1000 });
const accounts = {
  "a@x.com": { plugins: '["*"]', active_until: null },
  "b@x.com": { plugins: '["photochemist"]', active_until: null },
  "c@x.com": { plugins: '["free"]', active_until: null },
  "d@x.com": { plugins: '["*"]', active_until: null },
  "e@x.com": { plugins: '["*"]', active_until: 1000 },
};
const H = (t) => ({ Authorization: `Bearer ${t}` });

console.log("\n— baseline / regression —");
await check("master downloads", 200,
  await worker.fetch(new Request(DL("PhotoChemist-OFX", "v2.0", "*"), { headers: H(masterKey) }), baseEnv({ DB: makeDB({ accounts }) }), ctx),
  async (r) => (await r.text()) === "ZIPBYTES" && r.headers.get("Content-Disposition").includes("Plugin-macOS.zip"));
await check("release list sorted newest-first", 200,
  await worker.fetch(new Request("https://proxy.test/v1/Dec18studios/X/releases", { headers: H(masterKey) }), baseEnv({ DB: makeDB({ accounts }) }), ctx),
  async (r) => (await r.json())[0].tag === "v2.0");
await check("legacy ?token= still works (flag on)", 200,
  await worker.fetch(new Request(DL("X", "v1", "*") + "?token=" + encodeURIComponent(masterKey)), baseEnv({ DB: makeDB({ accounts }) }), ctx));
await check("no token → 401", 401,
  await worker.fetch(new Request(DL("X", "v1", "*")), baseEnv({ DB: makeDB({ accounts }) }), ctx));
await check("bad signature → 401", 401,
  await worker.fetch(new Request(DL("X", "v1", "*"), { headers: H(masterKey.slice(0, -4) + "AAAA") }), baseEnv({ DB: makeDB({ accounts }) }), ctx));
await check("expired key → 403", 403,
  await worker.fetch(new Request(DL("X", "v1", "*"), { headers: H(expiredKey) }), baseEnv({ DB: makeDB({ accounts }) }), ctx));
await check("non-dec18 owner → 403", 403,
  await worker.fetch(new Request("https://proxy.test/v1/evilcorp/X/releases/download/v1/a.zip", { headers: H(masterKey) }), baseEnv({ DB: makeDB({ accounts }) }), ctx));

console.log("\n— #4 entitlement —");
await check("solo key → its own repo (tier≠repo name)", 200,
  await worker.fetch(new Request(DL("PhotoChemist-OFX", "v1", "*"), { headers: H(soloKey) }), baseEnv({ DB: makeDB({ accounts }) }), ctx));
await check("solo key → another repo BLOCKED", 403,
  await worker.fetch(new Request(DL("GradientField-OFX", "v1", "*"), { headers: H(soloKey) }), baseEnv({ DB: makeDB({ accounts }) }), ctx));
await check("free key → paid repo BLOCKED", 403,
  await worker.fetch(new Request(DL("PhotoChemist-OFX", "v1", "*"), { headers: H(freeKey) }), baseEnv({ DB: makeDB({ accounts }) }), ctx));
await check("free key allowed when ENFORCE_ENTITLEMENT=0", 200,
  await worker.fetch(new Request(DL("PhotoChemist-OFX", "v1", "*"), { headers: H(freeKey) }), baseEnv({ DB: makeDB({ accounts }), ENFORCE_ENTITLEMENT: "0" }), ctx));

console.log("\n— #5 denylist —");
{
  const kh = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(masterKey))).toString("hex");
  const db = makeDB({ accounts, denylist: { [kh]: { reason: "leaked" } } });
  await check("denylisted key → 403 on download", 403,
    await worker.fetch(new Request(DL("X", "v1", "*"), { headers: H(masterKey) }), baseEnv({ DB: db }), ctx));
  await check("denylisted key → 403 on listing too", 403,
    await worker.fetch(new Request("https://proxy.test/v1/Dec18studios/X/releases", { headers: H(masterKey) }), baseEnv({ DB: db }), ctx));
}

console.log("\n— #6 account gate —");
await check("email not in D1 → 403", 403,
  await worker.fetch(new Request(DL("X", "v1", "*"), { headers: H(masterKey) }), baseEnv({ DB: makeDB({ accounts: {} }) }), ctx));
{
  const k = await mintToken({ t: "annual", e: "e@x.com", p: ["*"] });
  await check("account past active_until → 403", 403,
    await worker.fetch(new Request(DL("X", "v1", "*"), { headers: H(k) }), baseEnv({ DB: makeDB({ accounts }) }), ctx));
}
await check("no D1 binding at all → still serves", 200,
  await worker.fetch(new Request(DL("X", "v1", "*"), { headers: H(masterKey) }), baseEnv(), ctx));
await check("D1 error, STRICT_DB=0 → fails OPEN", 200,
  await worker.fetch(new Request(DL("X", "v1", "*"), { headers: H(masterKey) }), baseEnv({ DB: makeDB({ accounts, throwOn: "FROM accounts" }) }), ctx));
await check("D1 error, STRICT_DB=1 → fails CLOSED", 503,
  await worker.fetch(new Request(DL("X", "v1", "*"), { headers: H(masterKey) }), baseEnv({ DB: makeDB({ accounts, throwOn: "FROM accounts" }), STRICT_DB: "1" }), ctx));

console.log("\n— #8 rate limit + logging —");
await check("under limit → 200", 200,
  await worker.fetch(new Request(DL("X", "v1", "*"), { headers: H(masterKey) }), baseEnv({ DB: makeDB({ accounts, eventCount: 39 }) }), ctx));
await check("at limit → 429", 429,
  await worker.fetch(new Request(DL("X", "v1", "*"), { headers: H(masterKey) }), baseEnv({ DB: makeDB({ accounts, eventCount: 40 }) }), ctx));
{
  const db = makeDB({ accounts });
  await worker.fetch(new Request(DL("PhotoChemist-OFX", "v2.0", "*"), { headers: H(masterKey) }), baseEnv({ DB: db }), ctx);
  await new Promise((r) => setTimeout(r, 20));
  const ev = db.inserted.find((i) => i.sql.includes("download_events"));
  const ok = ev && ev.args[5] === "ok" && ev.args[3] === "v2.0" && !JSON.stringify(ev.args).includes("D18.");
  console.log(`${ok ? "  ok  " : "FAIL  "} download logged, raw key NOT stored`);
  ok ? pass++ : fail++;
}

console.log("\n— #7 grants —");
{
  const env = baseEnv({ DB: makeDB({ accounts }) });
  const gr = await worker.fetch(new Request("https://proxy.test/v1/grant?repo=PhotoChemist-OFX&tag=v2.0&asset=*", { headers: H(masterKey) }), env, ctx);
  await check("grant issued", 200, gr, async (r) => {
    const j = await r.json();
    return j.url.includes("?g=") && !j.url.includes("D18.") && j.expires_in === 300;
  });
  const { url } = await (await worker.fetch(new Request("https://proxy.test/v1/grant?repo=PhotoChemist-OFX&tag=v2.0&asset=*", { headers: H(masterKey) }), env, ctx)).json();

  await check("grant redeems with NO key present", 200,
    await worker.fetch(new Request(url), env, ctx), async (r) => (await r.text()) === "ZIPBYTES");
  await check("grant for wrong file rejected", 403,
    await worker.fetch(new Request(url.replace("PhotoChemist-OFX", "GradientField-OFX")), env, ctx));
  await check("tampered grant rejected", 403,
    await worker.fetch(new Request(url.slice(0, -3) + "AAA"), env, ctx));
  await check("grant signed with a different secret rejected", 403,
    await worker.fetch(new Request(url), baseEnv({ DB: makeDB({ accounts }), GRANT_SECRET: "other-secret" }), ctx));

  // expiry
  const short = baseEnv({ DB: makeDB({ accounts }), GRANT_TTL_S: "1" });
  const { url: u2 } = await (await worker.fetch(new Request("https://proxy.test/v1/grant?repo=X&tag=v1&asset=*", { headers: H(masterKey) }), short, ctx)).json();
  await new Promise((r) => setTimeout(r, 1300));
  await check("expired grant rejected", 403, await worker.fetch(new Request(u2), short, ctx));

  // denylist kills outstanding grants
  const kh = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(masterKey))).toString("hex");
  await check("denylist kills an outstanding grant", 403,
    await worker.fetch(new Request(url), baseEnv({ DB: makeDB({ accounts, denylist: { [kh]: { reason: "leaked" } } }), GRANT_SECRET: env.GRANT_SECRET }), ctx));

  await check("grant refused for unentitled repo", 403,
    await worker.fetch(new Request("https://proxy.test/v1/grant?repo=GradientField-OFX&tag=v1&asset=*", { headers: H(soloKey) }), env, ctx));
}

console.log("\n— ALLOW_TOKEN_QUERY=0 cutover —");
{
  const env = baseEnv({ DB: makeDB({ accounts }), ALLOW_TOKEN_QUERY: "0" });
  await check("?token= refused when flag off", 401,
    await worker.fetch(new Request(DL("X", "v1", "*") + "?token=" + encodeURIComponent(masterKey)), env, ctx));
  await check("header still fine when flag off", 200,
    await worker.fetch(new Request(DL("X", "v1", "*"), { headers: H(masterKey) }), env, ctx));
  const { url } = await (await worker.fetch(new Request("https://proxy.test/v1/grant?repo=X&tag=v1&asset=*", { headers: H(masterKey) }), env, ctx)).json();
  await check("grant still fine when flag off", 200, await worker.fetch(new Request(url), env, ctx));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
