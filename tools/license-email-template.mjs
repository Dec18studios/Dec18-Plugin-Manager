/**
 * The purchase-fulfillment email — one source of truth.
 *
 * Imported by tools/fulfill-licenses.mjs (production, Brevo/Gmail), by
 * tools/license-server.mjs (the local license-manager UI's resend button) and
 * by tools/test-send-key.mjs (preview send). Before this module the copy lived
 * in three hand-maintained duplicates and had already drifted.
 *
 * What the email has to say, and why:
 *   1. Email sign-in is the way into the Plugin Manager now. The app asks for
 *      an address, mails a 6-digit code, and pulls the key down itself, so the
 *      key is no longer something the buyer has to handle.
 *   2. dec18studios.com/all-tools is the member page for grabbing installers by
 *      hand, for anyone who would rather not run the Manager at all.
 *
 * The licence key is deliberately NOT in here. Both routes above authenticate
 * off the buyer's email address, so the key would be a third credential nobody
 * needs, sitting in an inbox forever. Fulfillment still mints and records one;
 * if someone writes in stuck, the mail arriving from their purchase address is
 * the same proof the OTP would have asked for, and Greg has the key on file.
 *
 * House style matches tools/demo-welcome-email.mjs: 600px dark table layout,
 * Georgia headings, gold accents. No em dashes in body copy (Greg's rule).
 */

export const LICENSE_EMAIL_SUBJECT = "You're in. Here's how to get your tools";

const MANAGER_URL = "https://github.com/Dec18studios/Dec18-Plugin-Manager/releases/latest/";
const ALL_TOOLS_URL = "https://dec18studios.com/all-tools";
const ACCOUNT_URL = "https://dec18studios.com/account";

