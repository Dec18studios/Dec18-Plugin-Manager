#!/usr/bin/env node
// Catalog drift guard.
//
// There is ONE authoritative tool set: docs/plugins/index.json — the catalog the
// Plugin Manager app loads and installs from. docs/website-tools.json is a pure
// PRESENTATION overlay (name/color/desc/order), keyed by pluginId. The overlay may
// style a tool that exists in the index, but it can never invent or drop one.
//
// This validator enforces that invariant offline (no network), so the website tool
// list can never drift away from what the app actually ships. It is called by
// generate-tools-json.mjs before any tools.json is written, and is wired into the
// Pages deploy workflow as a gate after index.json is regenerated.
//
// Exit code: 0 when the catalog is consistent, 1 when it has drifted.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// Returns { ok, errors[], warnings[], appOnly[], counts } without throwing, so
// callers can format the report however they like.
export function validateCatalog(managerRoot) {
  const root = path.resolve(managerRoot);
  const indexPath = path.join(root, "docs", "plugins", "index.json");
  const webPath = path.join(root, "docs", "website-tools.json");

  const errors = [];
  const warnings = [];

  if (!fs.existsSync(indexPath)) {
    return { ok: false, errors: [`index.json not found: ${indexPath}`], warnings, appOnly: [], counts: {} };
  }
  if (!fs.existsSync(webPath)) {
    return { ok: false, errors: [`website-tools.json not found: ${webPath}`], warnings, appOnly: [], counts: {} };
  }

  const index = readJson(indexPath);
  const plugins = Array.isArray(index) ? index : index.plugins ?? [];
  const indexIds = new Set();
  for (const p of plugins) {
    const id = p.pluginId ?? p.id;
    if (!id) {
      errors.push(`index.json has an entry with no pluginId: ${JSON.stringify(p).slice(0, 80)}…`);
      continue;
    }
    if (indexIds.has(id)) errors.push(`index.json duplicate pluginId: ${id}`);
    indexIds.add(id);
  }

  const web = readJson(webPath);
  if (!Array.isArray(web)) {
    errors.push("website-tools.json must be a JSON array");
    return { ok: false, errors, warnings, appOnly: [], counts: { index: indexIds.size, website: 0 } };
  }

  const REQUIRED = ["pluginId", "name", "slug", "color", "desc"];
  const webIds = new Set();
  for (const w of web) {
    for (const field of REQUIRED) {
      if (w[field] === undefined || w[field] === null || w[field] === "") {
        errors.push(`website-tools.json entry "${w.pluginId ?? "(no pluginId)"}" is missing required field: ${field}`);
      }
    }
    if (!w.pluginId) continue;
    if (webIds.has(w.pluginId)) errors.push(`website-tools.json duplicate pluginId: ${w.pluginId}`);
    webIds.add(w.pluginId);

    // THE DRIFT GUARD: a website tool must correspond to a real managed plugin.
    if (!indexIds.has(w.pluginId)) {
      errors.push(
        `website-tools.json lists "${w.pluginId}" which is NOT a plugin in index.json (drift). ` +
        `Add docs/plugins/${w.pluginId}/manager-release-config.json so the app can install it, ` +
        `or remove the website entry.`
      );
    }
  }

  // Managed plugins with no overlay are intentionally app-only (e.g. an alternate
  // edition). That is allowed — surface it so the gap is auditable, never silent.
  const appOnly = [...indexIds].filter((id) => !webIds.has(id));

  // A website-visible managed plugin with no stable.json can't resolve a download —
  // the members page will fall back to the releases page. Warn, don't fail.
  for (const id of webIds) {
    if (!indexIds.has(id)) continue;
    const stablePath = path.join(root, "docs", "plugins", id, "stable.json");
    if (!fs.existsSync(stablePath)) {
      warnings.push(`${id}: no stable.json — members download falls back to the releases page`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    appOnly,
    counts: { index: indexIds.size, website: webIds.size },
  };
}

function parseArgs(argv) {
  let managerRoot = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--manager-root") managerRoot = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return { managerRoot };
}

function runCli() {
  const { managerRoot } = parseArgs(process.argv.slice(2));
  const r = validateCatalog(managerRoot);

  for (const w of r.warnings) console.warn(`  warn: ${w}`);
  if (r.appOnly.length) {
    console.log(`App-only (in index.json, not shown on website): ${r.appOnly.join(", ")}`);
  }

  if (!r.ok) {
    console.error("\nCatalog drift detected:");
    for (const e of r.errors) console.error(`  ✗ ${e}`);
    console.error(
      `\nindex.json has ${r.counts.index} plugins; website-tools.json overlays ${r.counts.website}.`
    );
    process.exit(1);
  }

  console.log(
    `Catalog OK — ${r.counts.website}/${r.counts.index} plugins shown on the website, ` +
    `${r.appOnly.length} app-only.`
  );
}

// Run as CLI only when invoked directly (not when imported by the generator).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
