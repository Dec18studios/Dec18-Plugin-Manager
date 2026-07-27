#!/bin/bash
# First-time setup:
#   1. wrangler d1 create dec18-downloads
#      → copy the database_id into wrangler.toml
#   2. wrangler d1 execute dec18-downloads --remote --file=schema.sql
#   3. wrangler secret put ADMIN_SECRET        (pick any strong password)
#   4. wrangler secret put GMAIL_CLIENT_ID
#   5. wrangler secret put GMAIL_CLIENT_SECRET
#   6. wrangler secret put GMAIL_REFRESH_TOKEN
#   7. wrangler secret put GMAIL_FROM          (e.g. create@dec18studios.com)
#   8. ./deploy.sh

set -e
cd "$(dirname "$0")"
echo "Deploying dec18-download-logger..."
wrangler deploy
echo "Done."
