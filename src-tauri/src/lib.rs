mod home;
mod scan;
mod tags;

use std::sync::OnceLock;
use std::time::Instant;
use tauri::Manager;
use tauri_plugin_fs::FsExt;


static STARTED: OnceLock<Instant> = OnceLock::new();

/// Milliseconds since the process started, so the web side can log how
/// long the listener waited from double-click to a painted shelf.
#[tauri::command]
fn uptime_ms() -> u64 {
    STARTED.get().map(|t| t.elapsed().as_millis() as u64).unwrap_or(0)
}

/// A library folder named on the command line or in RIBBON_LIBRARY, for
/// opening straight into a library without the picker. Used by scripts
/// and timing runs; the remembered root still wins when there is one.
#[tauri::command]
fn env_library() -> Option<String> {
    std::env::args().nth(1).filter(|a| !a.starts_with('-')).or_else(|| std::env::var("RIBBON_LIBRARY").ok()).filter(|s| !s.trim().is_empty())
}

/// Widen the filesystem and asset-protocol scopes to a library folder the
/// user picked. Called once per library; the scope persists for the
/// session. Everything outside stays inaccessible. The folder is not
/// checked here: that would be a network round trip before the first
/// paint, and the scan reports a missing folder itself.
#[tauri::command]
fn allow_library(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let root = std::path::PathBuf::from(&path);
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
    let _ = STARTED.set(Instant::now());
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .invoke_handler(tauri::generate_handler![
            allow_library,
            scan::scan_library,
            scan::extract_cover,
            scan::read_text_dir,
            scan::write_text_files,
            scan::mirror_read,
            scan::mirror_write,
            scan::mirror_covers,
            home::home_info,
            home::remember_library,
            home::forget_library,
            home::reveal_home,
            home::reset_home,
            uptime_ms,
            env_library
        ])
        .plugin(
            // Always on, in every build: the terminal, the webview console,
            // and a file under the Ribbon folder.
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                // lofty warns once per MP3 about estimating duration; not news.
                .level_for("lofty", log::LevelFilter::Error)
                .max_file_size(20 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder { path: home::logs_dir(), file_name: Some("ribbon".into()) }),
                ])
                .build(),
        )
        .setup(|app| {
            log::info!("ribbon starting; home folder {}", home::home_dir().display());
            // Covers are served from the local mirror; a local path canonicalises in microseconds.
            let base = home::mirror_base();
            let _ = std::fs::create_dir_all(&base);
            if let Err(e) = app.asset_protocol_scope().allow_directory(&base, true) {
                log::warn!("could not allow the mirror folder for assets: {e}");
            }
            let _ = app.get_webview_window("main");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