function escapeHTML(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Purchaser names come from Squarespace and can be a full name, a first name,
// or empty. Use the first word so the greeting reads naturally either way.
function greetingName(name) {
  const first = String(name ?? "").trim().split(/\s+/)[0];
  return first || "there";
}

/** Plain-text alternative. Sent alongside the HTML, never on its own. */
export function licenseEmailText({ name, email }) {
  return [
    `Hi ${greetingName(name)},`,
    "",
    "Thanks for joining. Everything in the Tool Box is yours, and there are two ways to get at it.",
    "",
    "1. THE PLUGIN MANAGER (easiest)",
    "",
    `Download it here: ${MANAGER_URL}`,
    "",
    "Open it and choose Sign In. Enter this email address:",
    "",
    `  ${email ?? "the address you purchased with"}`,
    "",
    "We mail you a 6-digit code, you type it in, and the Manager installs and updates",
    "every plugin for you. No key to copy, and it works on every machine you sign in on.",
    "",
    "2. DIRECT DOWNLOADS ON THE WEBSITE",
    "",
    `${ALL_TOOLS_URL}`,
    "",
    "Log in with the same email address and every tool is listed there to download by",
    "hand, if you would rather skip the Manager.",
    "",
    "Stuck on any of it, or the code never turns up, just reply to this email. It comes",
    "straight to me and I will get you in.",
    "",
    "Happy grading,",
    "Greg",
    "Dec. 18 Studios",
    "",
    `Manage your subscription: ${ACCOUNT_URL}`,
  ].join("\n");
}

/** The real email. */
export function licenseEmailHTML({ name, email }) {
  const hi = escapeHTML(greetingName(name));
  const addr = email ? escapeHTML(email) : "the address you purchased with";

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>${escapeHTML(LICENSE_EMAIL_SUBJECT)}</title>
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
  Sign in to the Plugin Manager with your email address and it installs everything for you, or grab the plugins by hand from the site.
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

        <!-- Hero card -->
        <tr>
          <td style="background-color:#1a1f26; border-radius:12px 12px 0 0; padding:40px 40px 8px 40px;" class="px">
            <h1 class="h1" style="margin:0 0 16px 0; font-family:Georgia, 'Times New Roman', serif; font-size:30px; line-height:38px; color:#f4f1ea; font-weight:normal;">
              You&rsquo;re in. Here&rsquo;s how to get your tools.
            </h1>
            <p style="margin:0 0 12px 0; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:24px; color:#c6ccd4;">
              Hi ${hi},
            </p>
            <p style="margin:0 0 12px 0; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:24px; color:#c6ccd4;">
              Thank you for joining. Every premium DCTL and OFX plugin in the Tool Box is yours now, along with a year of updates and new tools as they land. There are two ways to get at them, and you can use both.
            </p>
          </td>
        </tr>

        <!-- Step 1: Plugin Manager + OTP -->
        <tr>
          <td style="background-color:#1a1f26; padding:16px 40px 8px 40px;" class="px">
            <p style="margin:0 0 6px 0; font-family:Arial, Helvetica, sans-serif; font-size:11px; letter-spacing:2px; color:#d9a441; text-transform:uppercase;">Start Here</p>
            <h2 style="margin:0 0 12px 0; font-family:Georgia, 'Times New Roman', serif; font-size:22px; line-height:28px; color:#f4f1ea; font-weight:normal;">1. Sign in to the Plugin Manager</h2>
            <p style="margin:0 0 16px 0; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:24px; color:#c6ccd4;">
              The Manager installs and updates everything for you. Open it, choose <strong style="color:#f4f1ea;">Sign In</strong>, and enter this email address:
            </p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#22282f; border-radius:8px; margin:0 0 16px 0;">
              <tr>
                <td align="center" style="padding:16px 20px; font-family:'Courier New', Courier, monospace; font-size:15px; line-height:22px; color:#f4f1ea; word-break:break-all;">
                  ${addr}
                </td>
              </tr>
            </table>
            <p style="margin:0 0 20px 0; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:24px; color:#c6ccd4;">
              We mail you a <strong style="color:#f4f1ea;">6-digit code</strong>, you type it in, and you are done. No key to copy, nothing to keep track of, and it works on every machine you sign in on.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px 0;">
              <tr>
                <td align="center" bgcolor="#d9a441" style="border-radius:6px;">
                  <a href="${MANAGER_URL}" target="_blank" style="display:inline-block; padding:13px 28px; font-family:Arial, Helvetica, sans-serif; font-size:15px; font-weight:bold; color:#111418; text-decoration:none; border-radius:6px;">Download the Plugin Manager</a>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 12px 0; font-family:Arial, Helvetica, sans-serif; font-size:13px; line-height:20px; color:#8a9099;">
              macOS, Windows and Linux. Already have it? Just open it and sign in.
            </p>
          </td>
        </tr>

        <!-- Divider -->
        <tr>
          <td style="background-color:#1a1f26; padding:12px 40px;" class="px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="border-top:1px solid #2c333d; font-size:0; line-height:0;">&nbsp;</td></tr>
            </table>
          </td>
        </tr>

        <!-- Step 2: website direct downloads -->
        <tr>
          <td style="background-color:#1a1f26; padding:0 40px 8px 40px;" class="px">
            <p style="margin:0 0 6px 0; font-family:Arial, Helvetica, sans-serif; font-size:11px; letter-spacing:2px; color:#d9a441; text-transform:uppercase;">Or Do It By Hand</p>
            <h2 style="margin:0 0 12px 0; font-family:Georgia, 'Times New Roman', serif; font-size:22px; line-height:28px; color:#f4f1ea; font-weight:normal;">2. Direct downloads on the website</h2>
            <p style="margin:0 0 20px 0; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:24px; color:#c6ccd4;">
              Prefer to skip the Manager? Log in to the site with the same email address and the <strong style="color:#f4f1ea;">All Tools</strong> page lists every plugin, ready to download and install yourself.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px 0;">
              <tr>
                <td align="center" style="border:1px solid #d9a441; border-radius:6px;">
                  <a href="${ALL_TOOLS_URL}" target="_blank" style="display:inline-block; padding:12px 26px; font-family:Arial, Helvetica, sans-serif; font-size:15px; font-weight:bold; color:#d9a441; text-decoration:none; border-radius:6px;">Log in and browse All Tools</a>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 12px 0; font-family:Arial, Helvetica, sans-serif; font-size:13px; line-height:20px; color:#8a9099;">
              <a href="${ALL_TOOLS_URL}" target="_blank" style="color:#8a9099; text-decoration:underline;">${ALL_TOOLS_URL.replace("https://", "")}</a>
            </p>
          </td>
        </tr>

        <!-- Help block -->
        <tr>
          <td style="background-color:#1a1f26; padding:16px 40px 8px 40px;" class="px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#22282f; border-radius:8px;">
              <tr>
                <td style="padding:24px 28px;">
                  <h3 style="margin:0 0 8px 0; font-family:Georgia, 'Times New Roman', serif; font-size:18px; line-height:24px; color:#f4f1ea; font-weight:normal;">Stuck? Just reply.</h3>
                  <p style="margin:0; font-family:Arial, Helvetica, sans-serif; font-size:14px; line-height:22px; color:#c6ccd4;">
                    If the code does not arrive, a plugin will not load, or you just want a hand getting set up, hit reply. It goes straight to me, not a ticket system, and I will get you in.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Sign-off -->
        <tr>
          <td style="background-color:#1a1f26; padding:24px 40px 40px 40px; border-radius:0 0 12px 12px;" class="px">
            <p style="margin:0; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:24px; color:#c6ccd4;">
              Happy grading,<br>
              <span style="color:#f4f1ea;">Greg</span><br>
              <span style="font-size:13px; color:#8a9099;">Dec. 18 Studios</span>
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td align="center" style="padding:28px 40px 8px 40px;" class="px">
            <p style="margin:0 0 8px 0; font-family:Arial, Helvetica, sans-serif; font-size:12px; line-height:18px; color:#6b727c;">
              Dec. 18 Studios &bull; <a href="https://dec18studios.com" style="color:#8a9099; text-decoration:underline;">dec18studios.com</a>
            </p>
            <p style="margin:0 0 8px 0; font-family:Arial, Helvetica, sans-serif; font-size:12px; line-height:18px; color:#6b727c;">
              You&rsquo;re receiving this because you purchased access to the Dec. 18 Studios Tool Box.
            </p>
            <p style="margin:0; font-family:Arial, Helvetica, sans-serif; font-size:12px; line-height:18px; color:#6b727c;">
              <a href="${ACCOUNT_URL}" style="color:#8a9099; text-decoration:underline;">Manage your subscription</a>
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
