use crate::installer;
use crate::models::{
    CatalogEntry, DashboardState, ManagerSummary, PlatformPackage, PluginCatalogIndex,
    PluginManifest, PluginRelease, PluginStatus, ResolvedPlugin, VersionOption,
};
use crate::settings;
use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde::de::DeserializeOwned;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const DEFAULT_CATALOG_URL: &str =
    "https://dec18studios.github.io/Dec18-Plugin-Manager/plugins/index.json";

const EMBEDDED_INDEX: &str = include_str!("../../docs/plugins/index.json");
const EMBEDDED_PHOTOCHEMIST: &str = include_str!("../../docs/plugins/photochemist/stable.json");
const EMBEDDED_NODE_TOGGLER: &str = include_str!("../../docs/plugins/resolve-node-toggler/stable.json");
const EMBEDDED_RGB_CHIPS: &str = include_str!("../../docs/plugins/rgb-chips-dctl/stable.json");
const EMBEDDED_DOLBY_SPOOFER: &str = include_str!("../../docs/plugins/dolby-vision-spoofer-dctl/stable.json");
const EMBEDDED_FILM_NEG_CST: &str = include_str!("../../docs/plugins/film-negative-space-cst-dctl/stable.json");
const EMBEDDED_GRAIN_BY_GREG: &str = include_str!("../../docs/plugins/grain-by-greg-dctl/stable.json");
const EMBEDDED_HUE_CONTRAST: &str = include_str!("../../docs/plugins/hue-contrast-compressor-dctl/stable.json");
const EMBEDDED_LINEAR_RAMP: &str = include_str!("../../docs/plugins/linear-ramp-diagnostic-dctl/stable.json");
const EMBEDDED_PERFECT_EXPOSURE: &str = include_str!("../../docs/plugins/perfect-exposure-dctl/stable.json");
const EMBEDDED_SATURATION_SEP: &str = include_str!("../../docs/plugins/saturation-separator-dctl/stable.json");
const EMBEDDED_VOLUME_CURVE: &str = include_str!("../../docs/plugins/volume-curve-dctl/stable.json");
const EMBEDDED_HUE_CONTRAST_OFX: &str = include_str!("../../docs/plugins/hue-contrast-compressor-ofx/stable.json");
const EMBEDDED_TECHNICOLOR_DRT: &str = include_str!("../../docs/plugins/technicolor-drt-ofx/stable.json");

#[derive(Debug, Clone)]
pub struct CatalogBundle {
    pub source: String,
    pub source_label: String,
    pub entries: Vec<CatalogEntry>,
    pub manifests: HashMap<String, PluginManifest>,
}

pub async fn build_dashboard_state() -> Result<DashboardState> {
    let app_settings = settings::load_settings()?;
    let bundle = load_catalog_bundle(app_settings.beta_releases_enabled).await?;
    let install_state = installer::load_install_state()?;
    let manager = ManagerSummary {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: installer::current_platform().to_string(),
        arch: installer::current_arch().to_string(),
        updater_configured: installer::updater_configured(),
        catalog_url: bundle.source_label.clone(),
        beta_releases_enabled: app_settings.beta_releases_enabled,
        auto_update_plugins_enabled: app_settings.auto_update_plugins,
    };

    let plugins = bundle
        .entries
        .iter()
        .filter_map(|entry| {
            let manifest = bundle.manifests.get(&entry.plugin_id)?;
            let package = select_package(&manifest.platforms).ok()?;
            Some(build_plugin_status(
                entry,
                manifest,
                package,
                &install_state,
            ))
        })
        .collect::<Vec<_>>();

    Ok(DashboardState {
        manager,
        catalog_source: bundle.source,
        plugins,
    })
}

pub async fn resolve_plugin(
    plugin_id: &str,
    requested_version: Option<&str>,
) -> Result<ResolvedPlugin> {
    let app_settings = settings::load_settings()?;
    let bundle = load_catalog_bundle(app_settings.beta_releases_enabled).await?;
    let manifest = bundle
        .manifests
        .get(plugin_id)
        .cloned()
        .ok_or_else(|| anyhow!("Plugin manifest not found for `{plugin_id}`"))?;
    let release = resolve_release(&manifest, requested_version)?;
    let package = select_package(&release.platforms)?;
    Ok(ResolvedPlugin {
        manifest,
        version: release.version,
        release_notes_url: release.release_notes_url,
        package,
    })
}

