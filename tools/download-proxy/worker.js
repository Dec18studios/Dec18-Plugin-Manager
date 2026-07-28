/**
 * Dec 18 Studios — Download Proxy Worker
 *
 * Validates the caller's license token (Ed25519 D18.xxx.xxx format),
 * then proxies the GitHub release-asset download using a stored PAT.
 *
 * This worker is the ONLY server-side gate on paid downloads. The 6-digit OTP
 * flow replaced *typing* a license key, not the key's authority: /auth/verify
 * hands the account's D18 keys back to the app, which sends them here as a
 * Bearer token. So every per-key control (revocation, entitlement, rate limit)
 * has to live in this file — there is nowhere else it can be enforced.
 *
 * Gates, in order (cheapest first — signature checks cost nothing, D1 does):
 *   1. Ed25519 signature over the payload
 *   2. exp (perpetual keys omit it)
 *   3. Entitlement: payload.p must cover the requested repo
 *   4. Denylist: SHA-256 of the key, for leaked/refunded/abused keys
 *   5. Account: the key's email must still exist and be active in D1
 *   6. Rate limit: per-key download ceiling over a rolling window
 * Every gated request is logged to download_events (key hash, never the key).
 *
 * Secrets (set via `wrangler secret put`):
 *   GITHUB_PAT    — Fine-grained PAT with Contents:read on plugin repos
 *   GRANT_SECRET  — HMAC key for short-lived download grants
 *   IP_HASH_SALT  — salt for hashing client IPs before logging
 *
 * Environment variables: see wrangler.toml
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, X-License-Token",
};

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function base64urlDecode(str) {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
  const binary = atob(base64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64Decode(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64urlEncode(bytes) {
  let binary = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(str) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return toHex(digest);
}

// Constant-time string compare, so grant-signature checks don't leak by timing.
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function envFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === "1" || String(value).toLowerCase() === "true";
}

function envInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Match a release asset against a requested pattern.
//   - Exact name (no "*")  -> case-insensitive exact match (app manifest path)
//   - Glob with "*"        -> "*" becomes ".*", anchored, case-insensitive
//                             (website path, e.g. "*macOS*")
// "*" alone matches any asset and resolves to the first one (single-zip DCTLs).
function matchAsset(assets, pattern) {
  if (!pattern) return null;
  if (pattern === "*") return assets[0] || null;

  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const re = new RegExp(`^${esc}$`, "i");
  // Prefer an exact (case-insensitive) hit before falling back to the glob.
  return (
    assets.find((a) => a.name.toLowerCase() === pattern.toLowerCase()) ||
    assets.find((a) => re.test(a.name)) ||
    null
  );
}

function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// --------------------------------------------------------------------------
// License verification
// --------------------------------------------------------------------------

let _cachedKey = null;

async function importPublicKey(spkiB64) {
  if (_cachedKey) return _cachedKey;
  const keyDer = base64Decode(spkiB64);
  _cachedKey = await crypto.subtle.importKey(
    "spki",
    keyDer,
    { name: "Ed25519" },
    false,
    ["verify"]
  );
  return _cachedKey;
}

async function verifyLicenseToken(token, publicKeyB64) {
  if (!token || !token.startsWith("D18.")) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  // The server signs the base64url string as UTF-8 bytes, NOT the decoded payload
  const payloadB64 = parts[1];
  const messageBytes = new TextEncoder().encode(payloadB64);
  const signature = base64urlDecode(parts[2]);

  const key = await importPublicKey(publicKeyB64);
  const valid = await crypto.subtle.verify("Ed25519", key, signature, messageBytes);
  if (!valid) return null;

  const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)));
  if (!payload.t || !payload.e || !Array.isArray(payload.p)) return null;
  return payload;
}

// --------------------------------------------------------------------------
// Entitlement
// --------------------------------------------------------------------------

// Does a plugin-entitlement list cover this repo?
//
// Reality check on how little this currently gates: fulfill-licenses.mjs sets
// `p = (tier === "master" || tier === "annual") ? ["*"] : [tier]`, and every
// key issued to date is master or annual — so all of them carry ["*"] and sail
// through. This exists to (a) stop a free/limited key reaching paid assets and
// (b) make single-tool tiers enforceable the day one is sold.
//
// Tier names and repo names don't match exactly ("photochemist" vs
// "PhotoChemist-OFX"), so compare on alphanumerics with prefix tolerance.
function entitledToRepo(plugins, repo) {
  if (!Array.isArray(plugins) || plugins.length === 0) return false;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const want = norm(repo);
  if (!want) return false;

  for (const raw of plugins) {
    if (typeof raw !== "string") continue;
    const v = raw.trim().toLowerCase();
    if (v === "*" || v === "all") return true;
    const p = norm(v);
    if (!p) continue;
    // "photochemist" covers repo "PhotoChemist-OFX"; a repo id may also be the
    // shorter of the two, so accept a prefix relation in either direction.
    if (want === p || want.startsWith(p) || p.startsWith(want)) return true;
  }
  return false;
}

// --------------------------------------------------------------------------
// D1-backed gates
//
// Philosophy: a definite "no" from a healthy database always denies. An
// *error* talking to the database is a different thing — by default it fails
// open, because a D1 blip must not stop paying customers from downloading.
// Set STRICT_DB="1" to fail closed instead.
// --------------------------------------------------------------------------

function dbFailure(env, reason) {
  return envFlag(env.STRICT_DB, false)
    ? { ok: false, reason, status: 503 }
    : { ok: true, degraded: reason };
}

async function checkDenylist(env, keyHash) {
  if (!env.DB) return { ok: true, degraded: "no-db-binding" };
  try {
    const row = await env.DB.prepare("SELECT reason FROM key_denylist WHERE key_hash = ?")
      .bind(keyHash)
      .first();
    if (row) {
      return {
        ok: false,
        reason: `denylisted:${row.reason || "revoked"}`,
        status: 403,
        message: "This license key has been revoked. Contact support@dec18studios.com.",
      };
    }
    return { ok: true };
  } catch (err) {
    console.error("denylist lookup failed:", err?.message || err);
    return dbFailure(env, "denylist-error");
  }
}

async function checkAccount(env, email) {
  if (!env.DB) return { ok: true, degraded: "no-db-binding" };
  if (!envFlag(env.ENFORCE_ACCOUNT, true)) return { ok: true, degraded: "account-check-off" };
  try {
    const row = await env.DB.prepare(
      "SELECT plugins, active_until FROM accounts WHERE email = ?"
    )
      .bind(String(email).trim().toLowerCase())
      .first();

    // No row = the key's owner is not in the ledger any more (deleted, refunded,
    // or the key was minted outside fulfillment). Deleting the account row is
    // the intended revocation lever, so this has to be a denial.
    if (!row) {
      return {
        ok: false,
        reason: "no-account",
        status: 403,
        message: "No active account for this license. Contact support@dec18studios.com.",
      };
    }

    // active_until NULL = perpetual.
    if (row.active_until && Number(row.active_until) < Math.floor(Date.now() / 1000)) {
      return {
        ok: false,
        reason: "account-expired",
        status: 403,
        message: "Subscription expired. Renew to download paid plugins.",
      };
    }

    let plugins = null;
    try {
      const parsed = JSON.parse(row.plugins || "null");
      if (Array.isArray(parsed) && parsed.length) plugins = parsed;
    } catch {
      /* malformed plugins column — fall back to the token's list */
    }
    return { ok: true, plugins };
  } catch (err) {
    console.error("account lookup failed:", err?.message || err);
    return dbFailure(env, "account-error");
  }
}

