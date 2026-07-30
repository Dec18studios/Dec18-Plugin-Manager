/**
 * Dec 18 Studios — Auth Worker (email OTP + account sync)
 *
 * Endpoints:
 *   POST /auth/start    { email, deviceId? }
 *       Gate on the entitlement ledger (accounts table). If the email has a
 *       purchase, email a 6-digit code. If not, email a "no purchase found"
 *       notice. The API response is identical either way, so an attacker probing
 *       random addresses learns nothing — the difference only reaches the inbox
 *       owner. Rate-limited per email + per IP.
 *
 *   POST /auth/verify   { email, code, deviceId? }
 *       Check the code (hashed, expiring, max attempts). On success, mark the
 *       account email-verified, log a verification_event (method='otp'), and
 *       return the license key(s) + entitlement so the app can install them.
 *
 *   POST /auth/attest   { key, deviceId? }
 *       Silent path for existing users who already hold a valid signed key.
 *       Verifies the Ed25519 signature locally, ensures an account row exists,
 *       and logs a verification_event (method='silent_key') so we can measure
 *       adoption. No code is emailed. NOTE: possession of a key proves
 *       entitlement, not email ownership — hence the distinct method.
 *
 *   POST /auth/status   { email } | { key }
 *       Returns current entitlement + active_until + expired flag.
 *
 * Bindings (wrangler.toml):
 *   [[d1_databases]] binding = "DB"            — the dec18-auth database
 *   [vars] PUBLIC_KEY_SPKI_B64                 — Ed25519 verify key (same as proxy)
 *   [vars] FROM_EMAIL, FROM_NAME
 *
 * Secrets (wrangler secret put ...):
 *   OTP_PEPPER         — random string mixed into the code hash
 *   BREVO_API_KEY      — Brevo transactional API key (preferred mail transport)
 *   GMAIL_CREDENTIALS  — Google OAuth client JSON (fallback when no Brevo key)
 *   GMAIL_TOKEN        — Google OAuth token JSON (refresh_token; Gmail fallback)
 *   IP_HASH_SALT       — salt for hashing client IPs in the events log
 *
 * Mail transport: Brevo when BREVO_API_KEY is set, else Gmail, else dev-log.
 *
 * Dev:
 *   If no mail transport is configured the code is logged to the console.
 *   If DEV_EXPOSE_CODE = "1" the code is also returned in the JSON response so
 *   the flow is fully testable with `wrangler dev` + curl. NEVER set in prod.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Tunables
const OTP_TTL_SECONDS = 600; // 10 minutes
const OTP_MAX_ATTEMPTS = 5;
const RL_COOLDOWN_SECONDS = 60; // min gap between code requests for one email
const RL_EMAIL_PER_HOUR = 5;
const RL_IP_PER_HOUR = 15;

// --------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------

const now = () => Math.floor(Date.now() / 1000);

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

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

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time string compare (equal length hex strings)
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isExpired(payload) {
  return typeof payload?.exp === "number" && payload.exp < now();
}

// --------------------------------------------------------------------------
// License signature verification (same scheme as download-proxy)
// --------------------------------------------------------------------------

let _cachedKey = null;
async function importPublicKey(spkiB64) {
  if (_cachedKey) return _cachedKey;
  _cachedKey = await crypto.subtle.importKey(
    "spki",
    base64Decode(spkiB64),
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
  // Any malformed input (bad base64, wrong signature length, non-JSON payload)
  // is an *invalid key*, not a server error — return null instead of throwing.
  try {
    const payloadB64 = parts[1];
    const messageBytes = new TextEncoder().encode(payloadB64);
    const signature = base64urlDecode(parts[2]);
    const key = await importPublicKey(publicKeyB64);
    const valid = await crypto.subtle.verify("Ed25519", key, signature, messageBytes);
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)));
    if (!payload.t || !payload.e || !Array.isArray(payload.p)) return null;
    return payload;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Rate limiting (D1-backed fixed window)
// --------------------------------------------------------------------------

/** Returns true if allowed, false if the limit is hit. Increments on allow. */
async function rateAllow(env, scope, limit, windowSeconds) {
  const t = now();
  const row = await env.DB.prepare("SELECT count, window_end FROM rate_limits WHERE scope = ?")
    .bind(scope)
    .first();

  if (!row || row.window_end <= t) {
    await env.DB.prepare(
      "INSERT INTO rate_limits (scope, count, window_end) VALUES (?, 1, ?) " +
        "ON CONFLICT(scope) DO UPDATE SET count = 1, window_end = excluded.window_end"
    )
      .bind(scope, t + windowSeconds)
      .run();
    return true;
  }
  if (row.count >= limit) return false;
  await env.DB.prepare("UPDATE rate_limits SET count = count + 1 WHERE scope = ?")
    .bind(scope)
    .run();
  return true;
}