fn build_plugin_status(
    entry: &CatalogEntry,
    manifest: &PluginManifest,
    package: PlatformPackage,
    install_state: &crate::models::ManagedInstallState,
) -> PluginStatus {
    let is_file_browse = package.install_mode == "file-browse";

    // For file-browse plugins, check the user's chosen path from settings, falling
    // back to the manifest default. For bundle plugins, always use the manifest path.
    let effective_install_path = if is_file_browse {
        crate::settings::load_settings()
            .ok()
            .and_then(|s| s.dctl_install_path)
            .unwrap_or_else(|| package.install_path.clone())
    } else {
        package.install_path.clone()
    };

    let target_bundle = PathBuf::from(&effective_install_path).join(&package.bundle_name);
    let installed = target_bundle.exists();
    let install_key = installer::install_key(&entry.plugin_id, &target_bundle);
    let record = install_state.installs.get(&install_key);
    let stamp = installer::read_bundle_install_stamp(&target_bundle)
        .ok()
        .flatten();
    let installed_version = stamp
        .as_ref()
        .map(|item| item.installed_version.clone())
        .or_else(|| record.map(|item| item.installed_version.clone()));
    let managed_install = stamp.is_some() || record.is_some();
    let installed_is_prerelease = installed_version
        .as_ref()
        .map(|current| is_prerelease_like(current))
        .unwrap_or(false);
    let installed_newer_than_manifest = installed
        && managed_install
        && installed_version
            .as_ref()
            .map(|current| version_cmp(current, &manifest.version) == Ordering::Greater)
            .unwrap_or(false);
    let channel_switch_mode = if installed && managed_install {
        determine_channel_switch_mode(installed_version.as_deref(), &manifest.version)
            .map(str::to_string)
    } else {
        None
    };
    let channel_switch_available = channel_switch_mode.is_some();
    let catalog_behind_installed = installed_newer_than_manifest && !installed_is_prerelease;
    let needs_update = installed
        && installed_version
            .as_ref()
            .map(|current| version_cmp(current, &manifest.version) == Ordering::Less)
            .unwrap_or(true);
    let available_versions = version_options(manifest, installed_version.as_deref());

    let status = if !installed {
        "Ready to install".to_string()
    } else if channel_switch_mode.as_deref() == Some("stable_update_available") {
        "Stable update available".to_string()
    } else if channel_switch_mode.as_deref() == Some("return_to_stable") {
        "Beta installed".to_string()
    } else if catalog_behind_installed {
        "Catalog behind".to_string()
    } else if needs_update {
        "Update available".to_string()
    } else if managed_install {
        "Up to date".to_string()
    } else {
        "Unmanaged install".to_string()
    };

    PluginStatus {
        plugin_id: entry.plugin_id.clone(),
        display_name: manifest.display_name.clone(),
        latest_version: manifest.version.clone(),
        installed_version,
        install_path: effective_install_path,
        bundle_name: package.bundle_name.clone(),
        installed,
        managed_install,
        needs_update,
        channel_switch_available,
        channel_switch_mode,
        catalog_behind_installed,
        status,
        release_notes_url: manifest.release_notes_url.clone(),
        release_highlights: manifest.release_highlights.clone(),
        available_versions,
        description: manifest.description.clone(),
        category: entry.category.clone().or_else(|| manifest.category.clone()),
        plugin_type: entry.plugin_type.clone().or_else(|| manifest.plugin_type.clone()),
        tags: manifest.tags.clone(),
        info_url: manifest.info_url.clone(),
        license_tier: entry.license_tier.clone()
            .or_else(|| manifest.license_tier.clone())
            .unwrap_or_else(|| "subscription".to_string()),
        install_mode: package.install_mode.clone(),
    }
}

fn version_cmp(left: &str, right: &str) -> Ordering {
    match (parse_loose_version(left), parse_loose_version(right)) {
        (Some(left), Some(right)) => compare_loose_versions(&left, &right),
        (Some(_), None) => Ordering::Greater,
        (None, Some(_)) => Ordering::Less,
        (None, None) => left.cmp(right),
    }
}