async function checkRateLimit(env, keyHash) {
  if (!env.DB) return { ok: true, degraded: "no-db-binding" };
  if (!envFlag(env.ENFORCE_RATE_LIMIT, true)) return { ok: true, degraded: "rate-limit-off" };
  const limit = envInt(env.RATE_LIMIT_DOWNLOADS, 40);
  const windowS = envInt(env.RATE_LIMIT_WINDOW_S, 3600);
  const since = Math.floor(Date.now() / 1000) - windowS;
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM download_events WHERE key_hash = ? AND ts > ? AND outcome = 'ok'"
    )
      .bind(keyHash, since)
      .first();
    const n = Number(row?.n || 0);
    if (n >= limit) {
      return {
        ok: false,
        reason: `rate-limited:${n}`,
        status: 429,
        message: `Download limit reached (${limit} per ${Math.round(windowS / 60)} minutes). Try again later.`,
      };
    }
    return { ok: true };
  } catch (err) {
    console.error("rate-limit lookup failed:", err?.message || err);
    return dbFailure(env, "rate-limit-error");
  }
}

async function logDownload(env, entry) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      `INSERT INTO download_events (key_hash, email, repo, tag, asset, outcome, ip_hash, country, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        entry.keyHash,
        entry.email || null,
        entry.repo || null,
        entry.tag || null,
        entry.asset || null,
        entry.outcome,
        entry.ipHash || null,
        entry.country || null,
        Math.floor(Date.now() / 1000)
      )
      .run();
  } catch (err) {
    // Logging must never break a download.
    console.error("download_events insert failed:", err?.message || err);
  }
}

// --------------------------------------------------------------------------
// Short-lived download grants
//
// A browser download is a top-level navigation, so it cannot send an
// Authorization header — which is why the raw license key used to ride along
// in ?token=, landing in browser history, referrers and any shared link.
//
// A grant replaces it: the page fetches one with the key in a header (XHR can
// do that), and gets back a URL carrying an opaque HMAC blob that is bound to
// one repo+tag+asset and expires in minutes. Leaking a grant URL leaks one
// download of one file; leaking a ?token= URL leaks the whole catalogue,
// forever.
//
// Deliberately stateless: a single-use grant would need a D1 write per
// download and would break on the range/retry requests browsers issue mid-
// download. Tight binding + a 5-minute TTL is the better trade.
// --------------------------------------------------------------------------

async function importGrantKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function signGrant(secret, claims) {
  const body = base64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const key = await importGrantKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${base64urlEncode(sig)}`;
}