// --------------------------------------------------------------------------
// Account helpers
// --------------------------------------------------------------------------

async function getAccount(env, email) {
  return env.DB.prepare("SELECT * FROM accounts WHERE email = ?").bind(email).first();
}

function accountEntitlement(row) {
  if (!row) return { keys: [], plugins: [], activeUntil: null, expired: true, found: false };
  const keys = JSON.parse(row.keys || "[]");
  const plugins = JSON.parse(row.plugins || "[]");
  const expired = typeof row.active_until === "number" && row.active_until < now();
  return { keys, plugins, activeUntil: row.active_until ?? null, expired, found: true };
}

/**
 * Record an OTP request for an address with no account.
 *
 * Deliberately best-effort: a failure here must never change the response or
 * break sign-in, so it swallows its own errors. It also must not alter what the
 * caller sees — /auth/start answers identically whether or not an account
 * exists, and that property is the whole reason probing the endpoint teaches an
 * attacker nothing. This only writes to our side of the wall.
 */
async function logUnknownEmail(env, email, deviceId, ipHash) {
  try {
    await env.DB.prepare(
      "INSERT INTO unknown_email_attempts (email, attempts, first_ts, last_ts, last_ip_hash, last_device_id) " +
        "VALUES (?, 1, ?, ?, ?, ?) " +
        "ON CONFLICT(email) DO UPDATE SET " +
        "attempts = attempts + 1, last_ts = excluded.last_ts, " +
        "last_ip_hash = excluded.last_ip_hash, last_device_id = excluded.last_device_id, " +
        // Trying again after we closed it means we got it wrong — reopen.
        "status = CASE WHEN status = 'resolved' THEN 'new' ELSE status END"
    )
      .bind(email, now(), now(), ipHash, deviceId || null)
      .run();
  } catch (err) {
    console.error("unknown-email log failed:", err?.message || err);
  }
}