pub fn select_package(packages: &[PlatformPackage]) -> Result<PlatformPackage> {
    let platform = installer::current_platform();
    let arch = installer::current_arch();

    let mut exact = None;
    let mut universal = None;

    for package in packages {
        if package.platform != platform {
            continue;
        }
        if package.arch == arch {
            exact = Some(package.clone());
            break;
        }
        if package.arch == "universal" {
            universal = Some(package.clone());
        }
    }

    exact
        .or(universal)
        .ok_or_else(|| anyhow!("No supported package found for {} / {}", platform, arch))
}

fn version_options(
    manifest: &PluginManifest,
    installed_version: Option<&str>,
) -> Vec<VersionOption> {
    let mut releases = collect_releases(manifest);
    releases.retain(|release| select_package(&release.platforms).is_ok());
    releases.sort_by(|left, right| version_cmp(&right.version, &left.version));

    let mut options = Vec::new();
    for release in releases {
        let version = release.version.clone();
        let is_current_latest = version == manifest.version;
        let is_installed = installed_version == Some(version.as_str());
        let label = if is_current_latest && is_installed {
            format!("{} (Latest installed)", version)
        } else if is_current_latest {
            format!("{} (Latest)", version)
        } else if is_installed {
            format!("{} (Installed)", version)
        } else {
            version.clone()
        };
        let action_label = version_option_action_label(
            &version,
            &manifest.version,
            installed_version,
            is_current_latest,
        );
        options.push(VersionOption {
            version,
            label,
            release_date: release.release_date,
            release_notes_url: release.release_notes_url,
            release_highlights: release.release_highlights.clone(),
            is_current_latest,
            is_installed,
            action_label,
        });
    }
    options
}

fn determine_channel_switch_mode(
    installed_version: Option<&str>,
    latest_version: &str,
) -> Option<&'static str> {
    let current = installed_version?;
    if !is_prerelease_like(current) || is_prerelease_like(latest_version) {
        return None;
    }

    match version_cmp(current, latest_version) {
        Ordering::Greater => Some("return_to_stable"),
        Ordering::Less => Some("stable_update_available"),
        Ordering::Equal => Some("return_to_stable"),
    }
}

fn version_option_action_label(
    version: &str,
    latest_version: &str,
    installed_version: Option<&str>,
    is_current_latest: bool,
) -> String {
    let installed_newer_than_target = installed_version
        .map(|current| version_cmp(current, latest_version) == Ordering::Greater)
        .unwrap_or(false);
    let installed_is_prerelease = installed_version.map(is_prerelease_like).unwrap_or(false);
    let latest_is_prerelease = is_prerelease_like(latest_version);
    let version_is_prerelease = is_prerelease_like(version);

    match installed_version {
        Some(current) if current == version => "Reinstall this version".to_string(),
        Some(current) if installed_is_prerelease && !latest_is_prerelease && is_current_latest => {
            match version_cmp(version, current) {
                Ordering::Greater | Ordering::Equal => "Install latest stable".to_string(),
                Ordering::Less => "Return to stable".to_string(),
            }
        }
        Some(_) if installed_is_prerelease && !latest_is_prerelease => {
            "Install selected stable".to_string()
        }
        Some(current) if installed_is_prerelease && version_is_prerelease => {
            match version_cmp(version, current) {
                Ordering::Greater => {
                    if is_current_latest {
                        "Install latest beta".to_string()
                    } else {
                        "Install selected beta".to_string()
                    }
                }
                Ordering::Less => "Roll back to selected beta".to_string(),
                Ordering::Equal => "Install selected beta".to_string(),
            }
        }
        Some(_) if installed_is_prerelease => "Install selected stable".to_string(),
        Some(_) if installed_newer_than_target && is_current_latest => {
            "Return to stable".to_string()
        }
        Some(_) if installed_newer_than_target => "Install selected version".to_string(),
        Some(current) => match version_cmp(version, current) {
            Ordering::Greater => "Install selected upgrade".to_string(),
            Ordering::Less => "Roll back to selected".to_string(),
            Ordering::Equal => "Install selected".to_string(),
        },
        None => "Install selected".to_string(),
    }
}