async function verifyGrant(secret, grant) {
  if (!grant || typeof grant !== "string") return null;
  const dot = grant.indexOf(".");
  if (dot <= 0) return null;
  const body = grant.slice(0, dot);
  const providedSig = grant.slice(dot + 1);

  const key = await importGrantKey(secret);
  const expected = base64urlEncode(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
  );
  if (!timingSafeEqual(providedSig, expected)) return null;

  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64urlDecode(body)));
  } catch {
    return null;
  }
  if (!claims || typeof claims.x !== "number") return null;
  if (claims.x < Math.floor(Date.now() / 1000)) return null;
  return claims;
}

// --------------------------------------------------------------------------
// Request handler
// --------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "GET") {
      return errorResponse(405, "Method not allowed");
    }

    const reqUrl = new URL(request.url);
    const clientIp = request.headers.get("CF-Connecting-IP") || "";
    const country = request.cf?.country || null;
    const ipHash = clientIp
      ? (await sha256Hex(`${env.IP_HASH_SALT || "no-salt"}:${clientIp}`)).slice(0, 32)
      : null;

    const GITHUB_PAT = env.GITHUB_PAT;
    if (!GITHUB_PAT) {
      return errorResponse(500, "Server misconfigured: missing GitHub PAT");
    }
    const ghHeaders = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GITHUB_PAT}`,
      "User-Agent": "Dec18-Download-Proxy/1.0",
    };

    // ---- Path shapes -----------------------------------------------------
    //   grant:    /v1/grant?repo=&tag=&asset=
    //   list:     /v1/<owner>/<repo>/releases
    //   download: /v1/<owner>/<repo>/releases/download/<tag>/<asset>
    const isGrantRequest = reqUrl.pathname === "/v1/grant";
    const listMatch = reqUrl.pathname.match(
      /^\/v1\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/releases$/
    );
    const pathMatch = reqUrl.pathname.match(
      /^\/v1\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/releases\/download\/([^/]+)\/(.+)$/
    );

    // ---- Grant redemption: a download URL may carry ?g= instead of a key --
    // Checked before license verification, because a grant IS the credential
    // on that request. The denylist is still consulted, so revoking a key kills
    // its outstanding grants too.
    const grantParam = reqUrl.searchParams.get("g");
    if (grantParam && pathMatch) {
      if (!env.GRANT_SECRET) {
        return errorResponse(500, "Server misconfigured: missing grant secret");
      }
      const claims = await verifyGrant(env.GRANT_SECRET, grantParam);
      if (!claims) {
        return errorResponse(403, "Download link expired or invalid. Return to the members page and try again.");
      }
      const [, , grepo, gtag, gasset] = pathMatch;
      // Bind the grant to exactly what it was issued for.
      if (
        claims.r !== grepo.toLowerCase() ||
        claims.t !== gtag ||
        claims.a !== decodeURIComponent(gasset)
      ) {
        return errorResponse(403, "Download link does not match this file.");
      }
      const deny = await checkDenylist(env, claims.k);
      if (!deny.ok) {
        ctx.waitUntil(
          logDownload(env, {
            keyHash: claims.k,
            email: claims.e,
            repo: grepo,
            tag: gtag,
            asset: decodeURIComponent(gasset),
            outcome: deny.reason,
            ipHash,
            country,
          })
        );
        return errorResponse(deny.status, deny.message || "License revoked");
      }
      ctx.waitUntil(
        logDownload(env, {
          keyHash: claims.k,
          email: claims.e,
          repo: grepo,
          tag: gtag,
          asset: decodeURIComponent(gasset),
          outcome: "ok",
          ipHash,
          country,
        })
      );
      return streamAsset(ghHeaders, grepo, gtag, decodeURIComponent(gasset));
    }

    // ---- Extract the license token ---------------------------------------
    // Header is preferred (app path: reqwest sets Authorization; the members
    // page uses XHR for listings and /v1/grant). ?token= is the legacy path
    // that puts the raw key in a URL — kept alive only while the website still
    // depends on it, and switchable off with ALLOW_TOKEN_QUERY=0.
    const authHeader = request.headers.get("Authorization") || "";
    const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const allowTokenQuery = envFlag(env.ALLOW_TOKEN_QUERY, true);
    const queryToken = reqUrl.searchParams.get("token") || "";
    const usedQueryToken = !tokenMatch?.[1] && !request.headers.get("X-License-Token") && !!queryToken;

    if (usedQueryToken && !allowTokenQuery) {
      return errorResponse(
        401,
        "Tokens in the URL are no longer accepted. Reload the members page to get a fresh download link."
      );
    }

    const licenseToken =
      tokenMatch?.[1] ||
      request.headers.get("X-License-Token") ||
      (allowTokenQuery ? queryToken : "") ||
      "";

    if (!licenseToken) {
      return errorResponse(401, "Missing license token");
    }

    // Verify the token
    const PUBLIC_KEY = env.PUBLIC_KEY_SPKI_B64;
    if (!PUBLIC_KEY) {
      return errorResponse(500, "Server misconfigured: missing public key");
    }

    let payload;
    try {
      payload = await verifyLicenseToken(licenseToken, PUBLIC_KEY);
    } catch {
      return errorResponse(401, "License verification failed");
    }
    if (!payload) {
      return errorResponse(401, "Invalid or expired license token");
    }

    const keyHash = await sha256Hex(licenseToken);
    const email = String(payload.e || "").trim().toLowerCase();

    // Enforce expiry: a license with exp (unix seconds) in the past can no longer
    // pull paid assets. Perpetual keys omit exp. The app surfaces this as
    // "Expired — renew" and greys out paid downloads; this is the hard gate.
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
      ctx.waitUntil(
        logDownload(env, { keyHash, email, outcome: "denied:expired", ipHash, country })
      );
      return errorResponse(403, "License expired. Renew to download paid plugins.");
    }

    // The denylist is the fastest revocation lever there is — it applies to
    // every route, including release listings.
    const deny = await checkDenylist(env, keyHash);
    if (!deny.ok) {
      ctx.waitUntil(
        logDownload(env, { keyHash, email, outcome: deny.reason, ipHash, country })
      );
      return errorResponse(deny.status, deny.message || "License revoked");
    }

    // ---- Grant issuance --------------------------------------------------
    if (isGrantRequest) {
      const repo = reqUrl.searchParams.get("repo") || "";
      const tag = reqUrl.searchParams.get("tag") || "latest";
      const asset = reqUrl.searchParams.get("asset") || "*";
      if (!/^[a-zA-Z0-9_.-]+$/.test(repo)) {
        return errorResponse(400, "Invalid or missing repo");
      }
      if (!env.GRANT_SECRET) {
        return errorResponse(500, "Server misconfigured: missing grant secret");
      }

      const gate = await gateRepoAccess(env, { payload, keyHash, email, repo });
      if (!gate.ok) {
        ctx.waitUntil(
          logDownload(env, { keyHash, email, repo, tag, asset, outcome: gate.reason, ipHash, country })
        );
        return errorResponse(gate.status, gate.message);
      }

      const ttl = envInt(env.GRANT_TTL_S, 300);
      const expiresAt = Math.floor(Date.now() / 1000) + ttl;
      const grant = await signGrant(env.GRANT_SECRET, {
        r: repo.toLowerCase(),
        t: tag,
        a: asset,
        e: email,
        k: keyHash,
        x: expiresAt,
      });
      const downloadUrl =
        `${reqUrl.origin}/v1/Dec18studios/${encodeURIComponent(repo)}/releases/download/` +
        `${encodeURIComponent(tag)}/${encodeURIComponent(asset)}?g=${encodeURIComponent(grant)}`;

      return new Response(
        JSON.stringify({ url: downloadUrl, expires_at: expiresAt, expires_in: ttl }),
        { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    // ---- Release listing: powers the website version dropdown ------------
    if (listMatch) {
      const [, owner, repo] = listMatch;
      if (owner.toLowerCase() !== "dec18studios") {
        return errorResponse(403, "Downloads restricted to Dec 18 Studios repos");
      }
      const listResp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`,
        { headers: ghHeaders }
      );
      if (!listResp.ok) {
        return errorResponse(listResp.status, `Could not list releases for ${repo}`);
      }
      const releases = await listResp.json();
      // GitHub orders /releases by created_at, which TIES for every release cut
      // from a single-commit repo (all our release repos) — so "first = newest"
      // is wrong (e.g. beta.10 sorted below beta.9). Sort by published_at
      // (actual release recency, fallback created_at) so every consumer of this
      // endpoint gets true-newest-first without client-side workarounds.
      const trimmed = (Array.isArray(releases) ? releases : [])
        .filter((r) => !r.draft)
        .sort(
          (a, b) =>
            (Date.parse(b.published_at || b.created_at) || 0) -
            (Date.parse(a.published_at || a.created_at) || 0)
        )
        .map((r) => ({
          tag: r.tag_name,
          name: r.name,
          prerelease: !!r.prerelease,
          published_at: r.published_at,
        }));
      return new Response(JSON.stringify(trimmed), {
        status: 200,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    // ---- Asset download --------------------------------------------------
    if (!pathMatch) {
      return errorResponse(400, "Invalid download path. Expected /v1/:owner/:repo/releases/download/:tag/:asset");
    }

    const [, owner, repo, tag, asset] = pathMatch;
    const assetPattern = decodeURIComponent(asset);

    // Only allow downloads from dec18studios org
    if (owner.toLowerCase() !== "dec18studios") {
      return errorResponse(403, "Downloads restricted to Dec 18 Studios repos");
    }

    const gate = await gateRepoAccess(env, { payload, keyHash, email, repo });
    if (!gate.ok) {
      ctx.waitUntil(
        logDownload(env, {
          keyHash, email, repo, tag, asset: assetPattern,
          outcome: gate.reason, ipHash, country,
        })
      );
      return errorResponse(gate.status, gate.message);
    }

    const rate = await checkRateLimit(env, keyHash);
    if (!rate.ok) {
      ctx.waitUntil(
        logDownload(env, {
          keyHash, email, repo, tag, asset: assetPattern,
          outcome: rate.reason, ipHash, country,
        })
      );
      return errorResponse(rate.status, rate.message);
    }

    ctx.waitUntil(
      logDownload(env, {
        keyHash, email, repo, tag, asset: assetPattern,
        outcome: "ok", ipHash, country,
      })
    );

    return streamAsset(ghHeaders, repo, tag, assetPattern);
  },
};

