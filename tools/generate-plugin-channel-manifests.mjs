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

function updateIndex(indexPath, pluginId, displayName, category) {
  const index = readJson(indexPath);
  index.generatedAt = new Date().toISOString();
  const manifestUrl = `https://dec18studios.github.io/Dec18-Plugin-Manager/plugins/${pluginId}/stable.json`;
  const entries = Array.isArray(index.plugins) ? [...index.plugins] : [];
  const existingIndex = entries.findIndex((entry) => entry.pluginId === pluginId);
  const nextEntry = { pluginId, displayName, manifestUrl, category: category || null };

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

  const availableStableMarker = config.availableStableMarker || "manager-available-stable";
  const availableVersions = [];
  for (const release of stableGitHubReleases.slice(1)) {
    if (!parseBooleanMarker(release.body || "", availableStableMarker)) {
      continue;
    }
    availableVersions.push(await buildReleaseFromGitHubRelease(config, release, { requireFamilies: false }));
  }

  const stableManifest = {
    pluginId: config.pluginId,
    displayName: config.displayName,
    description: config.description || null,
    category: config.category || null,
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
      availableVersions: []
    };
  }

  const pluginDir = path.join(managerRoot, "docs", "plugins", config.pluginId);
  const stablePath = path.join(pluginDir, "stable.json");
  const betaPath = path.join(pluginDir, "beta.json");
  const indexPath = path.join(managerRoot, "docs", "plugins", "index.json");

  writeJson(stablePath, stableManifest);
  if (betaManifest) {
    writeJson(betaPath, betaManifest);
  } else {
    removeIfExists(betaPath);
  }

  updateIndex(indexPath, config.pluginId, config.displayName, config.category);
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
