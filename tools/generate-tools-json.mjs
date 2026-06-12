import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const managerRoot = path.resolve(args.managerRoot);

  // Default output: sibling dec18studios.github.io clone
  const defaultOutput = path.resolve(
    managerRoot, "..", "dec18studios.github.io", "color-grading-tools", "tools.json"
  );
  const outputPath = args.output ? path.resolve(args.output) : defaultOutput;

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

  const index = readJson(indexPath);
  const indexByPluginId = {};
  for (const entry of index.plugins ?? []) {
    indexByPluginId[entry.pluginId] = entry;
  }

  const tools = [];

  for (const entry of WEB_MAP) {
    const indexEntry = indexByPluginId[entry.pluginId];
    if (!indexEntry) {
      console.warn(`  skip ${entry.pluginId} — not found in index.json`);
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
      tier: tierFromLicenseTier(indexEntry.licenseTier ?? stable?.licenseTier),
      color: entry.color,
      desc: entry.desc,
      ...(url ? { url } : {}),
      ...(entry.repo ? { repo: entry.repo } : {}),
      ...(dlAsset ? { dlAsset } : {}),
      ...(dlUrl ? { dlUrl } : {}),
    };

    tools.push(tool);
    console.log(`  + ${tool.name} [${tool.tier}] → ${tool.slug}  (download: ${dlSource})`);
  }

  writeJson(outputPath, tools);
  console.log(`\nWrote ${tools.length} tools to ${outputPath}`);
}

main();
