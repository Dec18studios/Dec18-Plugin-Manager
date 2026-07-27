// dec18-download-logger — Cloudflare Worker
// Routes:
//   POST /log              — log a download event (public, called from tools page)
//   GET  /export           — download full CSV  (requires ?secret=ADMIN_SECRET)
//   POST /notify           — send release email to subscribers (requires secret in body)
//   GET  /unsubscribe      — opt-out link (?email=&tool=&secret= — secret is a per-row hash)

const CORS_HEADERS = (origin, env) => ({
  'Access-Control-Allow-Origin': (origin === env.ALLOWED_ORIGIN || origin === 'http://localhost:3077') ? origin : env.ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
});

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}

function now() {
  return new Date().toISOString();
}

// Simple per-row unsubscribe token so we don't need sessions
async function unsubToken(email, tool, env) {
  const msg = `unsub:${email}:${tool}:${env.ADMIN_SECRET}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = CORS_HEADERS(origin, env);

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // ── POST /log ──────────────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/log') {
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400, cors); }

      const email = (body.email || '').trim().toLowerCase();
      const slug  = (body.tool_slug  || '').trim();
      const name  = (body.tool_name  || slug).trim();
      const ts    = now();

      if (!email || !slug) return json({ ok: false, error: 'email and tool_slug required' }, 400, cors);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: 'invalid email' }, 400, cors);

      await env.DB.prepare(`
        INSERT INTO downloads (email, tool_slug, tool_name, first_downloaded, last_downloaded, download_count)
        VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT(email, tool_slug) DO UPDATE SET
          last_downloaded = excluded.last_downloaded,
          download_count  = download_count + 1,
          unsubscribed    = 0
      `).bind(email, slug, name, ts, ts).run();

      return json({ ok: true }, 200, cors);
    }

    // ── GET /export ────────────────────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/export') {
      if (url.searchParams.get('secret') !== env.ADMIN_SECRET) {
        return new Response('Forbidden', { status: 403 });
      }
      const { results } = await env.DB.prepare(`
        SELECT email, tool_slug, tool_name, first_downloaded, last_downloaded, download_count, unsubscribed
        FROM downloads ORDER BY last_downloaded DESC
      `).all();

      const header = 'email,tool_slug,tool_name,first_downloaded,last_downloaded,download_count,unsubscribed\n';
      const rows = results.map(r =>
        [r.email, r.tool_slug, r.tool_name, r.first_downloaded, r.last_downloaded, r.download_count, r.unsubscribed]
          .map(v => `"${String(v).replace(/"/g, '""')}"`)
          .join(',')
      ).join('\n');

      return new Response(header + rows, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="dec18-downloads-${now().slice(0,10)}.csv"`,
        },
      });
    }

    // ── POST /notify ───────────────────────────────────────────────────────────
    // Body: { secret, tool_slug, tool_name, version, download_url, message? }
    if (request.method === 'POST' && url.pathname === '/notify') {
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
      if (body.secret !== env.ADMIN_SECRET) return json({ ok: false, error: 'forbidden' }, 403);

      const { tool_slug, tool_name, version, download_url, message } = body;
      if (!tool_slug || !version || !download_url) {
        return json({ ok: false, error: 'tool_slug, version, and download_url required' }, 400);
      }

      const { results } = await env.DB.prepare(`
        SELECT email FROM downloads
        WHERE tool_slug = ? AND unsubscribed = 0
      `).bind(tool_slug).all();

      if (!results.length) return json({ ok: true, sent: 0, message: 'No subscribers' });

      // Get a fresh Gmail access token from the stored refresh token
      const accessToken = await getGmailAccessToken(env);
      if (!accessToken) return json({ ok: false, error: 'Could not refresh Gmail token' }, 500);

      let sent = 0, failed = 0;

      for (const row of results) {
        const token = await unsubToken(row.email, tool_slug, env);
        const unsubUrl = `https://dec18-download-logger.dec18studios.workers.dev/unsubscribe?email=${encodeURIComponent(row.email)}&tool=${encodeURIComponent(tool_slug)}&token=${token}`;

        const html = emailHTML({ tool_name: tool_name || tool_slug, version, download_url, message, unsubUrl });
        const subject = `${tool_name || tool_slug} — v${version} is out`;

        const ok = await sendGmail({ accessToken, to: row.email, subject, html, env });
        if (ok) sent++; else failed++;
      }

      return json({ ok: true, sent, failed, total: results.length });
    }

    // ── GET /unsubscribe ───────────────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/unsubscribe') {
      const email = (url.searchParams.get('email') || '').trim().toLowerCase();
      const tool  = (url.searchParams.get('tool')  || '').trim();
      const token = url.searchParams.get('token') || '';

      const expected = await unsubToken(email, tool, env);
      if (!email || !tool || token !== expected) {
        return new Response(unsubPage('Invalid or expired unsubscribe link.', false), {
          headers: { 'Content-Type': 'text/html' },
        });
      }

      await env.DB.prepare(`
        UPDATE downloads SET unsubscribed = 1 WHERE email = ? AND tool_slug = ?
      `).bind(email, tool).run();

      return new Response(unsubPage(`You've been unsubscribed from updates for ${tool}. You won't hear from us again for this tool.`, true), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};

