import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    managerRoot: process.cwd(),
    configs: [],
    releasesJson: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === "--manager-root") {
      args.managerRoot = argv[++i];
      continue;
    }
    if (current === "--config") {
      args.configs.push(argv[++i]);
      continue;
    }
    if (current === "--releases-json") {
      args.releasesJson.push(argv[++i]);
      continue;
    }
    throw new Error(`Unknown argument: ${current}`);
  }

  return args;
}

function discoverDefaultConfigs(managerRoot) {
  // Look for per-plugin release configs in docs/plugins/<pluginId>/
  const pluginsDir = path.join(managerRoot, "docs", "plugins");
  const candidates = [];
  if (fs.existsSync(pluginsDir)) {
    for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const configPath = path.join(pluginsDir, entry.name, "manager-release-config.json");
      if (fs.existsSync(configPath)) {
        candidates.push(configPath);
      }
    }
  }
  return candidates;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function removeIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function validateAssetRule(config, rule, index) {
  const required = [
    "family",
    "platform",
    "arch",
    "assetPattern",
    "packageType",
    "bundleName",
    "bundleIdentifier",
    "installPath"
  ];

  for (const field of required) {
    assert(
      typeof rule[field] === "string" && rule[field].length > 0,
      `${config.pluginId}: assetRules[${index}] is missing '${field}'`
    );
  }
}

function validateConfig(config) {
  assert(typeof config.pluginId === "string" && config.pluginId.length > 0, "pluginId is required");
  assert(typeof config.displayName === "string" && config.displayName.length > 0, `${config.pluginId}: displayName is required`);
  assert(typeof config.releaseRepo === "string" && config.releaseRepo.length > 0, `${config.pluginId}: releaseRepo is required`);
  assert(typeof config.minManagerVersion === "string" && config.minManagerVersion.length > 0, `${config.pluginId}: minManagerVersion is required`);
  assert(Array.isArray(config.hostProcesses) && config.hostProcesses.length > 0, `${config.pluginId}: hostProcesses must be a non-empty array`);
  assert(Array.isArray(config.requiredFamilies) && config.requiredFamilies.length > 0, `${config.pluginId}: requiredFamilies must be a non-empty array`);
  assert(Array.isArray(config.assetRules) && config.assetRules.length > 0, `${config.pluginId}: assetRules must be a non-empty array`);

  config.assetRules.forEach((rule, index) => validateAssetRule(config, rule, index));
}

function parseVersionFromTag(tagName, config) {
  const patterns = [];
  if (typeof config.versionPattern === "string" && config.versionPattern.length > 0) {
    patterns.push(new RegExp(config.versionPattern, "i"));
  }
  patterns.push(/(?:^|-)v(.+)$/i);
  patterns.push(/^v(.+)$/i);

  for (const pattern of patterns) {
    const match = tagName.match(pattern);
    if (!match) {
      continue;
    }

    if (match.groups?.version) {
      return match.groups.version;
    }

    if (match[1]) {
      return match[1];
    }
  }

  return tagName;
}