async function logEvent(env, email, deviceId, method, ipHash) {
  await env.DB.prepare(
    "INSERT INTO verification_events (email, device_id, method, ts, ip_hash) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(email, deviceId || null, method, now(), ipHash || null)
    .run();
  await env.DB.prepare("UPDATE accounts SET last_seen_at = ? WHERE email = ?")
    .bind(now(), email)
    .run();
}

// --------------------------------------------------------------------------
// Gmail send (ported from tools/fulfill-licenses.mjs)
// --------------------------------------------------------------------------

async function gmailAccessToken(credentials, token) {
  const { client_id, client_secret } = credentials.installed ?? credentials.web ?? credentials;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id,
      client_secret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  return (await res.json()).access_token;
}

function buildRawEmail(env, toEmail, subject, body) {
  const fromName = env.FROM_NAME ?? "Dec 18 Studios";
  const fromEmail = env.FROM_EMAIL ?? "create@dec18studios.com";
  const raw = [
    `From: ${fromName} <${fromEmail}>`,
    `To: ${toEmail}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
  ].join("\r\n");
  // base64url
  return btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Sends an email via Brevo's transactional API (api.brevo.com/v3/smtp/email). */
async function brevoSend(env, toEmail, subject, body) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": env.BREVO_API_KEY,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender: {
        name: env.FROM_NAME ?? "Dec 18 Studios",
        email: env.FROM_EMAIL ?? "create@dec18studios.com",
      },
      to: [{ email: toEmail }],
      subject,
      textContent: body,
    }),
  });
  if (!res.ok) throw new Error(`Brevo send failed: ${res.status} ${await res.text()}`);
}

/**
 * Sends an email. Prefers Brevo (transactional) when BREVO_API_KEY is set,
 * falls back to Gmail when only the GMAIL_* creds are present, and logs to the
 * console in dev when neither transport is configured. Flipping BREVO_API_KEY
 * on/off is the whole cutover/revert switch.
 */
async function sendMail(env, toEmail, subject, body) {
  if (env.BREVO_API_KEY) {
    return brevoSend(env, toEmail, subject, body);
  }
  if (!env.GMAIL_CREDENTIALS || !env.GMAIL_TOKEN) {
    console.log(`[dev mail] to=${toEmail} subject="${subject}"\n${body}`);
    return;
  }
  const credentials = JSON.parse(env.GMAIL_CREDENTIALS);
  const token = JSON.parse(env.GMAIL_TOKEN);
  const accessToken = await gmailAccessToken(credentials, token);
  const raw = buildRawEmail(env, toEmail, subject, body);
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`Gmail send failed: ${await res.text()}`);
}

function otpEmailBody(code) {
  return [
    "Here's your Dec 18 Studios verification code:",
    "",
    `    ${code}`,
    "",
    "Enter it in the Plugin Manager to finish signing in. The code expires in 10 minutes.",
    "If you didn't request this, you can ignore this email.",
    "",
    "— Dec 18 Studios",
  ].join("\n");
}

function noPurchaseEmailBody(email) {
  return [
    "Someone (hopefully you) tried to sign in to the Dec 18 Studios Plugin Manager",
    `with this email address (${email}), but we couldn't find a purchase under it.`,
    "",
    "If you bought with a different email, try that one. If you think this is a",
    "mistake, just reply to this email and we'll sort it out.",
    "",
    "— Dec 18 Studios",
  ].join("\n");
}

// --------------------------------------------------------------------------
// Endpoint handlers
// --------------------------------------------------------------------------

async function handleStart(env, req, ipHash) {
  const { email: rawEmail, deviceId } = await req.json().catch(() => ({}));
  const email = normalizeEmail(rawEmail);
  if (!email || !email.includes("@")) return json(400, { error: "Valid email required" });

  // Rate limits: per-IP first (cheap abuse cap), then per-email cooldown + hourly.
  if (!(await rateAllow(env, `start:ip:${ipHash}`, RL_IP_PER_HOUR, 3600))) {
    return json(429, { error: "Too many requests. Try again later." });
  }
  if (!(await rateAllow(env, `cooldown:email:${email}`, 1, RL_COOLDOWN_SECONDS))) {
    return json(429, { error: "A code was just sent. Please wait a minute before retrying." });
  }
  if (!(await rateAllow(env, `start:email:${email}`, RL_EMAIL_PER_HOUR, 3600))) {
    return json(429, { error: "Too many codes requested for this email. Try again later." });
  }

  const account = await getAccount(env, email);

  if (!account) {
    // Gate: no purchase => send a "wrong email" notice, but return the SAME response.
    // Log it first: this is our only signal that someone believes they bought and
    // cannot get in — a changed email, a typo, or a purchase under another address.
    // check-unknown-emails.mjs cross-checks these against Squarespace.
    await logUnknownEmail(env, email, deviceId, ipHash);
    await sendMail(env, email, "Dec 18 Studios sign-in", noPurchaseEmailBody(email));
    return json(200, { sent: true });
  }

  // Generate + store a hashed 6-digit code (overwrites any prior code for this email).
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  const codeHash = await sha256Hex(`${code}:${email}:${env.OTP_PEPPER || ""}`);
  await env.DB.prepare(
    "INSERT INTO otp_codes (email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?) " +
      "ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at"
  )
    .bind(email, codeHash, now() + OTP_TTL_SECONDS, now())
    .run();

  await sendMail(env, email, "Your Dec 18 Studios code", otpEmailBody(code));

  const body = { sent: true };
  if (env.DEV_EXPOSE_CODE === "1") body.devCode = code; // dev only
  return json(200, body);
}

async function handleVerify(env, req, ipHash) {
  const { email: rawEmail, code, deviceId } = await req.json().catch(() => ({}));
  const email = normalizeEmail(rawEmail);
  const submitted = String(code || "").trim();
  if (!email || !submitted) return json(400, { error: "Email and code required" });

  const row = await env.DB.prepare("SELECT * FROM otp_codes WHERE email = ?").bind(email).first();
  if (!row) return json(400, { error: "No code outstanding. Request a new one." });
  if (row.expires_at < now()) {
    await env.DB.prepare("DELETE FROM otp_codes WHERE email = ?").bind(email).run();
    return json(400, { error: "Code expired. Request a new one." });
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    await env.DB.prepare("DELETE FROM otp_codes WHERE email = ?").bind(email).run();
    return json(429, { error: "Too many attempts. Request a new code." });
  }

  const submittedHash = await sha256Hex(`${submitted}:${email}:${env.OTP_PEPPER || ""}`);
  if (!timingSafeEqual(submittedHash, row.code_hash)) {
    await env.DB.prepare("UPDATE otp_codes SET attempts = attempts + 1 WHERE email = ?")
      .bind(email)
      .run();
    return json(400, { error: "Incorrect code.", attemptsLeft: OTP_MAX_ATTEMPTS - row.attempts - 1 });
  }

  // Success: burn the code, mark verified, log the event, return entitlement.
  await env.DB.prepare("DELETE FROM otp_codes WHERE email = ?").bind(email).run();
  const account = await getAccount(env, email);
  if (!account) return json(409, { error: "No account for this email." });

  if (!account.first_verified_at) {
    await env.DB.prepare(
      "UPDATE accounts SET first_verified_at = ?, verify_method = 'otp' WHERE email = ?"
    )
      .bind(now(), email)
      .run();
  }
  await logEvent(env, email, deviceId, "otp", ipHash);

  const ent = accountEntitlement(account);
  return json(200, { verified: true, email, ...ent });
}

async function handleAttest(env, req, ipHash) {
  const { key, deviceId } = await req.json().catch(() => ({}));
  const payload = await verifyLicenseToken(key, env.PUBLIC_KEY_SPKI_B64);
  if (!payload) return json(401, { error: "Invalid license key" });

  const email = normalizeEmail(payload.e);
  let account = await getAccount(env, email);

  // Ensure an account row exists for key-holders we haven't seen yet (legacy users
  // whose key predates the account store). Seed it from the key payload.
  if (!account) {
    const activeUntil = typeof payload.exp === "number" ? payload.exp : null;
    await env.DB.prepare(
      "INSERT INTO accounts (email, keys, plugins, tier, active_until, created_at, verify_method, last_seen_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'silent_key', ?) ON CONFLICT(email) DO NOTHING"
    )
      .bind(email, JSON.stringify([key]), JSON.stringify(payload.p), payload.t, activeUntil, now(), now())
      .run();
    account = await getAccount(env, email);
  }

  await logEvent(env, email, deviceId, "silent_key", ipHash);

  const ent = accountEntitlement(account);
  // Reflect the key's own expiry too (offline source) so the app can grey out paid items.
  return json(200, { ok: true, email, keyExpired: isExpired(payload), ...ent });
}

async function handleStatus(env, req) {
  const { email: rawEmail, key } = await req.json().catch(() => ({}));
  let email = normalizeEmail(rawEmail);
  if (!email && key) {
    const payload = await verifyLicenseToken(key, env.PUBLIC_KEY_SPKI_B64);
    if (!payload) return json(401, { error: "Invalid license key" });
    email = normalizeEmail(payload.e);
  }
  if (!email) return json(400, { error: "email or key required" });
  const account = await getAccount(env, email);
  return json(200, { email, ...accountEntitlement(account) });
}

// --------------------------------------------------------------------------
// Router
// --------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "POST") return json(405, { error: "Method not allowed" });

    const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
    const ipHash = await sha256Hex(`${ip}:${env.IP_HASH_SALT || ""}`);
    const path = new URL(request.url).pathname;

    try {
      switch (path) {
        case "/auth/start":
          return await handleStart(env, request, ipHash);
        case "/auth/verify":
          return await handleVerify(env, request, ipHash);
        case "/auth/attest":
          return await handleAttest(env, request, ipHash);
        case "/auth/status":
          return await handleStatus(env, request);
        default:
          return json(404, { error: "Not found" });
      }
    } catch (err) {
      console.error("auth-worker error:", err);
      return json(500, { error: "Internal error" });
    }
  },
};
