# Dec 18 Studios Plugins

A Tauri 2 desktop manager for Dec 18 Studios OFX plugins. Installs, updates, and manages plugin bundles across macOS, Windows, and Linux.

## Features

- Catalog-driven plugin browsing with categories, search, and sorting
- One-click install/update/uninstall for OFX plugin bundles
- SHA256 verification of all downloaded packages
- Host process detection (blocks install while Resolve/Nuke are running)
- Backup and rollback on failed updates
- Auto-updater for the manager app itself
- Donation link integration

## Current Plugins

- **PhotoChemist** — 43-band spectral film emulation (CUDA, Metal, OpenCL)

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) (LTS)
- [Rust](https://www.rust-lang.org/tools/install) toolchain
- Platform build tools (Xcode CLI on macOS, Visual Studio Build Tools on Windows)

### Development

```bash
npm install
npm run tauri:dev
```

### Production Build

```bash
npm run tauri:build
```

## GitHub Setup

### 1. Create the repository

Create `dec18studios/Dec18-Plugin-Manager` on GitHub.

### 2. Enable GitHub Pages

Settings > Pages > Source: **GitHub Actions**.

### 3. Generate Tauri signing keys

```bash
npx @tauri-apps/cli signer generate -w ~/.tauri/dec18studios.key
```

### 4. Set repository secrets

| Secret | Purpose |
|--------|---------|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of the `.key` file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password used during key generation |

### 5. Update the public key

Replace `REPLACE_WITH_YOUR_TAURI_SIGNING_PUBKEY` in `src-tauri/tauri.conf.json` with the generated public key.

### 6. Push and build

```bash
git init && git add . && git commit -m "Initial commit"
git remote add origin git@github.com:dec18studios/Dec18-Plugin-Manager.git
git push -u origin main
```

The CI workflows will build the app for all platforms and deploy the catalog to GitHub Pages.

## Adding a New Plugin

1. Create a `manager-release-config.json` for the plugin (see `docs/plugins/photochemist/manager-release-config.json` as a template).
2. Place it in `docs/plugins/<pluginId>/manager-release-config.json`.
3. Create a GitHub release in the plugin repo with platform assets matching the `assetPattern` regexes.
4. Add a sample fixture in `tools/fixtures/<pluginId>-releases.sample.json`.
5. Run `npm run generate:plugin-manifests` to regenerate manifests.
6. Add an embedded manifest reference in `src-tauri/src/catalog.rs` for offline fallback.

## Architecture

See [PLUGIN_MANAGER_DEVELOPMENT_NOTES.md](PLUGIN_MANAGER_DEVELOPMENT_NOTES.md) for detailed architecture, workflow, and deployment notes.

## macOS Note

Plugin installation clears quarantine flags on unsigned bundles. Once plugins are properly signed and notarized, this behavior can be removed.
