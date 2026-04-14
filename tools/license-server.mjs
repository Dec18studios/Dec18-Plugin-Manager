#!/usr/bin/env node
/**
 * License Manager — local server.
 *
 * Usage:   node tools/license-server.mjs
 *
 * Reads/writes ledger.json + processed-subscribers.json in tools/license-keys/.
 * Signs new keys with private.pem (Ed25519).  Auto-opens the browser.
 */

import { createServer } from "node:http";
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = join(__dirname, "license-keys");
const LEDGER_PATH = join(KEYS_DIR, "ledger.json");
const SUBS_PATH = join(KEYS_DIR, "processed-subscribers.json");
const PEM_PATH = join(KEYS_DIR, "private.pem");
const HTML_PATH = join(__dirname, "license-manager.html");
const GMAIL_CREDS_PATH = join(KEYS_DIR, "gmail-credentials.json");
const GMAIL_TOKEN_PATH = join(KEYS_DIR, "gmail-token.json");

const PORT = parseInt(process.env.PORT || "9218", 10);

// ── Plugin catalog paths ───────────────────────────────────────────
const REPO_ROOT    = join(__dirname, "..");
const PLUGINS_DIR  = join(REPO_ROOT, "docs", "plugins");
const INDEX_PATH   = join(PLUGINS_DIR, "index.json");
const WORKFLOW_YML = join(REPO_ROOT, ".github", "workflows", "deploy-plugin-manager-pages.yml");

// ── Helpers ────────────────────────────────────────────────────────