function parseBooleanMarker(body, markerName) {
  if (typeof body !== "string" || body.length === 0) {
    return false;
  }

  const escaped = markerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|\\n)\\s*${escaped}\\s*:\\s*true\\s*($|\\n)`, "i");
  return pattern.test(body);
}

function extractMarkedBlock(body, startMarker, endMarker) {
  if (typeof body !== "string" || body.length === 0) {
    return undefined;
  }

  const startIndex = body.indexOf(startMarker);
  if (startIndex < 0) {
    return undefined;
  }

  const contentStart = startIndex + startMarker.length;
  const endIndex = body.indexOf(endMarker, contentStart);
  if (endIndex < 0) {
    return undefined;
  }

  const value = body.slice(contentStart, endIndex).replace(/\r\n/g, "\n").trim();
  return value.length > 0 ? value : undefined;
}

function extractReleaseHighlights(body) {
  return extractMarkedBlock(
    body,
    "<!-- manager-highlights:start -->",
    "<!-- manager-highlights:end -->"
  );
}

function sortReleases(releases) {
  return [...releases].sort((left, right) => {
    const leftDate = Date.parse(left.published_at || left.created_at || 0);
    const rightDate = Date.parse(right.published_at || right.created_at || 0);
    return rightDate - leftDate;
  });
}

function findMatchingAsset(assets, rule) {
  const pattern = new RegExp(rule.assetPattern, "i");
  const matches = assets.filter((asset) => pattern.test(asset.name));
  if (matches.length > 1) {
    throw new Error(`Multiple assets match rule '${rule.assetPattern}': ${matches.map((asset) => asset.name).join(", ")}`);
  }
  return matches[0] ?? null;
}

async function sha256ForAsset(asset) {
  const digest = asset.digest || asset.sha256 || "";
  if (typeof digest === "string" && digest.length > 0) {
    return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
  }

  assert(typeof fetch === "function", `Cannot hash ${asset.name}: fetch is unavailable in this Node runtime`);
  const response = await fetch(asset.browser_download_url);
  if (!response.ok) {
    throw new Error(`Failed to download ${asset.name} for hashing: ${response.status} ${response.statusText}`);
  }

  const hash = crypto.createHash("sha256");
  const arrayBuffer = await response.arrayBuffer();
  hash.update(Buffer.from(arrayBuffer));
  return hash.digest("hex");
}

// In-run cache of demo release lookups, keyed by `${owner}/${repo}@${tag}`, so
// the three platform assets that share one demo release only hit the API once.
const demoReleaseAssetCache = new Map();

// Resolve a demo asset's sha256 LIVE from its GitHub release instead of pinning
// it in manager-release-config.json. The public demo release is delete+recreated
// on every build (same marketing tag, new bytes → new digest), so a pinned hash
// goes stale every release while the version-free URL stays valid. Reading
// asset.digest from the releases API keeps the demo download verifiable with zero
// maintenance — and zero bandwidth, since GitHub returns the digest in the asset
// metadata (no zip download, mirroring sha256ForAsset's digest fast-path).
async function fetchDemoAssetSha256(downloadUrl) {
  const url = new URL(downloadUrl);
  const segments = url.pathname.split("/").filter(Boolean);
  const downloadIdx = segments.indexOf("download");
  assert(
    url.hostname === "github.com" && downloadIdx >= 3 && segments[downloadIdx - 1] === "releases",
    `Demo downloadUrl is not a GitHub release asset URL: ${downloadUrl}`
  );
  const owner = segments[0];
  const repo = segments[1];
  const tag = decodeURIComponent(segments[downloadIdx + 1]);
  const assetName = decodeURIComponent(segments.slice(downloadIdx + 2).join("/"));

  const cacheKey = `${owner}/${repo}@${tag}`;
  let assetsByName = demoReleaseAssetCache.get(cacheKey);
  if (!assetsByName) {
    assert(typeof fetch === "function", `Cannot resolve demo sha for ${assetName}: fetch is unavailable in this Node runtime`);
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
    const token = process.env.PLUGIN_PAT || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "dec18-plugin-manifest-generator"
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetch(apiUrl, { headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch demo release ${cacheKey} for hashing: ${response.status} ${response.statusText}`);
    }
    const release = await response.json();
    assetsByName = new Map((Array.isArray(release.assets) ? release.assets : []).map((asset) => [asset.name, asset]));
    demoReleaseAssetCache.set(cacheKey, assetsByName);
  }

  const asset = assetsByName.get(assetName);
  assert(asset, `Demo release ${cacheKey} has no asset named ${assetName}`);
  const digest = asset.digest || asset.sha256 || "";
  assert(typeof digest === "string" && digest.length > 0, `Demo asset ${assetName} in ${cacheKey} exposes no digest`);
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
}

