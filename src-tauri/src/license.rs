use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredLicenseData {
    #[serde(default)]
    pub keys: Vec<String>,
}

pub fn license_path() -> Result<PathBuf> {
    let base = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .ok_or_else(|| anyhow!("Unable to resolve local application data directory"))?;
    Ok(base
        .join("Dec 18 Studios Plugins")
        .join("licenses.json"))
}

pub fn load_licenses() -> Result<StoredLicenseData> {
    let path = license_path()?;
    if !path.exists() {
        return Ok(StoredLicenseData::default());
    }
    let raw =
        fs::read_to_string(&path).with_context(|| format!("Failed to read {}", path.display()))?;
    serde_json::from_str(&raw).context("Failed to parse license JSON")
}

pub fn save_licenses(data: &StoredLicenseData) -> Result<()> {
    let path = license_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create {}", parent.display()))?;
    }
    let raw = serde_json::to_string_pretty(data)?;
    fs::write(&path, raw).with_context(|| format!("Failed to write {}", path.display()))
}

pub fn add_license_key(key: &str) -> Result<StoredLicenseData> {
    let mut data = load_licenses()?;
    let trimmed = key.trim().to_string();
    if !trimmed.is_empty() && !data.keys.contains(&trimmed) {
        data.keys.push(trimmed);
        save_licenses(&data)?;
    }
    Ok(data)
}

pub fn remove_license_key(key: &str) -> Result<StoredLicenseData> {
    let mut data = load_licenses()?;
    data.keys.retain(|k| k != key.trim());
    save_licenses(&data)?;
    Ok(data)
}
