#!/bin/bash
# Deploy the Dec 18 Studios download proxy to Cloudflare Workers.
#
# Prerequisites:
#   1. Cloudflare account (free tier is fine — 100k requests/day)
#   2. npm install -g wrangler
#   3. wrangler login
#
# This script deploys the worker and sets up the GITHUB_PAT secret.
# Run it once from this directory.

set -euo pipefail
cd "$(dirname "$0")"

echo "=== Dec 18 Studios Download Proxy Setup ==="
echo ""

# Check wrangler is installed
if ! command -v wrangler &>/dev/null; then
  echo "Installing wrangler..."
  npm install -g wrangler
fi

# Check login
echo "Checking Cloudflare authentication..."
if ! wrangler whoami 2>/dev/null | grep -q "Account"; then
  echo "Please log in to Cloudflare:"
  wrangler login
fi

# Apply the proxy's D1 tables (key_denylist, download_events). They live in the
# SAME database as the auth worker, because the proxy reads its `accounts`
# table. Idempotent — everything is IF NOT EXISTS.
echo ""
echo "Applying D1 schema to dec18-auth..."
wrangler d1 execute dec18-auth --remote --file=schema.sql

# Deploy the worker
echo ""
echo "Deploying worker..."
wrangler deploy

# Set the GitHub PAT secret
echo ""
echo "Now set the GITHUB_PAT secret."
echo "This should be a Fine-grained PAT with Contents:read on your plugin repos."
echo ""
wrangler secret put GITHUB_PAT

# Secrets added with the licence-hardening pass. Skip either one if it is
# already set — `wrangler secret list` will tell you.
echo ""
echo "GRANT_SECRET — HMAC key for short-lived download links."
echo "Paste 32+ random bytes, e.g. from:  openssl rand -base64 48"
echo "(Rotating this only invalidates in-flight download links.)"
echo ""
wrangler secret put GRANT_SECRET

echo ""
echo "IP_HASH_SALT — salts client IPs before they are written to the download log,"
echo "so abuse is still detectable without retaining personal data."
echo "Paste any random string:  openssl rand -base64 24"
echo ""
wrangler secret put IP_HASH_SALT

echo ""
echo "=== Done! ==="
echo ""
echo "Your proxy is live at: https://dec18-download-proxy.<your-subdomain>.workers.dev"
echo ""
echo "Next steps:"
echo "  1. Copy the worker URL"
echo "  2. In your Dec18-Plugin-Manager repo on GitHub:"
echo "     Settings → Secrets and variables → Actions → Variables tab"
echo "     Add variable: DOWNLOAD_PROXY_URL = https://dec18-download-proxy.<subdomain>.workers.dev"
echo "  3. Also add the secret: PLUGIN_REPOS_PAT (same PAT you just used)"
echo "  4. Trigger a workflow run to regenerate manifests with proxy URLs"