async function buildReleaseFromGitHubRelease(config, release, options = {}) {
  const requireFamilies = options.requireFamilies ?? false;
  const matchedPackages = [];
  const matchedFamilies = new Set();

  for (const rule of config.assetRules) {
    const asset = findMatchingAsset(Array.isArray(release.assets) ? release.assets : [], rule);
    if (!asset) {
      continue;
    }

    const sha256 = await sha256ForAsset(asset);
    matchedFamilies.add(rule.family);
    matchedPackages.push({
      platform: rule.platform,
      arch: rule.arch,
      downloadUrl: asset.browser_download_url,
      sha256,
      packageType: rule.packageType,
      bundleName: rule.bundleName,
      bundleIdentifier: rule.bundleIdentifier,
      installPath: rule.installPath,
      installMode: rule.installMode || "bundle",
      minManagerVersion: rule.minManagerVersion || config.minManagerVersion,
      hostProcesses: rule.hostProcesses || config.hostProcesses
    });
  }

  assert(matchedPackages.length > 0, `${config.pluginId}: release ${release.tag_name} has no matching packaged assets`);

  if (requireFamilies) {
    for (const family of config.requiredFamilies) {
      assert(
        matchedFamilies.has(family),
        `${config.pluginId}: release ${release.tag_name} is missing a required '${family}' package`
      );
    }
  }

  return {
    version: parseVersionFromTag(release.tag_name, config),
    releaseDate: release.published_at || release.created_at,
    releaseNotesUrl: release.html_url,
    releaseHighlights: extractReleaseHighlights(release.body || ""),
    platforms: matchedPackages
  };
}

// Stamp the demo coordinates from the release config onto the current release's
// platform packages. The demo is a fixed public artifact (its own repo + tag)
// that does NOT track per-release bumps, so its version + downloadUrl live
// statically in manager-release-config.json. The sha256, however, changes on
// every demo rebuild (the marketing tag is delete+recreated with new bytes), so
// it is resolved LIVE from the demo release rather than pinned — a pinned hash
// would 404-equivalent (fail verification) on the next build. A sha256 left in
// the config is still honored as a manual override. Only the top-level (current)
// platforms get demo fields — availableVersions[] stay demo-free, matching how
// the manager routes unlicensed installs.
async function applyDemoToManifest(manifest, config) {
  const demo = config.demo;
  if (!demo) {
    return manifest;
  }

  const next = {};
  for (const [key, value] of Object.entries(manifest)) {
    next[key] = value;
    // Place demoVersion immediately after releaseNotesUrl for a stable key order.
    if (key === "releaseNotesUrl" && typeof demo.version === "string" && demo.version.length > 0) {
      next.demoVersion = demo.version;
    }
  }

  const assets = demo.assets || {};
  next.platforms = await Promise.all((manifest.platforms || []).map(async (pkg) => {
    const demoAsset = assets[`${pkg.platform}-${pkg.arch}`];
    if (!demoAsset || !demoAsset.downloadUrl) {
      return pkg;
    }
    // Pinned sha256 (if any) wins as a manual override; otherwise resolve it live
    // from the demo release so it never goes stale across rebuilds.
    const sha256 = (typeof demoAsset.sha256 === "string" && demoAsset.sha256.length > 0)
      ? demoAsset.sha256
      : await fetchDemoAssetSha256(demoAsset.downloadUrl);
    if (!sha256) {
      return pkg;
    }
    const withDemo = {};
    for (const [key, value] of Object.entries(pkg)) {
      withDemo[key] = value;
      // Insert demo asset fields right after sha256 for a stable key order.
      if (key === "sha256") {
        withDemo.demoDownloadUrl = demoAsset.downloadUrl;
        withDemo.demoSha256 = sha256;
      }
    }
    return withDemo;
  }));

  return next;
}

function updateIndex(indexPath, pluginId, displayName, category, type, licenseTier) {
  const index = readJson(indexPath);
  index.generatedAt = new Date().toISOString();
  const manifestUrl = `https://dec18studios.github.io/Dec18-Plugin-Manager/plugins/${pluginId}/stable.json`;
  const entries = Array.isArray(index.plugins) ? [...index.plugins] : [];
  const existingIndex = entries.findIndex((entry) => entry.pluginId === pluginId);
  const existing = existingIndex >= 0 ? entries[existingIndex] : {};
  const nextEntry = {
    ...existing,
    pluginId,
    displayName,
    manifestUrl,
    category: category || existing.category || null,
    // type / licenseTier drive the manager's tab filters; new entries must
    // carry them from the config or a fresh plugin gets filtered out of view.
    type: type || existing.type || null,
    licenseTier: licenseTier || existing.licenseTier || null,
  };

  if (existingIndex >= 0) {
    entries[existingIndex] = nextEntry;
  } else {
    entries.push(nextEntry);
  }

  entries.sort((left, right) => left.displayName.localeCompare(right.displayName));
  index.plugins = entries;
  writeJson(indexPath, index);
}

