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

    // Extract license token from header
    const authHeader = request.headers.get("Authorization") || "";
    const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const licenseToken =
      tokenMatch?.[1] || request.headers.get("X-License-Token") || "";

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

    // Parse the requested asset path:
    //   /v1/<owner>/<repo>/releases/download/<tag>/<asset>
    const url = new URL(request.url);
    const pathMatch = url.pathname.match(
      /^\/v1\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/releases\/download\/([^/]+)\/(.+)$/
    );
    if (!pathMatch) {
      return errorResponse(400, "Invalid download path. Expected /v1/:owner/:repo/releases/download/:tag/:asset");
    }

    const [, owner, repo, tag, asset] = pathMatch;

    // Only allow downloads from dec18studios org
    if (owner.toLowerCase() !== "dec18studios") {
      return errorResponse(403, "Downloads restricted to Dec 18 Studios repos");
    }

    // Fetch the asset from GitHub using the PAT
    const GITHUB_PAT = env.GITHUB_PAT;
    if (!GITHUB_PAT) {
      return errorResponse(500, "Server misconfigured: missing GitHub PAT");
    }

    // First, get the release to find the asset ID (required for private repo downloads)
    const releaseUrl = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
    const releaseResp = await fetch(releaseUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${GITHUB_PAT}`,
        "User-Agent": "Dec18-Download-Proxy/1.0",
      },
    });

    if (!releaseResp.ok) {
      return errorResponse(releaseResp.status, `Release not found: ${tag}`);
    }

    const release = await releaseResp.json();
    const matchedAsset = (release.assets || []).find(
      (a) => a.name === decodeURIComponent(asset)
    );
    if (!matchedAsset) {
      return errorResponse(404, `Asset not found: ${decodeURIComponent(asset)}`);
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

    // Stream the asset back to the caller
    return new Response(assetResp.body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${decodeURIComponent(asset)}"`,
        ...CORS_HEADERS,
      },
    });
  },
};
