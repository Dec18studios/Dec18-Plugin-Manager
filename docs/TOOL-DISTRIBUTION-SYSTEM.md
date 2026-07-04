# Dec18 Studios — Tool Distribution System

## Purpose
Publishes color-grading tools (OFX plugins + DCTL files) to two audiences from one
source of truth: (1) a desktop "Plugin Manager" app that installs/updates tools, and
(2) a members download webpage (tools.dec18studios.com) where licensed users grab files
by hand. Free tools download directly from GitHub; paid tools go through a license gate.

## Two repos
- **Dec18-Plugin-Manager** — the catalog + the admin backend + the desktop app source.
  Publishes GitHub Pages at dec18studios.github.io/Dec18-Plugin-Manager/ (the manifests
  the desktop app reads).
- **dec18studios.github.io** — the public website (Squarespace pulls from it). Holds the
  members page and the generated website JSON. Cloned as a SIBLING folder next to the
  manager repo (the generator writes across into it).

## Catalog data model (single source + overlay)
- `docs/plugins/index.json` = the AUTHORITATIVE SET of tools the desktop app knows about.
- `docs/plugins/<id>/manager-release-config.json` = per-tool config: which GitHub repo
  holds its releases, the regex `assetPattern` that finds the right .zip in a release,
  the `bundleName` (exact filename that must live INSIDE the zip), and per-platform
  install paths.
- `docs/plugins/<id>/stable.json` = the GENERATED manifest the app installs from: current
  version, per-platform downloadUrl + sha256, and an `availableVersions` history.
- `docs/website-tools.json` = a PRESENTATION OVERLAY (name/color/description/order only).
  It can style a tool that exists in index.json but cannot add or remove one.

## The publish pipeline (order matters)
1. A GitHub RELEASE is created on the tool's own release repo, with a zip asset.
2. `generate-plugin-channel-manifests.mjs` reads the releases JSON, matches the asset via
   `assetPattern`, downloads it to compute sha256, and REGENERATES `stable.json` (bumps
   the version, demotes the old one into availableVersions).
3. `generate-tools-json.mjs` reads the overlay + each `stable.json` and emits two files
   into the website repo: `tools.json` (public marketing) and `members-tools.json`
   (members downloads). It REQUIRES a matching index.json entry per row.
4. CI (`deploy-plugin-manager-pages.yml`) runs steps 2–3 on push and deploys Pages.

## The admin backend
`tools/license-server.mjs` — a local Node server (http://localhost:9218) serving
`tools/license-manager.html`. Tabs: Licenses, Plugin Catalog, Website Tools, Downloads.
It can create GitHub releases (shells out to the `gh` CLI), upload new tool versions,
edit the overlay, and publish. It signs license keys with a local Ed25519 private.pem and
tracks a ledger.json (both gitignored secrets, never committed).

## CRITICAL GOTCHAS (these cause silent breakage)
1. VERSION-FREE ASSET NAMES. Release zips must have a stable, version-free filename
   (e.g. `Film-Negative-Space-CST-DCTL.zip`), because the website links to
   `/releases/latest/download/<asset>`, which only follows "latest" if the name is
   identical across releases. A versioned name (`...-v2.2.zip`) 404s on the next bump.
2. bundleName must match the file INSIDE the zip exactly. For DCTLs, the .dctle inside
   the zip must be named per `bundleName` (no version), or installs fail. When zipping a
   raw file, the admin uses the uploaded filename as the inner name — so upload a
   correctly-named (version-free) file.
3. assetPattern must be rename-proof. If the pattern hardcodes an old asset name, a
   rename at a new version makes the manifest regen fail silently and freezes the version.
   Use a broad glob (e.g. `.*CST.*\.zip$`) when the repo ships exactly one zip per release.
4. STABLE.JSON REGEN GAP. The admin's post-release "website sync" only regenerates the
   website JSON — it does NOT run the manifest regenerator (step 2). So after creating a
   release through the admin, `stable.json` can stay on the old version, and the website
   JSON then gets rebuilt from that stale manifest and points the download at the old
   (now-missing) asset -> 404. Fix: run generate-plugin-channel-manifests.mjs (feed it the
   releases JSON), THEN generate-tools-json.mjs, then commit + push both repos.
5. Workflow-file pushes need SSH (the OAuth token lacks `workflow` scope); other pushes
   are fine. The build volume is an SMB share where writeFileSync can silently drop —
   re-read to verify after writing.

## How to sanity-check a publish
- `stable.json` version == the release tag, and its downloadUrl uses the version-free asset.
- `curl -sI -L .../releases/latest/download/<asset>` returns 200.
- `members-tools.json` dlAsset == the version-free asset name.
- The members webpage loads its catalog from an ABSOLUTE URL to members-tools.json (a
  relative URL breaks when the markup is injected into another origin like Squarespace).