fn is_prerelease_like(version: &str) -> bool {
    if let Some(parsed) = parse_loose_version(version) {
        return parsed.prerelease.is_some();
    }

    let lowered = version.to_ascii_lowercase();
    ["beta", "alpha", "preview", "rc", "pre"]
        .iter()
        .any(|token| lowered.contains(token))
}

#[derive(Debug, Clone)]
struct LooseVersion {
    core: Vec<u64>,
    prerelease: Option<LoosePrerelease>,
}

#[derive(Debug, Clone)]
struct LoosePrerelease {
    label_rank: u8,
    label: String,
    number: Option<u64>,
}

fn parse_loose_version(raw: &str) -> Option<LooseVersion> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut numeric_parts = Vec::new();
    let mut current = String::new();
    let mut prerelease_start = None;
    let chars: Vec<char> = trimmed.chars().collect();

    for (index, ch) in chars.iter().enumerate() {
        if ch.is_ascii_digit() {
            current.push(*ch);
            continue;
        }

        if *ch == '.' {
            if current.is_empty() {
                return None;
            }
            numeric_parts.push(current.parse::<u64>().ok()?);
            current.clear();
            continue;
        }

        prerelease_start = Some(index);
        break;
    }

    if !current.is_empty() {
        numeric_parts.push(current.parse::<u64>().ok()?);
    }

    if numeric_parts.is_empty() {
        return None;
    }

    while numeric_parts.len() < 3 {
        numeric_parts.push(0);
    }

    let prerelease =
        prerelease_start.and_then(|index| parse_prerelease_fragment(&trimmed[index..]));

    Some(LooseVersion {
        core: numeric_parts,
        prerelease,
    })
}

fn parse_prerelease_fragment(raw: &str) -> Option<LoosePrerelease> {
    let normalized = raw
        .trim()
        .trim_start_matches(['-', '_', '.', ' '])
        .to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }

    let split_index = normalized
        .find(|ch: char| ch.is_ascii_digit())
        .unwrap_or(normalized.len());
    let label = normalized[..split_index]
        .trim_matches(['-', '_', '.', ' '])
        .to_string();
    let number = normalized[split_index..]
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect::<String>();

    let label_rank = match label.as_str() {
        "alpha" => 0,
        "beta" => 1,
        "preview" => 2,
        "pre" => 3,
        "rc" => 4,
        _ => 5,
    };

    Some(LoosePrerelease {
        label_rank,
        label,
        number: if number.is_empty() {
            None
        } else {
            number.parse::<u64>().ok()
        },
    })
}

fn compare_loose_versions(left: &LooseVersion, right: &LooseVersion) -> Ordering {
    let core_len = left.core.len().max(right.core.len());
    for index in 0..core_len {
        let left_part = *left.core.get(index).unwrap_or(&0);
        let right_part = *right.core.get(index).unwrap_or(&0);
        match left_part.cmp(&right_part) {
            Ordering::Equal => {}
            ordering => return ordering,
        }
    }

    match (&left.prerelease, &right.prerelease) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(left_pre), Some(right_pre)) => match left_pre.label_rank.cmp(&right_pre.label_rank) {
            Ordering::Equal => match left_pre.label.cmp(&right_pre.label) {
                Ordering::Equal => left_pre
                    .number
                    .unwrap_or(0)
                    .cmp(&right_pre.number.unwrap_or(0)),
                ordering => ordering,
            },
            ordering => ordering,
        },
    }
}

fn collect_releases(manifest: &PluginManifest) -> Vec<PluginRelease> {
    let mut releases = Vec::with_capacity(1 + manifest.available_versions.len());
    releases.push(PluginRelease {
        version: manifest.version.clone(),
        release_date: manifest.release_date.clone(),
        release_notes_url: manifest.release_notes_url.clone(),
        release_highlights: manifest.release_highlights.clone(),
        platforms: manifest.platforms.clone(),
    });

    for release in &manifest.available_versions {
        if releases.iter().any(|item| item.version == release.version) {
            continue;
        }
        releases.push(release.clone());
    }
    releases
}