// --------------------------------------------------------------------------
// Shared: account + entitlement gate for one repo
// --------------------------------------------------------------------------

async function gateRepoAccess(env, { payload, keyHash, email, repo }) {
  const account = await checkAccount(env, email);
  if (!account.ok) {
    return {
      ok: false,
      reason: `denied:${account.reason}`,
      status: account.status,
      message: account.message,
    };
  }

  // D1 can only WIDEN entitlement, never narrow it: the ledger→D1 sync can lag,
  // and a stale row must not lock a paying customer out of a plugin their key
  // already grants. Narrowing is what the denylist is for.
  const entitled =
    entitledToRepo(payload.p, repo) ||
    (account.plugins ? entitledToRepo(account.plugins, repo) : false);

  if (!entitled) {
    if (!envFlag(env.ENFORCE_ENTITLEMENT, true)) {
      console.warn(`entitlement (log-only): ${keyHash.slice(0, 12)} -> ${repo}`);
      return { ok: true };
    }
    return {
      ok: false,
      reason: "denied:not-entitled",
      status: 403,
      message: `Your licence does not include ${repo}.`,
    };
  }
  return { ok: true };
}

// --------------------------------------------------------------------------
// Shared: resolve a release and stream the asset back
// --------------------------------------------------------------------------

async function streamAsset(ghHeaders, repo, tag, assetPattern) {
  // Resolve the release. "latest" maps to GitHub's latest-release endpoint;
  // any other value is treated as an exact tag (e.g. v12.1.2).
  const releaseUrl =
    tag === "latest"
      ? `https://api.github.com/repos/Dec18studios/${repo}/releases/latest`
      : `https://api.github.com/repos/Dec18studios/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const releaseResp = await fetch(releaseUrl, { headers: ghHeaders });

  if (!releaseResp.ok) {
    return errorResponse(releaseResp.status, `Release not found: ${tag}`);
  }

  const release = await releaseResp.json();
  const matchedAsset = matchAsset(release.assets || [], assetPattern);
  if (!matchedAsset) {
    return errorResponse(404, `Asset not found: ${assetPattern}`);
  }

  // Download the asset via the API (works for private repos)
  const assetResp = await fetch(matchedAsset.url, {
    headers: {
      Accept: "application/octet-stream",
      Authorization: ghHeaders.Authorization,
      "User-Agent": "Dec18-Download-Proxy/1.0",
    },
  });

  if (!assetResp.ok) {
    return errorResponse(assetResp.status, "Failed to fetch asset from GitHub");
  }

  // Stream the asset back to the caller. Name the download after the asset
  // GitHub actually served (matchedAsset.name) — NOT the request path, which
  // for glob patterns (single-zip DCTLs use "*") would save the file as "*".
  return new Response(assetResp.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${matchedAsset.name}"`,
      ...CORS_HEADERS,
    },
  });
}