function loadJSON(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function base64urlEncode(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateMasterKey(privateKey, tier, email, plugins, exp) {
  const payload = { t: tier, e: email, p: plugins };
  if (exp) payload.exp = exp;
  const json = JSON.stringify(payload);
  const payloadB64 = base64urlEncode(Buffer.from(json, "utf8"));
  const signature = sign(null, Buffer.from(payloadB64, "utf8"), privateKey);
  return `D18.${payloadB64}.${base64urlEncode(signature)}`;
}

/** Calculate unix-seconds expiration timestamp for a tier, or null for permanent. */
function expirationForTier(tier) {
  const now = Math.floor(Date.now() / 1000);
  if (tier === "free")   return now + 30 * 86400;   // 30 days
  if (tier === "annual") return now + 365 * 86400;   // 1 year
  return null; // master / permanent
}

let privateKey = null;
if (existsSync(PEM_PATH)) {
  privateKey = createPrivateKey(readFileSync(PEM_PATH, "utf8"));
}

// ── HTTP server ────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1e6) { reject(new Error("Body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, status, body) {
  const str = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(str),
  });
  res.end(str);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── Serve the HTML UI ──
  if (url.pathname === "/" && req.method === "GET") {
    const html = readFileSync(HTML_PATH, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // ── GET /api/data — load everything ──
  if (url.pathname === "/api/data" && req.method === "GET") {
    const ledger = loadJSON(LEDGER_PATH, []);
    const subscribers = loadJSON(SUBS_PATH, {});
    json(res, 200, {
      ledger,
      subscribers,
      hasPrivateKey: !!privateKey,
    });
    return;
  }

  // ── POST /api/generate-key — issue a new key ──
  if (url.pathname === "/api/generate-key" && req.method === "POST") {
    if (!privateKey) {
      json(res, 400, { error: "No private.pem found in license-keys/" });
      return;
    }
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { json(res, 400, { error: "Invalid JSON" }); return; }

    const { name, email, tier } = body;
    if (!email || !email.includes("@")) {
      json(res, 400, { error: "Valid email required" });
      return;
    }
    const safeTier = typeof tier === "string" && tier ? tier : "master";
    const plugins = (safeTier === "master" || safeTier === "annual") ? ["*"] : [safeTier];
    const exp = expirationForTier(safeTier);
    const key = generateMasterKey(privateKey, safeTier, email.toLowerCase(), plugins, exp);
    const now = new Date().toISOString();

    // Append to ledger and save
    const ledger = loadJSON(LEDGER_PATH, []);
    const entry = { name: name || "", tier: safeTier, email: email.toLowerCase(), plugins, key, generatedAt: now };
    if (exp) entry.expiresAt = new Date(exp * 1000).toISOString();
    ledger.push(entry);
    saveJSON(LEDGER_PATH, ledger);

    json(res, 200, { key, entry });
    return;
  }

  // ── POST /api/update-entry — update name/email on a ledger entry by index ──
  if (url.pathname === "/api/update-entry" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { json(res, 400, { error: "Invalid JSON" }); return; }

    const { index, name, email } = body;
    const ledger = loadJSON(LEDGER_PATH, []);
    if (typeof index !== "number" || index < 0 || index >= ledger.length) {
      json(res, 400, { error: "Invalid index" }); return;
    }

    const entry = ledger[index];
    const changed = {};
    if (typeof name === "string") { entry.name = name; changed.name = name; }
    if (typeof email === "string" && email.includes("@")) {
      const oldEmail = entry.email;
      entry.email = email.toLowerCase();
      changed.email = entry.email;
      // If email changed and key exists, regenerate key with new email
      if (privateKey && oldEmail !== entry.email && entry.key && entry.key.startsWith("D18.")) {
        const tier = entry.tier || "master";
        const plugins = entry.plugins || ((tier === "master" || tier === "annual") ? ["*"] : [tier]);
        const exp = entry.expiresAt ? Math.floor(new Date(entry.expiresAt).getTime() / 1000) : expirationForTier(tier);
        entry.key = generateMasterKey(privateKey, tier, entry.email, plugins, exp);
        changed.key = entry.key;
      }
    }

    saveJSON(LEDGER_PATH, ledger);
    json(res, 200, { ok: true, entry, changed });
    return;
  }

  // ── POST /api/send-key-email — send a license key via Gmail API ──
  if (url.pathname === "/api/send-key-email" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { json(res, 400, { error: "Invalid JSON" }); return; }

    const { email, name, key } = body;
    if (!email || !key) { json(res, 400, { error: "email and key required" }); return; }

    // Load Gmail credentials from local files
    if (!existsSync(GMAIL_CREDS_PATH) || !existsSync(GMAIL_TOKEN_PATH)) {
      json(res, 400, { error: "Gmail credentials not found. Place gmail-credentials.json and gmail-token.json in tools/license-keys/" });
      return;
    }

    try {
      const credentials = JSON.parse(readFileSync(GMAIL_CREDS_PATH, "utf8"));
      const token = JSON.parse(readFileSync(GMAIL_TOKEN_PATH, "utf8"));

      // Refresh access token
      const creds = credentials.installed ?? credentials.web ?? credentials;
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: creds.client_id,
          client_secret: creds.client_secret,
          refresh_token: token.refresh_token,
          grant_type: "refresh_token",
        }),
      });
      if (!tokenRes.ok) throw new Error(`Token refresh failed: ${await tokenRes.text()}`);
      const { access_token } = await tokenRes.json();

      // Build email
      const displayName = name || "there";
      const subject = "Your Dec 18 Studios License Key";
      const emailBody = [
        `Hi ${displayName},`,
        "",
        "Thanks for your purchase! Here's your Dec 18 Studios license key:",
        "",
        key,
        "",
        "Paste this key into the Dec 18 Studios Plugin Manager to unlock all plugins.",
        "",
        "If you haven't downloaded the Plugin Manager yet, grab it from:",
        "https://github.com/Dec18studios/Dec18-Plugin-Manager/releases/latest/",
        "",
        "Cheers,",
        "Greg \u2014 Dec 18 Studios",
      ].join("\n");

      const raw = [
        `From: Dec 18 Studios <create@dec18studios.com>`,
        `To: ${email}`,
        `Subject: ${subject}`,
        "Content-Type: text/plain; charset=UTF-8",
        "",
        emailBody,
      ].join("\r\n");

      const rawBase64 = Buffer.from(raw).toString("base64url");

      // Send via Gmail API
      const sendRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw: rawBase64 }),
      });
      if (!sendRes.ok) throw new Error(`Gmail send failed: ${await sendRes.text()}`);
      const result = await sendRes.json();
      json(res, 200, { ok: true, messageId: result.id });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return;
  }

  // ── GET /api/email-status — check if Gmail creds are available ──
  if (url.pathname === "/api/email-status" && req.method === "GET") {
    json(res, 200, { hasGmailCreds: existsSync(GMAIL_CREDS_PATH) && existsSync(GMAIL_TOKEN_PATH) });
    return;
  }

  // ── POST /api/save-ledger — overwrite ledger with provided data ──
  if (url.pathname === "/api/save-ledger" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { json(res, 400, { error: "Invalid JSON" }); return; }

    if (!Array.isArray(body)) {
      json(res, 400, { error: "Expected array" });
      return;
    }
    saveJSON(LEDGER_PATH, body);
    json(res, 200, { ok: true });
    return;
  }

  // ── GET /api/plugins — list all plugins with live metadata ──
  if (url.pathname === "/api/plugins" && req.method === "GET") {
    const index = loadJSON(INDEX_PATH, { plugins: [] });
    const plugins = (index.plugins ?? []).map((p) => {
      const stablePath = join(PLUGINS_DIR, p.pluginId, "stable.json");
      const configPath = join(PLUGINS_DIR, p.pluginId, "manager-release-config.json");
      const stable = loadJSON(stablePath, null);
      const config = loadJSON(configPath, null);
      return {
        ...p,
        description: config?.description ?? null,
        releaseRepo:  config?.releaseRepo  ?? null,
        version:      stable?.version      ?? null,
        releaseDate:  stable?.releaseDate  ?? null,
        hasRelease:   !!stable,
        hasConfig:    !!config,
      };
    });
    // Also flag any pluginId dirs that exist locally but aren't in index
    const knownIds = new Set(plugins.map((p) => p.pluginId));
    try {
      for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const id = entry.name.toLowerCase();
        if (knownIds.has(id) || knownIds.has(entry.name)) continue;
        const configPath = join(PLUGINS_DIR, entry.name, "manager-release-config.json");
        const config = loadJSON(configPath, null);
        if (config) {
          plugins.push({
            pluginId: config.pluginId ?? entry.name,
            displayName: config.displayName ?? entry.name,
            type: null,
            licenseTier: null,
            manifestUrl: null,
            category: config.category ?? null,
            description: config.description ?? null,
            releaseRepo: config.releaseRepo ?? null,
            version: null,
            releaseDate: null,
            hasRelease: false,
            hasConfig: true,
            unlisted: true,
          });
        }
      }
    } catch {}
    json(res, 200, { plugins });
    return;
  }

  // ── POST /api/plugins/update-meta — edit tier or category ──
  if (url.pathname === "/api/plugins/update-meta" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { json(res, 400, { error: "Invalid JSON" }); return; }

    const { pluginId, licenseTier, category } = body;
    if (!pluginId) { json(res, 400, { error: "pluginId required" }); return; }

    // Update index.json
    const index = loadJSON(INDEX_PATH, { plugins: [] });
    const plugin = (index.plugins ?? []).find((p) => p.pluginId === pluginId);
    if (!plugin) { json(res, 404, { error: "Plugin not found in index" }); return; }
    if (typeof licenseTier === "string") plugin.licenseTier = licenseTier;
    if (typeof category   === "string") plugin.category    = category;
    saveJSON(INDEX_PATH, index);

    // Mirror to local manager-release-config.json if present
    const configPath = join(PLUGINS_DIR, pluginId, "manager-release-config.json");
    if (existsSync(configPath)) {
      const config = loadJSON(configPath, {});
      if (typeof category === "string") config.category = category;
      saveJSON(configPath, config);
    }

    json(res, 200, { ok: true, plugin });
    return;
  }

  // ── POST /api/plugins/add — scaffold a new plugin ──
  if (url.pathname === "/api/plugins/add" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { json(res, 400, { error: "Invalid JSON" }); return; }

    const { displayName, pluginId, type, category, description, licenseTier, repoName,
            assetPattern, bundleName, createRepo } = body;
    if (!displayName || !pluginId || !type) {
      json(res, 400, { error: "displayName, pluginId, and type are required" }); return;
    }

    const safeRepo    = repoName  || pluginId;
    const safeTier    = licenseTier || "subscription";
    const safePattern = assetPattern || `${displayName.replace(/\s+/g, ".")}.*\\.zip$`;
    const safeBundle  = bundleName  || (type === "DCTL" ? `${displayName}.dctle` : `${displayName}.ofx.bundle`);
    const bundleId    = `com.dec18studios.${pluginId}`;

    let assetRules;
    if (type === "DCTL") {
      const rule = (platform, installPath) => ({
        family: "universal", platform, arch: "universal",
        assetPattern: safePattern, packageType: "zip",
        bundleName: safeBundle, bundleIdentifier: bundleId,
        installPath, installMode: "file-browse",
      });
      assetRules = [
        rule("macos",   "/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT/DCTL"),
        rule("windows", "C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\LUT\\DCTL"),
        rule("linux",   "/opt/resolve/LUT/DCTL"),
      ];
    } else {
      const ext = type === "App" ? ".tar.gz" : ".ofx.bundle";
      assetRules = [
        { family:"macos",   platform:"macos",   arch:"universal", assetPattern:`${displayName.replace(/\s/g,"")}.*macOS.*universal.*\\.zip$`,        packageType:"zip",    bundleName:safeBundle, bundleIdentifier:bundleId, installPath:"/Library/OFX/Plugins" },
        { family:"windows", platform:"windows", arch:"x86_64",    assetPattern:`${displayName.replace(/\s/g,"")}.*[Ww]indows.*x86_64.*\\.zip$`,      packageType:"zip",    bundleName:safeBundle, bundleIdentifier:bundleId, installPath:"C:\\Program Files\\Common Files\\OFX\\Plugins" },
        { family:"linux",   platform:"linux",   arch:"x86_64",    assetPattern:`${displayName.replace(/\s/g,"")}.*linux.*x86_64.*\\.tar\\.gz$`,      packageType:"tar.gz", bundleName:safeBundle, bundleIdentifier:bundleId, installPath:"/usr/OFX/Plugins" },
      ];
    }

    const config = {
      pluginId, displayName,
      releaseRepo: `dec18studios/${safeRepo}`,
      minManagerVersion: "0.1.0",
      hostProcesses: type === "DCTL"
        ? ["Resolve", "DaVinci Resolve"]
        : ["Resolve", "DaVinci Resolve", "Fusion", "Fusion Studio"],
      requiredFamilies: type === "DCTL" ? ["universal"] : ["macos", "windows", "linux"],
      category: category || "Uncategorized",
      description: description || "",
      tags: [],
      assetRules,
    };

    // Write local plugin dir + config
    const pluginDir = join(PLUGINS_DIR, pluginId);
    mkdirSync(pluginDir, { recursive: true });
    saveJSON(join(pluginDir, "manager-release-config.json"), config);

    // Add to index.json (skip if already present)
    const index = loadJSON(INDEX_PATH, { generatedAt: new Date().toISOString(), plugins: [] });
    if (!index.plugins) index.plugins = [];
    const alreadyInIndex = index.plugins.some((p) => p.pluginId === pluginId);
    if (!alreadyInIndex) {
      index.plugins.push({
        pluginId, displayName, type,
        licenseTier: safeTier,
        manifestUrl: `https://dec18studios.github.io/Dec18-Plugin-Manager/plugins/${pluginId}/stable.json`,
        category: category || "Uncategorized",
      });
      saveJSON(INDEX_PATH, index);
    }

    // Patch PLUGINS array in workflow YAML
    const alreadyInWorkflow = (() => {
      try { return readFileSync(WORKFLOW_YML, "utf8").includes(`"${pluginId}"`); } catch { return false; }
    })();
    let workflowPatched = false;
    if (!alreadyInWorkflow) {
      try {
        const yaml = readFileSync(WORKFLOW_YML, "utf8");
        const newEntry = `            "${safeRepo}|${pluginId}"`;
        const patched = yaml.replace(
          /(          PLUGINS=\([\s\S]*?)(\n          \))/,
          `$1\n${newEntry}$2`
        );
        if (patched !== yaml) {
          writeFileSync(WORKFLOW_YML, patched, "utf8");
          workflowPatched = true;
        }
      } catch (err) {
        console.error("Workflow patch failed:", err.message);
      }
    }

    // Optionally create GitHub repo
    let repoCreated = false;
    let repoError   = null;
    if (createRepo) {
      try {
        execSync(
          `gh repo create Dec18studios/${safeRepo} --private --description ${JSON.stringify(description || displayName)}`,
          { cwd: REPO_ROOT, stdio: "pipe" }
        );
        repoCreated = true;
      } catch (err) {
        repoError = err.stderr?.toString().trim() || err.message;
      }
    }

    json(res, 200, { ok: true, pluginId, config, alreadyInIndex, workflowPatched, repoCreated, repoError });
    return;
  }

  // ── POST /api/plugins/rebuild — trigger GH Actions deploy ──
  if (url.pathname === "/api/plugins/rebuild" && req.method === "POST") {
    try {
      execSync("gh workflow run deploy-plugin-manager-pages.yml", { cwd: REPO_ROOT, stdio: "pipe" });
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 500, { error: err.stderr?.toString().trim() || err.message });
    }
    return;
  }

  // ── POST /api/plugins/inject-workflow — push a build workflow template to a plugin repo ──
  if (url.pathname === "/api/plugins/inject-workflow" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { json(res, 400, { error: "Invalid JSON" }); return; }

    const { repoName, pluginType, displayName, bundleName } = body;
    if (!repoName || !pluginType) {
      json(res, 400, { error: "repoName and pluginType required" }); return;
    }

    // ── Tauri App workflow template ──────────────────────────────────
    const tauriWorkflow = `name: Build ${displayName || repoName}

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true

on:
  workflow_dispatch:
  push:
    branches:
      - main
    paths:
      - "src/**"
      - "src-tauri/**"
      - "sidecar/**"
      - "index.html"
      - "package.json"
      - "package-lock.json"
      - "vite.config.js"
      - ".github/workflows/build.yml"

jobs:
  prepare_release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    outputs:
      app_version: \${{ steps.version.outputs.app_version }}
      should_build: \${{ steps.release_guard.outputs.should_build }}
    steps:
      - uses: actions/checkout@v5

      - name: Setup Node
        uses: actions/setup-node@v6
        with:
          node-version: lts/*

      - name: Resolve app version
        id: version
        run: echo "app_version=\$(node -p "require('./package.json').version")" >> "\$GITHUB_OUTPUT"

      - name: Guard release state
        id: release_guard
        shell: pwsh
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          APP_VERSION: \${{ steps.version.outputs.app_version }}
          RUN_ATTEMPT: \${{ github.run_attempt }}
        run: |
          \$tag = "v\$env:APP_VERSION"
          \$releases = gh api "repos/\$env:GITHUB_REPOSITORY/releases?per_page=100" | ConvertFrom-Json
          \$release = \$releases | Where-Object { \$_.tag_name -eq \$tag } | Select-Object -First 1
          if (-not \$release) {
            gh api "repos/\$env:GITHUB_REPOSITORY/releases" --method POST \`
              --field tag_name="\$tag" --field target_commitish="\$env:GITHUB_SHA" \`
              --field name="${displayName || repoName} v\$env:APP_VERSION" \`
              --field body="See the release assets for desktop build artifacts." \`
              --raw-field draft=true --raw-field prerelease=false | Out-Null
            "should_build=true" >> \$env:GITHUB_OUTPUT
            exit 0
          }
          if (\$release.draft -and [int]\$env:RUN_ATTEMPT -gt 1) {
            "should_build=true" >> \$env:GITHUB_OUTPUT
          } else {
            "should_build=false" >> \$env:GITHUB_OUTPUT
          }

  build:
    needs: prepare_release
    if: needs.prepare_release.outputs.should_build == 'true'
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: windows-latest
            args: "--bundles nsis"
          - platform: macos-latest
            args: "--target universal-apple-darwin --bundles app,dmg"
          - platform: ubuntu-latest
            args: "--bundles appimage"
    runs-on: \${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v6
        with:
          node-version: lts/*
          cache: npm
          cache-dependency-path: "package-lock.json"
      - run: npm install
      - uses: dtolnay/rust-toolchain@stable
      - name: Install macOS universal targets
        if: matrix.platform == 'macos-latest'
        run: rustup target add x86_64-apple-darwin aarch64-apple-darwin
      - name: Install Linux build dependencies
        if: matrix.platform == 'ubuntu-latest'
        run: |
          sudo apt-get update
          sudo apt-get install -y build-essential curl file libayatana-appindicator3-dev \\
            librsvg2-dev libssl-dev libwebkit2gtk-4.1-dev libxdo-dev patchelf wget
      - uses: swatinem/rust-cache@v2
        with:
          workspaces: "src-tauri -> target"
      - name: Build and draft release
        uses: tauri-apps/tauri-action@action-v0.6.0
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: \${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          projectPath: "."
          tagName: v__VERSION__
          releaseName: "${displayName || repoName} v__VERSION__"
          releaseBody: "See the release assets for desktop build artifacts."
          releaseDraft: true
          prerelease: false
          args: \${{ matrix.args }}

  publish_release:
    needs: [prepare_release, build]
    if: needs.prepare_release.outputs.should_build == 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Publish draft release
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          gh release edit "v\${{ needs.prepare_release.outputs.app_version }}" \\
            --draft=false --repo "\$GITHUB_REPOSITORY"
`;

    // ── CMake OFX workflow template ──────────────────────────────────
    const safeBundleName = bundleName || `${displayName || repoName}.ofx.bundle`;
    const pluginSlug     = displayName ? displayName.replace(/\s+/g, "") : repoName.replace(/-OFX$/, "");
    const ofxWorkflow = `name: Build ${displayName || repoName}

on:
  workflow_dispatch:
  push:
    branches:
      - main
    paths:
      - "src/**"
      - "CMakeLists.txt"
      - "cmake/**"
      - ".github/workflows/build.yml"

jobs:
  prepare_release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    outputs:
      version: \${{ steps.version.outputs.version }}
      should_build: \${{ steps.guard.outputs.should_build }}
    steps:
      - uses: actions/checkout@v4
      - name: Read version
        id: version
        run: echo "version=\$(cat VERSION 2>/dev/null || echo '1.0.0')" >> "\$GITHUB_OUTPUT"
      - name: Guard release
        id: guard
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          VERSION: \${{ steps.version.outputs.version }}
        run: |
          TAG="v\$VERSION"
          if gh release view "\$TAG" --repo "\$GITHUB_REPOSITORY" >/dev/null 2>&1; then
            echo "should_build=false" >> "\$GITHUB_OUTPUT"
          else
            echo "should_build=true" >> "\$GITHUB_OUTPUT"
          fi

  build:
    needs: prepare_release
    if: needs.prepare_release.outputs.should_build == 'true'
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-latest
            suffix: macOS-universal
            cmake_extra: -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64"
          - os: windows-latest
            suffix: Windows-x86_64
            cmake_extra: ""
          - os: ubuntu-latest
            suffix: Linux-x86_64
            cmake_extra: ""
    runs-on: \${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive

      - name: Configure
        run: cmake -B build -DCMAKE_BUILD_TYPE=Release \${{ matrix.cmake_extra }}

      - name: Build
        run: cmake --build build --config Release

      - name: Package
        shell: bash
        env:
          VERSION: \${{ needs.prepare_release.outputs.version }}
          SUFFIX: \${{ matrix.suffix }}
        run: |
          mkdir -p dist
          BUNDLE="${safeBundleName}"
          ZIP="${pluginSlug}-v\${VERSION}-\${SUFFIX}.zip"
          # Adjust the path below to match where CMake outputs the bundle
          cd build && zip -r "../dist/\${ZIP}" "\${BUNDLE}" 2>/dev/null || \\
            find . -name "*.ofx" -o -name "*.ofx.bundle" | xargs zip "../dist/\${ZIP}"

      - name: Create or update release
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          VERSION: \${{ needs.prepare_release.outputs.version }}
        run: |
          TAG="v\$VERSION"
          gh release create "\$TAG" dist/*.zip \\
            --repo "\$GITHUB_REPOSITORY" \\
            --title "${displayName || repoName} v\$VERSION" \\
            --notes "" 2>/dev/null || \\
          gh release upload "\$TAG" dist/*.zip --repo "\$GITHUB_REPOSITORY" --clobber
`;

    const workflowYaml = pluginType === "App" ? tauriWorkflow : ofxWorkflow;
    const workflowB64  = Buffer.from(workflowYaml, "utf8").toString("base64");

    const tmpDir = join(tmpdir(), `d18-wf-${Date.now()}`);
    try {
      mkdirSync(tmpDir, { recursive: true });

      // Push .github/workflows/build.yml via GitHub Contents API
      const payloadPath = join(tmpDir, "wf-payload.json");
      writeFileSync(payloadPath, JSON.stringify({
        message: `ci: add ${pluginType === "App" ? "Tauri" : "CMake OFX"} build workflow`,
        content: workflowB64,
      }));
      execSync(
        `gh api repos/dec18studios/${repoName}/contents/.github/workflows/build.yml --method PUT --input "${payloadPath}"`,
        { cwd: REPO_ROOT, stdio: "pipe" }
      );

      json(res, 200, { ok: true, workflowType: pluginType === "App" ? "tauri" : "cmake-ofx" });
    } catch (err) {
      json(res, 500, { error: err.stderr?.toString().trim() || err.message });
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
    return;
  }

  // ── POST /api/plugins/create-release — zip file + gh release create ──
  if (url.pathname === "/api/plugins/create-release" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { json(res, 400, { error: "Invalid JSON" }); return; }

    const { pluginId, repoName, version, fileName, fileBase64 } = body;
    if (!repoName || !version || !fileName || !fileBase64) {
      json(res, 400, { error: "repoName, version, fileName, and fileBase64 are required" }); return;
    }

    const tag     = `v${version.replace(/^v/, "")}`;
    const zipName = `${repoName}-${tag}.zip`;
    const tmpDir  = join(tmpdir(), `d18-release-${Date.now()}`);

    try {
      mkdirSync(tmpDir, { recursive: true });

      // Write the uploaded file to a temp dir
      const rawPath = join(tmpDir, fileName);
      writeFileSync(rawPath, Buffer.from(fileBase64, "base64"));

      // Determine the asset to upload
      // If the user uploaded a zip/tar directly, use it as-is; otherwise zip the raw file.
      let assetPath;
      const isAlreadyArchive = /\.(zip|tar\.gz|tgz)$/i.test(fileName);
      if (isAlreadyArchive) {
        assetPath = rawPath;
      } else {
        const zipPath = join(tmpDir, zipName);
        execSync(`zip "${zipPath}" "${fileName}"`, { cwd: tmpDir, stdio: "pipe" });
        assetPath = zipPath;
      }

      // Ensure the GitHub repo has at least one commit by pushing manager-release-config.json
      // via the GitHub Contents API so `gh release create` can succeed on a fresh repo.
      const configSrc = join(PLUGINS_DIR, pluginId, "manager-release-config.json");
      if (existsSync(configSrc)) {
        const content = readFileSync(configSrc).toString("base64");
        const payloadPath = join(tmpDir, "gh-contents-payload.json");
        writeFileSync(payloadPath, JSON.stringify({
          message: "chore: initial repo setup with manager-release-config",
          content,
        }));
        try {
          execSync(
            `gh api repos/dec18studios/${repoName}/contents/manager-release-config.json --method PUT --input "${payloadPath}"`,
            { cwd: REPO_ROOT, stdio: "pipe" }
          );
        } catch {
          // Already exists or repo isn't empty — fine, carry on.
        }
      }

      // Create the GitHub release and attach the asset
      execSync(
        `gh release create "${tag}" "${assetPath}" --repo "dec18studios/${repoName}" --title "${tag}" --notes ""`,
        { cwd: REPO_ROOT, stdio: "pipe" }
      );

      json(res, 200, { ok: true, tag, assetName: isAlreadyArchive ? fileName : zipName });
    } catch (err) {
      json(res, 500, { error: err.stderr?.toString().trim() || err.message });
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
    return;
  }

  // ── GET /api/github-status — check gh CLI auth ──
  if (url.pathname === "/api/github-status" && req.method === "GET") {
    try {
      const out = execSync("gh auth status 2>&1", { cwd: REPO_ROOT }).toString();
      json(res, 200, { ok: true, detail: out.split("\n")[0] });
    } catch {
      json(res, 200, { ok: false });
    }
    return;
  }

  // ── 404 ──
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`License Manager running at ${url}`);
  try { execSync(`open "${url}"`); } catch {}
});