fn resolve_release(
    manifest: &PluginManifest,
    requested_version: Option<&str>,
) -> Result<PluginRelease> {
    let releases = collect_releases(manifest);
    if let Some(version) = requested_version {
        return releases
            .into_iter()
            .find(|release| release.version == version)
            .ok_or_else(|| anyhow!("Plugin version `{version}` was not found in the manifest"));
    }

    Ok(releases
        .into_iter()
        .find(|release| release.version == manifest.version)
        .ok_or_else(|| anyhow!("Latest plugin version was not found in the manifest"))?)
}

async fn load_catalog_bundle(prefer_beta: bool) -> Result<CatalogBundle> {
    if cfg!(debug_assertions) {
        if let Some(bundle) = load_local_dev_catalog()? {
            return Ok(bundle);
        }
    }

    let client = Client::builder()
        .user_agent("Dec18StudiosPlugins/0.1.0")
        .build()
        .context("Failed to create HTTP client")?;

    let (index, source) = match fetch_json::<PluginCatalogIndex>(&client, DEFAULT_CATALOG_URL).await
    {
        Ok(index) => (index, "remote".to_string()),
        Err(_) => (
            serde_json::from_str(EMBEDDED_INDEX)?,
            "embedded".to_string(),
        ),
    };

    let mut manifests = HashMap::new();
    for entry in &index.plugins {
        let manifest = load_manifest_for_entry(&client, entry, prefer_beta).await?;
        manifests.insert(entry.plugin_id.clone(), manifest);
    }

    Ok(CatalogBundle {
        source,
        source_label: DEFAULT_CATALOG_URL.to_string(),
        entries: index.plugins,
        manifests,
    })
}

async fn load_manifest_for_entry(
    client: &Client,
    entry: &CatalogEntry,
    prefer_beta: bool,
) -> Result<PluginManifest> {
    let stable_manifest = match fetch_json::<PluginManifest>(client, &entry.manifest_url).await {
        Ok(value) => value,
        Err(_) => embedded_manifest(&entry.plugin_id)?,
    };

    if prefer_beta {
        if let Some(beta_url) = beta_manifest_url(&entry.manifest_url) {
            if let Ok(beta_manifest) = fetch_json::<PluginManifest>(client, &beta_url).await {
                if version_cmp(&beta_manifest.version, &stable_manifest.version)
                    == Ordering::Greater
                {
                    return Ok(merge_beta_manifest(stable_manifest, beta_manifest));
                }
            }
        }
    }

    Ok(stable_manifest)
}

fn merge_beta_manifest(
    stable_manifest: PluginManifest,
    mut beta_manifest: PluginManifest,
) -> PluginManifest {
    let mut merged_versions = Vec::with_capacity(
        1 + stable_manifest.available_versions.len() + beta_manifest.available_versions.len(),
    );

    merged_versions.push(PluginRelease {
        version: stable_manifest.version.clone(),
        release_date: stable_manifest.release_date.clone(),
        release_notes_url: stable_manifest.release_notes_url.clone(),
        release_highlights: stable_manifest.release_highlights.clone(),
        platforms: stable_manifest.platforms.clone(),
    });

    for release in stable_manifest
        .available_versions
        .into_iter()
        .chain(beta_manifest.available_versions.into_iter())
    {
        if merged_versions
            .iter()
            .any(|item| item.version == release.version)
        {
            continue;
        }
        merged_versions.push(release);
    }

    beta_manifest.available_versions = merged_versions;
    beta_manifest
}

