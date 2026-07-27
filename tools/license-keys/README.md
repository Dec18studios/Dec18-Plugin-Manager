# license-keys

Only **public** key material belongs in this directory (`public.pem`,
`public.b64`). Everything else is local-only and gitignored:

- `private.pem`, `gmail-credentials.json`, `gmail-token.json`,
  `download-logger-secret.txt`, `brevo-api-key.txt` — secrets, never committed.
- `processed-subscribers.json`, `ledger.json` — the fulfillment ledger
  (customer PII + issued license keys). As of 2026-07-27 this lives in the
  **private** repo [Dec18studios/license-ledger](https://github.com/Dec18studios/license-ledger),
  not here. CI checks that repo out via the `LEDGER_DEPLOY_KEY` secret; locally,
  clone it and `export LICENSE_LEDGER_DIR=/path/to/license-ledger` before
  running `fulfill-licenses.mjs`, `license-server.mjs`, `backfill-ledger.mjs`,
  `backfill-brevo-photochemist.mjs`, or `auth-worker/import-subscribers.mjs`.
