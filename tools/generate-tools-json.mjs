import fs from "node:fs";
import path from "node:path";

// Website card definitions — marketing name/desc/color/slug live here.
// Only `tier` and `url` are pulled from the plugin manager at generation time.
// Order here becomes display order in the tools grid (pro tools first, then free).
// Plugins not listed here are excluded from the website.
const WEB_MAP = [
  {
    pluginId: "photochemist",
    slug: "photochemist", color: "red",
    name: "Photo Chemist",
    desc: "Spectral film-stock emulation — design and develop your own stocks.",
  },
  {
    pluginId: "technicolor-drt-ofx",
    slug: "technicolordrt", color: "magenta",
    name: "Technically Technicolor DRT",
    desc: "A three-strip Technicolor look as a display rendering transform.",
  },
  {
    pluginId: "hue-contrast-compressor-dctl",
    slug: "hue-contrast-compressor", color: "yellow",
    name: "Hue Contrast Compressor",
    desc: "Tame hue-driven contrast for smoother, more controlled color.",
  },
  {
    pluginId: "volume-curve-dctl",
    slug: "volume-curve", color: "cyan",
    name: "Volume Curve",
    desc: "Shape tonal volume and contrast with a custom response curve.",
  },
  {
    pluginId: "grain-by-greg-dctl",
    slug: "grain", color: "green",
    name: "Grain By Greg",
    desc: "Natural, filmic grain that lives in the texture of the image.",
  },
  {
    pluginId: "GE_Color_Slicer",
    slug: "colorslice", color: "blue",
    name: "Color Slicer",
    desc: "Slice the image into color regions for precise, targeted grading.",
  },
  {
    pluginId: "hue-contrast-compressor-ofx",
    slug: "contrast-sat-volume", color: "red",
    name: "Contrast Sat Volume",
    desc: "GPU-accelerated OFX — compress hue shifts caused by contrast and saturation moves.",
  },
  {
    pluginId: "grade-match",
    slug: "grade-match", color: "cyan",
    name: "GradeMatch",
    desc: "Per-channel histogram matching with vectorscope, patch sampler, and perceptual diff heatmap.",
  },
  {
    pluginId: "split-tone-x-ofx",
    slug: "split-tone-x", color: "magenta",
    name: "SplitToneX",
    desc: "Dual-engine split toning with Film Density curves, SatSelect gating, and diagnostic overlays.",
  },
  {
    pluginId: "trim-top-bottom-dctl",
    slug: "trim-top-bottom", color: "yellow",
    name: "Trim Top Bottom",
    desc: "Gently roll off highlights or lift shadows before your DRT.",
  },
  {
    pluginId: "perfect-exposure-dctl",
    slug: "perfect-exposure", color: "green",
    name: "Perfect Exposure Every Time",
    desc: "Nail consistent exposure on every shot.",
  },
  {
    pluginId: "film-negative-space-cst-dctl",
    slug: "film-negative-space-cst", color: "cyan",
    name: "Film Negative Space CST",
    desc: "A color-space transform into a film-negative working space.",
  },
  {
    pluginId: "saturation-separator-dctl",
    slug: "saturation-seperator", color: "yellow",
    name: "Saturation Separator",
    desc: "Split saturation from luma for cleaner, more controlled grades.",
  },
  {
    pluginId: "linear-ramp-diagnostic-dctl",
    slug: "linear-ramp", color: "blue",
    name: "Linear Ramp Diagnostic",
    desc: "A diagnostic ramp for checking transforms and response.",
  },
  {
    pluginId: "GE_hue_inspector_dctl",
    slug: "hue-inspector", color: "yellow",
    name: "Hue Inspector",
    desc: "Highlights hue vectors to diagnose skin tones and color balance at a glance.",
  },
  {
    pluginId: "rgb-chips-dctl",
    slug: "rgb-chips", color: "green",
    name: "RGB Chips",
    desc: "RGB parade-style chips overlay for exposure and white balance evaluation.",
  },
  {
    pluginId: "dolby-vision-spoofer-dctl",
    slug: "dolby-vision", color: "magenta",
    name: "Dolby Vision Spoofer",
    desc: "Preview a Dolby Vision-style trim without the full pipeline.",
  },
  {
    pluginId: "ibkeymaster-ofx",
    slug: "ibkeymaster", color: "red",
    name: "IBKeymaster",
    desc: "A focused keying utility for cleaner selections.",
  },
  {
    pluginId: "resolve-node-toggler",
    slug: "node-toggle", color: "green",
    name: "Resolve Node Toggler",
    desc: "Toggle nodes on and off fast while you work.",
  },
];

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
    managerRoot,
    "..",
    "..",
    "dec18studios.github.io",
    "color-grading-tools",
    "tools.json"
  );
  const outputPath = args.output ? path.resolve(args.output) : defaultOutput;

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

    // Read stable.json for description and infoUrl
    const stablePath = path.join(managerRoot, "docs", "plugins", entry.pluginId, "stable.json");
    let stable = null;
    if (fs.existsSync(stablePath)) {
      stable = readJson(stablePath);
    }

    // Config may override color/slug via websiteColor / websiteSlug fields
    const configPath = path.join(managerRoot, "docs", "plugins", entry.pluginId, "manager-release-config.json");
    let config = null;
    if (fs.existsSync(configPath)) {
      config = readJson(configPath);
    }

    // tier and url come from the plugin manager; name/desc/color/slug are curated in WEB_MAP
    const url = stable?.infoUrl ?? config?.infoUrl ?? null;
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
