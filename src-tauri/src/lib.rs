mod catalog;
mod installer;
mod license;
mod models;
mod settings;

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
async fn dashboard_state() -> Result<models::DashboardState, String> {
    catalog::build_dashboard_state()
        .await
        .map_err(|error| models::UiError::from_error("dashboard", &error).to_json_string())
}

#[tauri::command]
async fn apply_plugin_action(
    plugin_id: String,
    action: String,
    target_version: Option<String>,
) -> Result<models::PluginOperationResult, String> {
    installer::apply_plugin_action(&plugin_id, &action, target_version.as_deref())
        .await
        .map_err(|error| models::UiError::from_error("plugin_action", &error).to_json_string())
}

#[tauri::command]
async fn set_beta_releases_enabled(enabled: bool) -> Result<(), String> {
    let mut current = settings::load_settings()
        .map_err(|error| models::UiError::from_error("settings", &error).to_json_string())?;
    current.beta_releases_enabled = enabled;
    settings::save_settings(&current)
        .map_err(|error| models::UiError::from_error("settings", &error).to_json_string())
}

#[tauri::command]
async fn get_stored_license_keys() -> Result<Vec<String>, String> {
    let data = license::load_licenses()
        .map_err(|error| models::UiError::from_error("license", &error).to_json_string())?;
    Ok(data.keys)
}

#[tauri::command]
async fn save_license_key(key: String) -> Result<Vec<String>, String> {
    let data = license::add_license_key(&key)
        .map_err(|error| models::UiError::from_error("license", &error).to_json_string())?;
    Ok(data.keys)
}

#[tauri::command]
async fn remove_license_key(key: String) -> Result<Vec<String>, String> {
    let data = license::remove_license_key(&key)
        .map_err(|error| models::UiError::from_error("license", &error).to_json_string())?;
    Ok(data.keys)
}

#[tauri::command]
async fn get_dctl_install_path() -> Result<Option<String>, String> {
    let current = settings::load_settings()
        .map_err(|error| models::UiError::from_error("settings", &error).to_json_string())?;
    Ok(current.dctl_install_path)
}

#[tauri::command]
async fn set_dctl_install_path(path: String) -> Result<(), String> {
    let mut current = settings::load_settings()
        .map_err(|error| models::UiError::from_error("settings", &error).to_json_string())?;
    current.dctl_install_path = Some(path);
    settings::save_settings(&current)
        .map_err(|error| models::UiError::from_error("settings", &error).to_json_string())
}

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle, start_path: Option<String>) -> Result<Option<String>, String> {
    let mut builder = app.dialog().file();
    if let Some(ref start) = start_path {
        builder = builder.set_directory(start);
    }
    let selected = builder.blocking_pick_folder();
    Ok(selected.map(|p| p.to_string()))
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin({
            let updater = tauri_plugin_updater::Builder::new();
            #[cfg(target_os = "macos")]
            let updater = updater.target("darwin-universal");
            updater.build()
        });

    builder
        .invoke_handler(tauri::generate_handler![
            dashboard_state,
            apply_plugin_action,
            set_beta_releases_enabled,
            get_stored_license_keys,
            save_license_key,
            remove_license_key,
            get_dctl_install_path,
            set_dctl_install_path,
            pick_folder
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.show()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Dec 18 Studios Plugins");
}
