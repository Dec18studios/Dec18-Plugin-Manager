import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { validateCatalog } from "./validate-catalog.mjs";

const OWNER = "Dec18studios";

// GitHub's latest release is the source of truth for downloads. Resolve the asset filename in a
// repo's LATEST release so the website points at exactly what's published — not a hand-maintained
// version string. Returns the filename (e.g. "Color-Slicer-DCTL.zip") only when the latest release
// has EXACTLY ONE asset (an unambiguous direct download). Returns null when the repo has no
// release, the GitHub CLI is unavailable, or the release carries multiple assets — a multi-platform
// release (mac/win/linux builds) can't be served by one static link, so callers fall back to the
// releases page and let the visitor pick their platform.
function latestAssetName(repo) {
  try {
    const out = execSync(
      `gh api repos/${OWNER}/${repo}/releases/latest --jq ".assets[].name"`,
      { stdio: ["ignore", "pipe", "ignore"] }
    ).toString().trim();
    if (!out) return null;
    const names = out.split("\n").map((s) => s.trim()).filter(Boolean);
    return names.length === 1 ? names[0] : null;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = {
    managerRoot: process.cwd(),
    output: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === "--manager-root") {
      args.managerRoot = argv[++i];
      continue;
    }
    if (current === "--output") {
      args.output = argv[++i];
      continue;
    }
    if (current === "--members-output") {
      args.membersOutput = argv[++i];
      continue;
    }
    throw new Error(`Unknown argument: ${current}`);
  }

  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function tierFromLicenseTier(licenseTier) {
  return licenseTier === "free" ? "free" : "pro";
}

// The members page groups by these three buckets. index.json's "3rd-party"
// type (e.g. RGB Chips) is a DCTL file, so fold it into the DCTL group.
function memberType(indexType) {
  if (indexType === "OFX" || indexType === "App") return indexType;
  return "DCTL";
}

// Pull the repo, tag, and exact asset filename out of a stable.json
// platform downloadUrl. Two shapes are emitted by the manifest generator:
//   proxy:  https://…workers.dev/v1/<Owner>/<Repo>/releases/download/<tag>/<asset>
//   github: https://github.com/<Owner>/<Repo>/releases/download/<tag>/<asset>
function parseDownloadUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return null; }
  const proxied = u.hostname.includes("download-proxy");
  const parts = u.pathname.split("/").filter(Boolean);
  const dl = parts.indexOf("download");
  if (dl < 0) return null;
  const base = proxied ? 1 : 0; // proxy path is prefixed with "/v1"
  const repo = parts[base + 1];
  const tag = parts[dl + 1];
  const asset = decodeURIComponent(parts.slice(dl + 2).join("/"));
  if (!repo || !asset) return null;
  return { repo, tag, asset, proxied };
}

// Turn an exact, version-stamped asset name into a glob that survives version
// bumps, so the proxy/download link keeps resolving the latest release without
// regeneration: "PhotoChemist_v2.0.1_macOS…zip" + "2.0.1" -> "PhotoChemist_v*_macOS…zip".
// Assets with no version token in the name (e.g. TechnicolorDRT_macOS…zip) pass through.
function versionGlob(asset, version) {
  return version ? asset.split(version).join("*") : asset;
}

