# Plugin Manager Development Notes

Quick reference for the Dec 18 Studios Plugin Manager. Covers project organization, constraints, release/manifest generation, and important behavior to preserve.

Update this file whenever any of the following change:
- repo relationships
- release/workflow behavior
- platform-signing status
- updater/catalog URLs
- manifest schema or channel rules
- important UX behavior that future work should preserve

## Purpose

The plugin manager is a Tauri desktop app that:
- presents a catalog of OFX plugins
- installs, updates, reinstalls, downgrades, and uninstalls plugin bundles
- hosts its public catalog and updater feed from GitHub Pages
- consumes plugin releases from separate plugin repos

Current managed plugins:
- PhotoChemist

## Main Repositories

Manager repo:
- GitHub: https://github.com/dec18studios/Dec18-Plugin-Manager

PhotoChemist OFX repo:
- GitHub: https://github.com/dec18studios/PhotoChemist-OFX

## App Stack

Frontend:
- Vite
- plain JavaScript
- CSS in `src/styles.css`

Desktop shell:
- Tauri v2

Backend:
- Rust in `src-tauri/src`

Important frontend files:
- `index.html`
- `src/main.js`
- `src/styles.css`

Important backend files:
- `src-tauri/src/catalog.rs`
- `src-tauri/src/installer.rs`
- `src-tauri/src/models.rs`
- `src-tauri/src/settings.rs`

## Public Hosting And Feeds

Catalog index:
- `https://dec18studios.github.io/Dec18-Plugin-Manager/plugins/index.json`

Updater feed:
- `https://dec18studios.github.io/Dec18-Plugin-Manager/updates/latest.json`

Important generated docs paths:
- `docs/plugins/index.json`
- `docs/plugins/photochemist/stable.json`
- `docs/updates/latest.json`

Local dev-only feed paths:
- `docs/plugins/dev/index.json`

Important note:
- the live manager does not read GitHub releases directly
- it reads generated manifest JSON and the generated updater feed

## Build And Local Preview Commands

Run local dev preview:

```bash
npm run tauri:dev
```

Build production-style local package:

```bash
npm run tauri:build
```

Frontend build check:

```bash
npm run build
```

Rust build check:

```bash
cd src-tauri && cargo check
```

Generate plugin manifests manually:

```bash
npm run generate:plugin-manifests
```

## Manager Release Workflows

Manager build workflow:
- `.github/workflows/build-plugin-manager.yml`

Manager Pages deployment workflow:
- `.github/workflows/deploy-plugin-manager-pages.yml`

Current manager build workflow behavior:
- triggers on pushes to `main` for manager-app-relevant files
- checks the app version from `package.json`
- uses version tag format `plugin-manager-v<version>`
- creates or reuses a draft release shell for that version
- skips cleanly when that version is already drafted/published
- builds Windows, macOS, and Linux packages
- uploads updater artifacts used by the Tauri updater

Current Pages workflow behavior:
- triggers on:
  - workflow dispatch
  - pushes touching `docs/**`
  - manager release `published`
- regenerates plugin manifests from the latest plugin release data
- regenerates the manager updater feed
- publishes Pages content from `pages-dist`

Important practical note:
- a manager release can exist before `updates/latest.json` has refreshed
- in that gap the manager may report that the update is still being published
- this is expected race behavior until Pages catches up

## Plugin Repo Release Automation

Each plugin repo owns its own release artifacts.

Each plugin repo should have:
- a `manager-release-config.json`
- an `update-plugin-manager-manifest.yml` workflow

That workflow:
- reads the plugin repo release data
- regenerates the manager manifest content
- opens a PR against `Dec18-Plugin-Manager`

Secrets required in each plugin repo:
- `D18PM_MANAGER_REPO_TOKEN`

Token purpose:
- allows the plugin repo workflow to open/update PRs in `Dec18-Plugin-Manager`

## Channel Model