async function generateForConfig(configPath, releasesPath, managerRoot) {
  const config = readJson(configPath);
  validateConfig(config);

  const allReleases = sortReleases(readJson(releasesPath))
    .filter((release) => !release.draft)
    .filter((release) => release.tag_name);

  const stableGitHubReleases = allReleases.filter((release) => !release.prerelease);
  const betaGitHubReleases = allReleases.filter((release) => release.prerelease);

  assert(stableGitHubReleases.length > 0, `${config.pluginId}: no published stable releases were found in ${config.releaseRepo}`);

  const currentStableRelease = await buildReleaseFromGitHubRelease(config, stableGitHubReleases[0], {
    requireFamilies: true
  });

  const availableVersions = [];
  for (const release of stableGitHubReleases.slice(1)) {
    try {
      availableVersions.push(await buildReleaseFromGitHubRelease(config, release, { requireFamilies: false }));
    } catch {
      // skip releases with no matching assets (e.g. placeholder releases)
    }
  }

  const stableManifest = {
    pluginId: config.pluginId,
    displayName: config.displayName,
    description: config.description || null,
    category: config.category || null,
    licenseTier: config.licenseTier || null,
    tags: config.tags || [],
    infoUrl: config.infoUrl || null,
    version: currentStableRelease.version,
    releaseDate: currentStableRelease.releaseDate,
    releaseNotesUrl: currentStableRelease.releaseNotesUrl,
    releaseHighlights: currentStableRelease.releaseHighlights,
    platforms: currentStableRelease.platforms,
    availableVersions
  };

  let betaManifest = null;
  if (betaGitHubReleases.length > 0) {
    const currentBetaRelease = await buildReleaseFromGitHubRelease(config, betaGitHubReleases[0], {
      requireFamilies: true
    });
    const availableBetaVersions = [];
    for (const release of betaGitHubReleases.slice(1)) {
      try {
        availableBetaVersions.push(await buildReleaseFromGitHubRelease(config, release, { requireFamilies: false }));
      } catch {
        // skip releases with no matching assets
      }
    }
    betaManifest = {
      pluginId: config.pluginId,
      displayName: config.displayName,
      description: config.description || null,
      category: config.category || null,
      tags: config.tags || [],
      infoUrl: config.infoUrl || null,
      version: currentBetaRelease.version,
      releaseDate: currentBetaRelease.releaseDate,
      releaseNotesUrl: currentBetaRelease.releaseNotesUrl,
      releaseHighlights: currentBetaRelease.releaseHighlights,
      platforms: currentBetaRelease.platforms,
      availableVersions: availableBetaVersions
    };
  }

  const pluginDir = path.join(managerRoot, "docs", "plugins", config.pluginId);
  const stablePath = path.join(pluginDir, "stable.json");
  const betaPath = path.join(pluginDir, "beta.json");
  const indexPath = path.join(managerRoot, "docs", "plugins", "index.json");

  writeJson(stablePath, await applyDemoToManifest(stableManifest, config));
  if (betaManifest) {
    writeJson(betaPath, await applyDemoToManifest(betaManifest, config));
  } else {
    removeIfExists(betaPath);
  }

  updateIndex(indexPath, config.pluginId, config.displayName, config.category, config.type, config.licenseTier);
  console.log(`Generated manifests for ${config.pluginId} from ${config.releaseRepo}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const managerRoot = path.resolve(args.managerRoot);
  const configs = args.configs.length ? args.configs.map((item) => path.resolve(item)) : discoverDefaultConfigs(managerRoot);
  const releaseJsonFiles = args.releasesJson.map((item) => path.resolve(item));

  assert(configs.length > 0, "No manager-release-config.json files were provided or discovered.");
  assert(
    releaseJsonFiles.length === configs.length,
    "Pass one --releases-json file for each --config file."
  );

  for (let index = 0; index < configs.length; index += 1) {
    await generateForConfig(configs[index], releaseJsonFiles[index], managerRoot);
  }
}

await main();
