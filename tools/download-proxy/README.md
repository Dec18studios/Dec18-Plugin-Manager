# Download Proxy

Cloudflare Worker that gates paid plugin downloads. It verifies the caller's
D18 licence token, then streams the GitHub release asset back using a stored PAT.

**This worker is the only server-side gate on paid downloads.** The 6-digit OTP
flow replaced *typing* a licence key, not the key's authority: `/auth/verify`
hands the account's D18 keys back to the app, and the app sends them here as a
Bearer token. Every per-key control — revocation, entitlement, rate limiting —
has to live here, because there is nowhere else it can be enforced.

## Gates, in order

Cheapest first: signature checks are free, D1 queries are not.

| # | Gate | Denies when |
|---|------|-------------|
| 1 | Ed25519 signature | token isn't `D18.<payload>.<sig>` signed by our key |
| 2 | `exp` | subscription lapsed (perpetual keys omit `exp`) |
| 3 | Entitlement | `payload.p` doesn't cover the requested repo |
| 4 | Denylist | SHA-256 of the key is in `key_denylist` |
| 5 | Account | key's email is missing from D1 `accounts`, or past `active_until` |
| 6 | Rate limit | more than `RATE_LIMIT_DOWNLOADS` in `RATE_LIMIT_WINDOW_S` |

Every gated request is written to `download_events` — the key's **hash**, never
the key.

### On the entitlement gate

`fulfill-licenses.mjs` sets `p = (tier === "master" || tier === "annual") ? ["*"] : [tier]`,
and every key issued so far is master or annual. So all of them carry `["*"]`
and sail straight through gate 3. It is not doing much today. It exists to stop
a free/limited key reaching paid assets, and to make single-tool tiers
enforceable the day one is sold. **Don't mistake it for a working per-plugin
gate on existing keys.** To actually cut off a specific key, use the denylist.

Tier names and repo names don't match (`photochemist` vs `PhotoChemist-OFX`),
so matching is on alphanumerics with prefix tolerance in both directions.

## Revoking a key

The denylist takes effect on the next request. No deploy, no app update, and no
need to re-issue anyone else's key.

```bash
export LICENSE_LEDGER_DIR="/path/to/license-ledger"   # private repo clone
node denylist.mjs add-email someone@example.com --reason refunded
node denylist.mjs list
node denylist.mjs report --hours 24
```

`report` is the abuse view: one key with many distinct IP hashes and countries
is a shared or leaked key.

Only the SHA-256 is stored. The denylist must not become a second copy of the
credentials it exists to contain, so a key cannot be read back out of it.

## Download grants (`/v1/grant`)

A browser download is a top-level navigation and cannot send an `Authorization`
header, which is why the raw licence key used to ride along in `?token=` —
landing in browser history, referrer headers, and any shared link. A key in a
URL is a live credential for the entire catalogue.

Instead the page fetches a grant over XHR (which *can* set headers) and
navigates to the returned URL:

```
GET /v1/grant?repo=PhotoChemist-OFX&tag=v3.0-beta.9&asset=*
    X-License-Token: D18.…
 -> { "url": "…/releases/download/…?g=<hmac blob>", "expires_at": …, "expires_in": 300 }
```

The grant is bound to one repo+tag+asset and expires in `GRANT_TTL_S`. Leaking
one leaks a single download of a single file for a few minutes. The denylist is
still checked at redemption, so revoking a key also kills its outstanding grants.

Deliberately **not** single-use: that would need a D1 write per download and
would break on the range and retry requests browsers issue mid-download. Tight
binding plus a short TTL is the better trade.

### Retiring `?token=`

`ALLOW_TOKEN_QUERY = "1"` keeps the legacy query-param path alive. Turn it off
once the members page is deployed on grants:

1. Deploy this worker (grants live, `?token=` still accepted).
2. Deploy `dec18studios.github.io` — the members page prefers `/v1/grant` and
   falls back to `?token=` only on 400/404/5xx, so the order doesn't matter.
3. Confirm `node denylist.mjs report` shows downloads flowing.
4. Set `ALLOW_TOKEN_QUERY = "0"` and redeploy. Existing `?token=` links stop working.

The Tauri app is unaffected throughout — it has always used the header.

## Failure behaviour

A definite "no" from a healthy database always denies. An *error* reaching the
database is different: by default it **fails open**, because a D1 blip must not
stop paying customers from downloading. Set `STRICT_DB = "1"` to fail closed.
With no `DB` binding at all, the D1-backed gates are skipped entirely and the
worker behaves as it did before this pass.

Each gate can also be switched to log-only via `ENFORCE_*` in `wrangler.toml`.
Denials are logged either way, so you can watch `download_events` before
tightening anything.

## Deploy

```bash
./deploy.sh
```

Applies `schema.sql` to the `dec18-auth` D1 database, deploys the worker, and
prompts for `GITHUB_PAT`, `GRANT_SECRET`, and `IP_HASH_SALT`.

## Tests

```bash
node test-worker.mjs
```

32 cases: signature/expiry/entitlement/denylist/account/rate-limit gates, grant
issue-bind-expire-tamper, D1 fail-open vs fail-closed, and the
`ALLOW_TOKEN_QUERY=0` cutover. Throwaway keypair, stubbed D1 and GitHub — no
secrets and no network.
