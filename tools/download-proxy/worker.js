/**
 * Dec 18 Studios — Download Proxy Worker
 *
 * Validates the caller's license token (Ed25519 D18.xxx.xxx format),
 * then proxies the GitHub release-asset download using a stored PAT.
 *
 * Secrets (set via `wrangler secret put`):
 *   GITHUB_PAT  — Fine-grained PAT with Contents:read on plugin repos
 *
 * Environment variables (set in wrangler.toml):
 *   PUBLIC_KEY_SPKI_B64 — Ed25519 public key in SPKI DER, base64-encoded
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
// Request handler
// --------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "GET") {
      return errorResponse(405, "Method not allowed");
    }

    // Extract license token. Header is preferred (app path: reqwest sets the
    // Authorization header), but a browser top-level navigation cannot set
    // headers, so the website passes the token as a ?token= query param.
    const reqUrl = new URL(request.url);
    const authHeader = request.headers.get("Authorization") || "";
    const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const licenseToken =
      tokenMatch?.[1] ||
      request.headers.get("X-License-Token") ||
      reqUrl.searchParams.get("token") ||
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

    // Enforce expiry: a license with exp (unix seconds) in the past can no longer
    // pull paid assets. Perpetual keys omit exp. The app surfaces this as
    // "Expired — renew" and greys out paid downloads; this is the hard gate.
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
      return errorResponse(403, "License expired. Renew to download paid plugins.");
    }

    // Parse the request path. Two shapes are accepted:
    //   list:     /v1/<owner>/<repo>/releases
    //   download: /v1/<owner>/<repo>/releases/download/<tag>/<asset>
    const url = reqUrl;

    const GITHUB_PAT = env.GITHUB_PAT;
    if (!GITHUB_PAT) {
      return errorResponse(500, "Server misconfigured: missing GitHub PAT");
    }
    const ghHeaders = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GITHUB_PAT}`,
      "User-Agent": "Dec18-Download-Proxy/1.0",
    };

    // --- Release listing: powers the website version dropdown -------------
    const listMatch = url.pathname.match(
      /^\/v1\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/releases$/
    );
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

    // --- Asset download ---------------------------------------------------
    const pathMatch = url.pathname.match(
      /^\/v1\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/releases\/download\/([^/]+)\/(.+)$/
    );
    if (!pathMatch) {
      return errorResponse(400, "Invalid download path. Expected /v1/:owner/:repo/releases/download/:tag/:asset");
    }

    const [, owner, repo, tag, asset] = pathMatch;
    const assetPattern = decodeURIComponent(asset);

    // Only allow downloads from dec18studios org
    if (owner.toLowerCase() !== "dec18studios") {
      return errorResponse(403, "Downloads restricted to Dec 18 Studios repos");
    }

    // Resolve the release. "latest" maps to GitHub's latest-release endpoint;
    // any other value is treated as an exact tag (e.g. v12.1.2).
    const releaseUrl =
      tag === "latest"
        ? `https://api.github.com/repos/${owner}/${repo}/releases/latest`
        : `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
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
        Authorization: `Bearer ${GITHUB_PAT}`,
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
  },
};
