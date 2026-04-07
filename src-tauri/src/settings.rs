use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub beta_releases_enabled: bool,
    #[serde(default)]
    pub auto_update_plugins: bool,
    #[serde(default)]
    pub dctl_install_path: Option<String>,
    #[serde(default)]
    pub plugin_install_paths: HashMap<String, String>,
}

pub fn load_settings() -> Result<AppSettings> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }

    let raw =
        fs::read_to_string(&path).with_context(|| format!("Failed to read {}", path.display()))?;
    serde_json::from_str(&raw).context("Failed to parse settings JSON")
}

pub fn save_settings(settings: &AppSettings) -> Result<()> {
    let path = settings_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create {}", parent.display()))?;
    }
    let raw = serde_json::to_string_pretty(settings)?;
    fs::write(&path, raw).with_context(|| format!("Failed to write {}", path.display()))
}

fn settings_path() -> Result<PathBuf> {
    let base = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .ok_or_else(|| anyhow!("Unable to resolve local application data directory"))?;
    let new_path = base.join("Dec 18 Studios Plugins").join("settings.json");
    let legacy_path = base.join("Dec18StudiosPluginManager").join("settings.json");

    if !new_path.exists() && legacy_path.exists() {
        if let Some(parent) = new_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("Failed to create {}", parent.display()))?;
        }
        fs::copy(&legacy_path, &new_path).with_context(|| {
            format!(
                "Failed to migrate settings from {} to {}",
                legacy_path.display(),
                new_path.display()
            )
        })?;
    }

    Ok(new_path)
}