// ── Gmail sending ─────────────────────────────────────────────────────────────

async function getGmailAccessToken(env) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.access_token || null;
}

async function sendGmail({ accessToken, to, subject, html, env }) {
  const from = env.GMAIL_FROM || 'create@dec18studios.com';
  // Build RFC 2822 message
  const mime = [
    `From: Dec 18 Studios <${from}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
  ].join('\r\n');

  // base64url encode
  const encoded = btoa(unescape(encodeURIComponent(mime)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: encoded }),
  });
  return res.ok;
}

// ── Email HTML template ────────────────────────────────────────────────────────
function emailHTML({ tool_name, version, download_url, message, unsubUrl }) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f1116;font-family:system-ui,-apple-system,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1116;padding:40px 20px">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">
  <tr><td style="padding-bottom:28px">
    <span style="font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#4a8aff">Dec 18 Studios</span>
  </td></tr>
  <tr><td style="background:#13151c;border:1px solid #2a2d3a;border-radius:12px;padding:36px 32px">
    <p style="margin:0 0 6px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#888;font-weight:600">New release</p>
    <h1 style="margin:0 0 8px;font-size:26px;font-weight:700;color:#e8eaf0;line-height:1.25">${esc(tool_name)}</h1>
    <p style="margin:0 0 28px;font-size:15px;color:#4a8aff;font-weight:600">v${esc(version)} is available</p>
    ${message ? `<p style="margin:0 0 28px;font-size:15px;color:#cfd2d8;line-height:1.65">${esc(message)}</p>` : ''}
    <a href="${download_url}" style="display:inline-block;background:#4a8aff;color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:13px 28px;border-radius:8px;letter-spacing:.01em">Download v${esc(version)} →</a>
    <p style="margin:28px 0 0;font-size:12px;color:#555;line-height:1.6">
      You downloaded ${esc(tool_name)} from <a href="https://tools.dec18studios.com" style="color:#555">tools.dec18studios.com</a> and asked to be notified of updates. We don't send many of these.<br><br>
      <a href="${unsubUrl}" style="color:#555">Unsubscribe from ${esc(tool_name)} updates</a>
    </p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unsubPage(msg, success) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Unsubscribe</title>
<style>body{background:#0f1116;color:#cfd2d8;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#13151c;border:1px solid #2a2d3a;border-radius:12px;padding:40px;max-width:420px;text-align:center}
h2{color:${success ? '#2ac77b' : '#e04040'};margin:0 0 12px}p{color:#888;font-size:14px;line-height:1.6}
a{color:#4a8aff}</style></head>
<body><div class="card"><h2>${success ? 'Unsubscribed' : 'Error'}</h2><p>${msg}</p>
<p><a href="https://tools.dec18studios.com">Back to tools</a></p></div></body></html>`;
}
