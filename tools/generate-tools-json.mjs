import fs from "node:fs";
import path from "node:path";

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
    managerRoot, "..", "..", "dec18studios.github.io", "color-grading-tools", "tools.json"
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

    // tier and url come from the plugin manager; name/desc/color/slug are curated in website-tools.json
    const url = entry.url ?? stable?.infoUrl ?? config?.infoUrl ?? null;
    const tool = {
      name: entry.name,
      slug: entry.slug,
      tier: tierFromLicenseTier(indexEntry.licenseTier ?? stable?.licenseTier),
      color: entry.color,
      desc: entry.desc,
      ...(url ? { url } : {}),
    };

    tools.push(tool);
    console.log(`  + ${tool.name} [${tool.tier}] → ${tool.slug}`);
  }

  writeJson(outputPath, tools);
  console.log(`\nWrote ${tools.length} tools to ${outputPath}`);
}

main();