// Build the members-download catalog entry for one website-tools.json tool by
// reading the SAME stable.json manifest the Plugin Manager app installs from.
// This is what keeps the members page from ever drifting out of sync with the app.
function buildMemberEntry(entry, indexEntry, stable) {
  const platforms = (stable && stable.platforms) || [];
  const version = stable && stable.version;
  const tier = tierFromLicenseTier(
    indexEntry?.licenseTier ?? stable?.licenseTier ?? entry.tier
  );

  const OS = { macos: "mac", windows: "win", linux: "linux" };
  const perOs = {}; // os -> { repo, asset, glob, proxied }
  for (const pl of platforms) {
    const parsed = parseDownloadUrl(pl.downloadUrl);
    if (!parsed) continue;
    perOs[OS[pl.platform] || pl.platform] = {
      ...parsed,
      glob: versionGlob(parsed.asset, version),
    };
  }

  const repos = [...new Set(Object.values(perOs).map((p) => p.repo))];
  const repo = repos[0] || null;
  const globs = Object.values(perOs).map((p) => p.glob);
  const sharedGlob = new Set(globs).size === 1;

  const member = {
    name: entry.name,
    slug: entry.slug,
    tier,
    color: entry.color,
    desc: entry.desc,
    type: memberType(indexEntry?.type ?? entry.type),
    category: indexEntry?.category || entry.category || "Utility",
  };
  if (repo) member.repo = repo;

  if (repo && tier !== "free") {
    // Premium downloads route through the proxy by glob pattern (+ a member
    // token appended client-side). One glob if every OS ships the same zip,
    // otherwise a per-OS map.
    member.proxyAsset = sharedGlob
      ? globs[0]
      : { mac: perOs.mac?.glob, win: perOs.win?.glob, linux: perOs.linux?.glob };
  } else if (repo && tier === "free" && sharedGlob && Object.keys(perOs).length) {
    // Free tools download straight from GitHub. A single shared asset gives a
    // direct latest-download link; multi-asset free tools fall back to the
    // releases page (handled by the page when dlAsset is absent).
    member.dlAsset = Object.values(perOs)[0].asset;
  }

  // External / third-party hosting (e.g. RGB Chips) — keep the curated link.
  if (entry.dlUrl) member.dlUrl = entry.dlUrl;
  // Landing-page-only premium tools with no release keep their page link.
  if (!repo && entry.url) member.url = entry.url;

  return member;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const managerRoot = path.resolve(args.managerRoot);

  // Default output: sibling dec18studios.github.io clone
  const defaultOutput = path.resolve(
    managerRoot, "..", "dec18studios.github.io", "color-grading-tools", "tools.json"
  );
  const outputPath = args.output ? path.resolve(args.output) : defaultOutput;

  // Members download catalog — sits next to tools.json, consumed by members/index.html
  const membersOutputPath = args.membersOutput
    ? path.resolve(args.membersOutput)
    : path.resolve(path.dirname(outputPath), "members-tools.json");

  // Source of truth — edited via the plugin manager Website tab or directly
  const webToolsPath = path.join(managerRoot, "docs", "website-tools.json");
  if (!fs.existsSync(webToolsPath)) {
    throw new Error(`website-tools.json not found: ${webToolsPath}`);
  }
  const WEB_MAP = readJson(webToolsPath);

  const indexPath = path.join(managerRoot, "docs", "plugins", "index.json");
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Plugin index not found: ${indexPath}`);
  }

  // Hard gate: refuse to emit a catalog that has drifted from index.json. This is
  // the chokepoint — the app's Website-tab publish runs this generator, so a drifted
  // website-tools.json can never reach the published site.
  const v = validateCatalog(managerRoot);
  for (const w of v.warnings) console.warn(`  warn: ${w}`);
  if (!v.ok) {
    console.error("Refusing to generate — catalog drift detected:");
    for (const e of v.errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }

  const index = readJson(indexPath);
  const indexByPluginId = {};
  for (const entry of index.plugins ?? []) {
    indexByPluginId[entry.pluginId] = entry;
  }

  const tools = [];
  const members = [];

  // index.json is the authoritative tool SET — the same catalog the Plugin Manager
  // app loads. website-tools.json is purely a presentation overlay (name/color/desc/
  // order), keyed by pluginId; it can style a tool but can never add one the app
  // doesn't know about. An overlay entry whose pluginId isn't in index.json is a
  // drift bug (renamed/removed plugin) — skip it loudly rather than shipping a
  // website tool the app can't install.
  for (const entry of WEB_MAP) {
    const indexEntry = indexByPluginId[entry.pluginId] ?? null;
    if (!indexEntry) {
      console.warn(`  skip ${entry.pluginId} — overlay entry has no matching plugin in index.json (drift)`);
      continue;
    }

    const stablePath = path.join(managerRoot, "docs", "plugins", entry.pluginId, "stable.json");
    let stable = null;
    if (fs.existsSync(stablePath)) {
      stable = readJson(stablePath);
    }

    const configPath = path.join(managerRoot, "docs", "plugins", entry.pluginId, "manager-release-config.json");
    let config = null;
    if (fs.existsSync(configPath)) {
      config = readJson(configPath);
    }

    // tier comes from the plugin manager; name/desc/color/slug and the download
    // wiring (url/repo/dlAsset/dlUrl) are curated in website-tools.json
    const url = entry.url ?? stable?.infoUrl ?? config?.infoUrl ?? null;

    // Download wiring — GitHub's latest release feeds the link. An explicit dlUrl (external
    // hosting, e.g. RGB Chips) always wins. Otherwise, if the tool has a repo, resolve the
    // actual asset in the latest release and use /releases/latest/download/<asset>, which
    // auto-follows future releases. Fall back to the curated dlAsset, then the releases page.
    let dlUrl = entry.dlUrl ?? null;
    let dlAsset = null;
    let dlSource = entry.dlUrl ? "external" : "none";
    if (!dlUrl && entry.repo) {
      const asset = latestAssetName(entry.repo);
      if (asset) {
        dlUrl = `https://github.com/${OWNER}/${entry.repo}/releases/latest/download/${asset}`;
        dlSource = "github-latest";
      } else if (entry.dlAsset) {
        dlAsset = entry.dlAsset;
        dlSource = "curated-fallback";
      } else {
        dlSource = "releases-page";
      }
    }

    const tool = {
      name: entry.name,
      slug: entry.slug,
      tier: tierFromLicenseTier(indexEntry?.licenseTier ?? stable?.licenseTier ?? entry.tier),
      color: entry.color,
      desc: entry.desc,
      ...(url ? { url } : {}),
      ...(entry.repo ? { repo: entry.repo } : {}),
      ...(dlAsset ? { dlAsset } : {}),
      ...(dlUrl ? { dlUrl } : {}),
      ...(entry.demo ? { demo: true } : {}),
    };

    tools.push(tool);
    console.log(`  + ${tool.name} [${tool.tier}] → ${tool.slug}  (download: ${dlSource})`);

    // Members catalog entry — sourced from the app's own stable.json manifest.
    const member = buildMemberEntry(entry, indexEntry, stable);
    members.push(member);
    const dl = member.proxyAsset
      ? (typeof member.proxyAsset === "object" ? "proxy:per-os" : `proxy:${member.proxyAsset}`)
      : member.dlAsset ? `github:${member.dlAsset}`
      : member.dlUrl ? "external"
      : member.url ? "page" : "releases-page";
    console.log(`      ↳ members: ${member.type}/${member.tier} repo=${member.repo || "—"} (${dl})`);
  }

  // Reconciliation report — every plugin in the authoritative index either renders
  // on the website (has an overlay) or is intentionally app-only. Surfacing the
  // app-only set makes "one list" auditable: nothing is silently missing.
  const overlayIds = new Set(WEB_MAP.map((e) => e.pluginId));
  const appOnly = (index.plugins ?? [])
    .map((e) => e.pluginId)
    .filter((id) => !overlayIds.has(id));
  if (appOnly.length) {
    console.log(`\nApp-only (in index.json, not shown on website): ${appOnly.join(", ")}`);
  }

  writeJson(outputPath, tools);
  console.log(`\nWrote ${tools.length} tools to ${outputPath}`);

  writeJson(membersOutputPath, members);
  console.log(`Wrote ${members.length} members entries to ${membersOutputPath}`);
}

main();