fn load_local_dev_catalog() -> Result<Option<CatalogBundle>> {
    let manager_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| anyhow!("Unable to resolve manager root"))?;
    let dev_index_path = manager_root
        .join("docs")
        .join("plugins")
        .join("dev")
        .join("index.json");
    if !dev_index_path.exists() {
        return Ok(None);
    }

    let raw_index = fs::read_to_string(&dev_index_path)
        .with_context(|| format!("Failed to read {}", dev_index_path.display()))?;
    let expanded_index = expand_tokens(&raw_index)?;
    let index: PluginCatalogIndex = serde_json::from_str(&expanded_index)
        .with_context(|| format!("Failed to parse {}", dev_index_path.display()))?;
    let mut manifests = HashMap::new();
    for entry in &index.plugins {
        let manifest_path = resolve_manifest_path(&entry.manifest_url, manager_root)?;
        let raw_manifest = fs::read_to_string(&manifest_path)
            .with_context(|| format!("Failed to read {}", manifest_path.display()))?;
        let expanded = expand_tokens(&raw_manifest)?;
        let manifest: PluginManifest = serde_json::from_str(&expanded)
            .with_context(|| format!("Failed to parse {}", manifest_path.display()))?;
        manifests.insert(entry.plugin_id.clone(), manifest);
    }

    Ok(Some(CatalogBundle {
        source: "local-dev".to_string(),
        source_label: dev_index_path.display().to_string(),
        entries: index.plugins,
        manifests,
    }))
}

async fn fetch_json<T>(client: &Client, url: &str) -> Result<T>
where
    T: DeserializeOwned,
{
    if let Some(local_path) = resolve_local_path(url) {
        let raw = fs::read_to_string(&local_path)
            .with_context(|| format!("Failed to read {}", local_path.display()))?;
        return serde_json::from_str(&raw)
            .with_context(|| format!("Failed to parse JSON from {}", local_path.display()));
    }

    let response = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("Failed to fetch {url}"))?
        .error_for_status()
        .with_context(|| format!("Unexpected response while fetching {url}"))?;

    response
        .json::<T>()
        .await
        .with_context(|| format!("Failed to parse JSON from {url}"))
}

fn embedded_manifest(plugin_id: &str) -> Result<PluginManifest> {
    let raw = match plugin_id {
        "photochemist" => EMBEDDED_PHOTOCHEMIST,
        "resolve-node-toggler" => EMBEDDED_NODE_TOGGLER,
        "rgb-chips-dctl" => EMBEDDED_RGB_CHIPS,
        "dolby-vision-spoofer-dctl" => EMBEDDED_DOLBY_SPOOFER,
        "film-negative-space-cst-dctl" => EMBEDDED_FILM_NEG_CST,
        "grain-by-greg-dctl" => EMBEDDED_GRAIN_BY_GREG,
        "hue-contrast-compressor-dctl" => EMBEDDED_HUE_CONTRAST,
        "linear-ramp-diagnostic-dctl" => EMBEDDED_LINEAR_RAMP,
        "perfect-exposure-dctl" => EMBEDDED_PERFECT_EXPOSURE,
        "saturation-separator-dctl" => EMBEDDED_SATURATION_SEP,
        "volume-curve-dctl" => EMBEDDED_VOLUME_CURVE,
        "hue-contrast-compressor-ofx" => EMBEDDED_HUE_CONTRAST_OFX,
        "technicolor-drt-ofx" => EMBEDDED_TECHNICOLOR_DRT,
        _ => return Err(anyhow!("No embedded manifest available for `{plugin_id}`")),
    };
    serde_json::from_str(raw)
        .with_context(|| format!("Failed to parse embedded manifest for {plugin_id}"))
}

fn expand_tokens(raw: &str) -> Result<String> {
    let manager_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| anyhow!("Unable to resolve manager root"))?;
    let git_root = manager_root
        .parent()
        .ok_or_else(|| anyhow!("Unable to resolve GitHub root"))?;
    let ofx_builds_root = git_root.join("Private-OFX-Builds");

    let mut expanded = raw.to_string();
    let mappings = [
        ("${D18PM_MANAGER_ROOT}", manager_root.display().to_string()),
        (
            "${OFX_BUILDS_ROOT}",
            ofx_builds_root.display().to_string(),
        ),
    ];
    for (token, replacement) in mappings {
        expanded = expanded.replace(token, &replacement.replace('\\', "\\\\"));
    }
    Ok(expanded)
}

fn resolve_manifest_path(raw: &str, manager_root: &Path) -> Result<PathBuf> {
    let expanded = expand_tokens(raw)?;
    if let Some(local_path) = resolve_local_path(&expanded) {
        return Ok(local_path);
    }

    Ok(manager_root.join(normalize_path_text(&expanded)))
}

