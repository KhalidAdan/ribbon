mod scan;

use tauri::Manager;
use tauri_plugin_fs::FsExt;

/// Widen the filesystem and asset-protocol scopes to a library folder the
/// user picked. Called once per library; the scope persists for the
/// session. Everything outside stays inaccessible.
#[tauri::command]
fn allow_library(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let root = std::path::PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    app.fs_scope()
        .allow_directory(&root, true)
        .map_err(|e| e.to_string())?;
    app.asset_protocol_scope()
        .allow_directory(&root, true)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .invoke_handler(tauri::generate_handler![allow_library, scan::scan_library, scan::read_text_dir])
        .plugin(
            // Always on, in every build: the terminal, the webview console,
            // and a file under the app's log directory.
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: Some("odio".into()) }),
                ])
                .build(),
        )
        .setup(|app| {
            let dir = app.path().app_log_dir().map(|p| p.display().to_string()).unwrap_or_default();
            log::info!("odio starting; log directory {dir}");
            let _ = app.get_webview_window("main");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
