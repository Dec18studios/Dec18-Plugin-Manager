# Dec 18 Studios — Auth Worker (email OTP + account sync)

Passwordless sign-in for the Plugin Manager. Verifies that a user controls the
email tied to their purchase, then hands their license key(s) back to the app so
they install automatically — no copy-paste.

## How it fits the existing system

- License keys are unchanged: Ed25519-signed `D18.<payload>.<sig>` tokens whose
  payload is `{ t, e, p, exp? }` (tier, email, plugins, optional expiry).
- The **download-proxy** stays the download credential and now also enforces
  `exp` (expired keys get `403`).
- This worker adds the missing **stateful** piece: it checks the entitlement
  ledger, emails a code, verifies it, and logs verification events.
- Email reuses the same **Gmail API** sender as `tools/fulfill-licenses.mjs`.

## Endpoints

| Route | Body | Returns |
|-------|------|---------|
| `POST /auth/start`  | `{ email, deviceId? }` | `{ sent: true }` (always — see gating below) |
| `POST /auth/verify` | `{ email, code, deviceId? }` | `{ verified, email, keys, plugins, activeUntil, expired }` |
| `POST /auth/attest` | `{ key, deviceId? }` | `{ ok, email, keyExpired, keys, plugins, activeUntil, expired }` |
| `POST /auth/status` | `{ email }` or `{ key }` | `{ email, keys, plugins, activeUntil, expired, found }` |

**Gating / no enumeration:** `/auth/start` always responds `{ sent: true }`.
If the email has a purchase it gets a 6-digit code; if not, it gets a "no
purchase found" notice. The difference only ever reaches the inbox owner, so the
API leaks nothing. Rate-limited per IP (15/hr), per email (5/hr), with a 60s
resend cooldown. Codes are 6 digits, hashed at rest, expire in 10 min, max 5
attempts.

**Two verification methods, both logged** to `verification_events`:
`otp` (proved email) vs `silent_key` (holds a valid key — existing users).

## Locked-out sign-ins

`verification_events` only records *successes*, so until recently a request from
an address with no account was answered and then forgotten. A customer who
changed their email on Squarespace was therefore invisible to us until they
emailed support — which is exactly how the first one was found.

`/auth/start` now records those misses in `unknown_email_attempts` (one row per
address, counted — not append-only, so probing bumps a counter instead of
growing the table, and the per-IP/per-email rate limits run before the insert).
The write is best-effort and cannot change the response: `/auth/start` still
answers identically whether or not an account exists.

`check-unknown-emails.mjs` closes the loop against Squarespace. Two detectors,
both on the Commerce Orders API the fulfillment cron already has a key for — no
webhook subscription and no extra API scope:

- **drift** — re-reads every ledger `orderId` and compares Squarespace's
  *current* `customerEmail` to the address we filed it under. For a recurring
  subscription that field tracks the customer's current address, so this catches
  a change before anyone is locked out.
- **locked** — takes the `unknown_email_attempts` rows and joins them to a known
  customer through `customerId`, which survives an email change and is the same
  id as `Contact.id`.

Matching is only ever by order id or `customerId`, **never by name** — anyone can
create a Squarespace contact with a newsletter signup, so a name match would be a
route to claiming someone else's license.

```sh
export SQUARESPACE_API_KEY=…
export LICENSE_LEDGER_DIR=/path/to/license-ledger   # git pull it first

node check-unknown-emails.mjs              # report only, writes nothing
node check-unknown-emails.mjs --skip-d1    # drift only, no wrangler call
node check-unknown-emails.mjs --apply      # migrate the ledger + print the D1 upsert
```

`--apply` **adds** the new address and keeps the old one; it never renames or
deletes. Both must stay: `fulfill-licenses.mjs` dedupes on
`processed[customerEmail]`, so removing either re-triggers issuance, and the
key's signed `e` claim is still the old address, which the download proxy gates
on. Then commit the ledger repo and run the printed `wrangler` statement — the
ledger commit alone does not grant access, the D1 upsert is what does.

Emails are masked when `$CI` is set; pass `--reveal` to override.
Tests (no network, no credentials, no real ledger): `node test-check-unknown-emails.mjs`.

## One-time setup

```sh
cd tools/auth-worker

# 1. Create the D1 database, paste the printed id into wrangler.toml
wrangler d1 create dec18-auth

# 2. Create tables (local + remote)
wrangler d1 execute dec18-auth --local  --file=schema.sql
wrangler d1 execute dec18-auth --remote --file=schema.sql

# 3. Seed accounts from the existing subscriber ledger
node import-subscribers.mjs > seed.sql
wrangler d1 execute dec18-auth --local  --file=seed.sql
wrangler d1 execute dec18-auth --remote --file=seed.sql

# 4. Secrets (OTP_PEPPER + IP_HASH_SALT are just random strings)
wrangler secret put OTP_PEPPER
wrangler secret put IP_HASH_SALT
wrangler secret put GMAIL_CREDENTIALS   # same JSON as fulfillment
wrangler secret put GMAIL_TOKEN         # same JSON as fulfillment
```

## Local test (no Gmail needed)

Set `DEV_EXPOSE_CODE = "1"` in `wrangler.toml` `[vars]`, then:

```sh
wrangler dev   # serves http://localhost:8787

# A real customer email (one you imported in seed.sql):
curl -s localhost:8787/auth/start  -d '{"email":"nobody@example.com"}'
#   -> {"sent":true,"devCode":"418205"}   (devCode only in dev)

curl -s localhost:8787/auth/verify -d '{"email":"nobody@example.com","code":"418205"}'
#   -> {"verified":true,"email":"...","keys":["D18..."],"plugins":["*"],...}

# A non-customer email: still {"sent":true}, but the code path emails a notice
curl -s localhost:8787/auth/start  -d '{"email":"nobody@example.com"}'
#   -> {"sent":true}     (console logs the "no purchase" mail in dev)

# Existing key-holder, silent verify:
curl -s localhost:8787/auth/attest -d '{"key":"D18....","deviceId":"abc"}'
```

Inspect the analytics log:

```sh
wrangler d1 execute dec18-auth --local \
  --command "SELECT email, method, ts FROM verification_events ORDER BY ts DESC LIMIT 20;"
```

**Remove `DEV_EXPOSE_CODE` before deploying.**

## Deploy

```sh
wrangler deploy
```

## Next (app side — not yet built)

Tauri commands `start_email_verification` / `verify_otp` / `attest_license`
calling these endpoints, OS-keychain storage for the session, and a sign-in
screen. Old users hit `/auth/attest` silently on launch; new users get the
email + code screen.