fn resolve_local_path(raw: &str) -> Option<PathBuf> {
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return None;
    }
    if let Some(stripped) = raw.strip_prefix("file:///") {
        return Some(PathBuf::from(normalize_file_uri_path(stripped)));
    }
    if raw.starts_with('/') || raw.starts_with('\\') {
        return Some(PathBuf::from(normalize_path_text(raw)));
    }
    if cfg!(windows) && raw.contains(':') {
        return Some(PathBuf::from(normalize_path_text(raw)));
    }
    None
}

fn normalize_file_uri_path(raw: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        raw.replace('/', "\\")
    }

    #[cfg(not(target_os = "windows"))]
    {
        raw.to_string()
    }
}

fn normalize_path_text(raw: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        raw.replace('/', "\\")
    }

    #[cfg(not(target_os = "windows"))]
    {
        raw.replace('\\', "/")
    }
}

fn beta_manifest_url(raw: &str) -> Option<String> {
    raw.strip_suffix("/stable.json")
        .map(|base| format!("{base}/beta.json"))
        .or_else(|| {
            raw.strip_suffix("\\stable.json")
                .map(|base| format!("{base}\\beta.json"))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_package() -> PlatformPackage {
        PlatformPackage {
            platform: installer::current_platform().to_string(),
            arch: installer::current_arch().to_string(),
            download_url: "https://example.com/plugin.zip".to_string(),
            sha256: "deadbeef".to_string(),
            package_type: "zip".to_string(),
            bundle_name: "Example.ofx.bundle".to_string(),
            bundle_identifier: "com.example.Plugin".to_string(),
            install_path: "C:\\Test\\Plugins".to_string(),
            min_manager_version: "0.1.0".to_string(),
            host_processes: Vec::new(),
        }
    }

    fn test_release(version: &str) -> PluginRelease {
        PluginRelease {
            version: version.to_string(),
            release_date: "2026-03-30T00:00:00Z".to_string(),
            release_notes_url: format!("https://example.com/releases/{version}"),
            release_highlights: None,
            platforms: vec![test_package()],
        }
    }

    fn test_manifest(version: &str, available_versions: &[&str]) -> PluginManifest {
        PluginManifest {
            plugin_id: "example-plugin".to_string(),
            display_name: "Example Plugin".to_string(),
            version: version.to_string(),
            release_date: "2026-03-30T00:00:00Z".to_string(),
            release_notes_url: format!("https://example.com/releases/{version}"),
            release_highlights: None,
            platforms: vec![test_package()],
            available_versions: available_versions
                .iter()
                .map(|version| test_release(version))
                .collect(),
        }
    }

    #[test]
    fn beta_target_does_not_trigger_stable_channel_switch() {
        assert_eq!(
            determine_channel_switch_mode(Some("1.0.5Beta"), "1.0.6Beta"),
            None
        );
    }

    #[test]
    fn stable_target_keeps_beta_return_to_stable_guidance() {
        assert_eq!(
            determine_channel_switch_mode(Some("1.0.7Beta"), "1.0.6"),
            Some("return_to_stable")
        );
        assert_eq!(
            determine_channel_switch_mode(Some("1.0.5Beta"), "1.0.6"),
            Some("stable_update_available")
        );
    }

    #[test]
    fn beta_manifest_labels_latest_beta_as_beta() {
        let manifest = test_manifest("1.0.6Beta", &["1.0.2", "1.0.5Beta"]);
        let options = version_options(&manifest, Some("1.0.5Beta"));
        let latest = options
            .iter()
            .find(|option| option.version == "1.0.6Beta")
            .unwrap();
        let stable = options
            .iter()
            .find(|option| option.version == "1.0.2")
            .unwrap();

        assert_eq!(latest.action_label, "Install latest beta");
        assert_eq!(stable.action_label, "Install selected stable");
    }

    #[test]
    fn stable_manifest_labels_latest_release_as_stable_for_beta_installs() {
        let manifest = test_manifest("1.0.6", &["1.0.2"]);
        let options = version_options(&manifest, Some("1.0.5Beta"));
        let latest = options
            .iter()
            .find(|option| option.version == "1.0.6")
            .unwrap();

        assert_eq!(latest.action_label, "Install latest stable");
    }
}
