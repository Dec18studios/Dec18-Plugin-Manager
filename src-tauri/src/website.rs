use crate::models::WebsiteTool;
use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn manager_root() -> Result<PathBuf> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Cannot resolve manager root from CARGO_MANIFEST_DIR"))
        .map(|p| p.to_path_buf())
}

fn website_tools_path() -> Result<PathBuf> {
    Ok(manager_root()?.join("docs").join("website-tools.json"))
}

fn pages_root() -> Result<PathBuf> {
    // Manager root: .../Other Scripts/Dec18-Plugin-Manager
    // Pages root:   .../dec18studios.github.io  (sibling of "Other Scripts")
    let root = manager_root()?;
    let server_sync = root
        .parent() // Other Scripts
        .and_then(|p| p.parent()) // Server Sync Files
        .ok_or_else(|| anyhow::anyhow!("Cannot resolve pages root from manager root"))?;
    Ok(server_sync.join("dec18studios.github.io"))
}

pub fn load_website_tools() -> Result<Vec<WebsiteTool>> {
    let path = website_tools_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read {}", path.display()))?;
    serde_json::from_str(&raw).context("Failed to parse website-tools.json")
}

pub fn save_website_tools(tools: &[WebsiteTool]) -> Result<()> {
    let path = website_tools_path()?;
    let raw = serde_json::to_string_pretty(tools)?;
    fs::write(&path, format!("{raw}\n"))
        .with_context(|| format!("Failed to write {}", path.display()))
}

pub fn publish_website_tools(tools: &[WebsiteTool]) -> Result<String> {
    save_website_tools(tools)?;

    let root = manager_root()?;
    let pages = pages_root()?;

    if !pages.exists() {
        anyhow::bail!(
            "GitHub Pages repo not found at {}. Clone dec18studios.github.io alongside this repo first.",
            pages.display()
        );
    }

    let output = pages.join("color-grading-tools").join("tools.json");

    // Run the generate script to build tools.json from website-tools.json + plugin manifests
    let gen = Command::new("node")
        .arg("tools/generate-tools-json.mjs")
        .arg("--manager-root")
        .arg(".")
        .arg("--output")
        .arg(&output)
        .current_dir(&root)
        .output()
        .context("Failed to run generate-tools-json.mjs — is node on PATH?")?;

    if !gen.status.success() {
        let stderr = String::from_utf8_lossy(&gen.stderr);
        let stdout = String::from_utf8_lossy(&gen.stdout);
        anyhow::bail!("Generate script failed:\n{stdout}{stderr}");
    }

    // Stage tools.json in the pages repo
    run_git(&pages, &["add", "color-grading-tools/tools.json"])?;

    // Commit — exits non-zero when nothing changed, which is fine
    let commit = Command::new("git")
        .args(["commit", "-m", "Update tools listing from plugin manager"])
        .current_dir(&pages)
        .output()
        .context("Failed to run git commit")?;

    if commit.status.success() {
        run_git(&pages, &["push"])?;
        Ok("Website updated and pushed to GitHub.".to_string())
    } else {
        let stderr = String::from_utf8_lossy(&commit.stderr);
        // "nothing to commit" is not an error
        if stderr.contains("nothing to commit") || String::from_utf8_lossy(&commit.stdout).contains("nothing to commit") {
            Ok("No changes — tools.json is already up to date.".to_string())
        } else {
            anyhow::bail!("git commit failed: {stderr}");
        }
    }
}

fn run_git(dir: &Path, args: &[&str]) -> Result<()> {
    let result = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .with_context(|| format!("Failed to run: git {}", args.join(" ")))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        anyhow::bail!("git {} failed: {stderr}", args.join(" "));
    }
    Ok(())
}