Current supported channels:
- stable
- available stable history
- beta

Current rules:
- `stable.json` exposes the current public stable release
- `availableVersions` contains older stable versions explicitly marked to remain installable
- `beta.json` exposes the latest public prerelease

Stable-history marker in a published plugin release body:

```text
manager-available-stable: true
```

Release highlights block in a published plugin release body:

```md
<!-- manager-highlights:start -->
- Bullet one
- Bullet two
Short optional note.
<!-- manager-highlights:end -->
```

That block is extracted into:
- top-level `releaseHighlights` for the current release
- per-version `releaseHighlights` for entries inside `availableVersions`

## Important Current UX/Behavior Decisions

- If beta is enabled and a beta manifest exists, beta becomes the target latest release.
- Stable history should still remain selectable when beta is enabled.
- If a user has a beta installed and later disables beta, the card should help them move back to stable rather than pretending the beta is simply "up to date".
- Version-history UI should stay hidden unless there is more than one selectable version.
- Release highlights are shown through compact info buttons in the main action row and version-history row.
- Manager auto-update is checked opportunistically before plugin install/update actions, but plugin install remains the primary user intent:
  - manager update failures should not block plugin install/update
  - manager update failures can still be shown afterward for diagnosis

## Plugin Package Layout Expectations

The manager expects plugin packages to contain the `.ofx.bundle` at the top level of the archive.

Examples:
- Windows plugin package: portable `.zip`
- macOS plugin package: portable `.zip`
- Linux plugin package: portable `.tar.gz` or other supported archive type as described in the manifest

The manager installs bundles into platform-specific OFX locations and uses admin elevation where needed.

## macOS Signing / Notarization Status

Current limitation:
- not currently an Apple Developer Program member
- macOS artifacts can still be built and distributed
- macOS users may need manual trust steps (right-click Open, Security settings approval)

Future direction when Apple Developer credentials are available:
- add proper Apple signing certificates and notarization to CI
- sign the manager app bundles correctly
- notarize DMG/app artifacts
- remove or reduce user-facing macOS trust friction

## Tauri Updater Notes

Important updater config lives in:
- `src-tauri/tauri.conf.json`

Current updater endpoint:
- `https://dec18studios.github.io/Dec18-Plugin-Manager/updates/latest.json`

Current Windows updater mode:
- passive install mode in Tauri updater config

Current NSIS manager bundle behavior:
- current-user install mode in Tauri bundle config

## Known Repo/Workflow Conventions

Manager version sources must stay aligned in:
- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

When bumping manager version, keep those three in sync.

When plugin releases change and the manager does not see them:
- check whether the plugin repo manifest-update workflow ran
- check whether it opened a PR in `Dec18-Plugin-Manager`
- check whether the PR was merged
- check whether Pages deployed afterward

## Adding a New Plugin to the Catalog

1. Create `docs/plugins/<pluginId>/manager-release-config.json` (copy from `photochemist` as template)
2. Add an embedded manifest constant in `src-tauri/src/catalog.rs`
3. Add a fixture file in `tools/fixtures/<pluginId>-releases.sample.json`
4. Update `docs/plugins/index.json` with the new entry
5. In the plugin repo, create an `update-plugin-manager-manifest.yml` workflow
6. Set the `D18PM_MANAGER_REPO_TOKEN` secret in the plugin repo

## Future Improvement Directions

- Proper macOS signing + notarization once Apple developer credentials are available
- Better release-feed race handling so manager updates feel more immediate after release publish
- More resilient CI around draft release reuse and asset replacement
- Continued UI polishing for narrow mode, sticky regions, and scroll/fade behavior
- Better semantic handling of beta-to-stable transitions and version-history wording

## Maintenance Reminder

Whenever you change:
- a release workflow
- a manifest schema
- signing behavior
- updater endpoint behavior
- local dev feed behavior

update this note at the same time so future work stays grounded in the real setup instead of stale memory.
