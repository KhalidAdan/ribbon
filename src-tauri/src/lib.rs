pub mod ebook;
pub mod frames;
pub mod speech;
mod home;
mod online;
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
/// On an iPhone, the app's own Documents folder.
#[tauri::command]
fn env_library() -> Option<String> {
    let named = std::env::args().nth(1).filter(|a| !a.starts_with('-')).or_else(|| std::env::var("RIBBON_LIBRARY").ok()).filter(|s| !s.trim().is_empty());
    #[cfg(target_os = "ios")]
    let named = named.or_else(ios_library);
    named
}

/// The app's Documents folder, which the Files app shows as On My iPhone ›
/// Ribbon (Info.ios.plist): books copied there are on the shelf. HOME is
/// the app's container on iOS. Made on first launch.
#[cfg(target_os = "ios")]
fn ios_library() -> Option<String> {
    let dir = std::path::PathBuf::from(std::env::var_os("HOME")?).join("Documents");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.to_string_lossy().into_owned())
}

/// Widen the filesystem and asset-protocol scopes to a library folder the
/// user picked. Called once per library; the scope persists for the
/// session. Everything outside stays inaccessible. The folder is not
/// checked here: that would be a network round trip before the first
/// paint, and the scan reports a missing folder itself.
///
/// The records folder is allowed by name. On macOS and Linux, Tauri's `**`
/// does not reach into folders whose names start with a dot, so `.ribbon/`
/// (and `.odio/`, its name before the rename) would stay closed there; a
/// pattern that spells the name out matches on every system.
#[tauri::command]
fn allow_library(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let root = std::path::PathBuf::from(&path);
    for dir in [root.join(scan::RIBBON_DIR), root.join(scan::LEGACY_DIR), root] {
        app.fs_scope()
            .allow_directory(&dir, true)
            .map_err(|e| e.to_string())?;
        app.asset_protocol_scope()
            .allow_directory(&dir, true)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// An app opened from the Dock or Finder on macOS gets only the system's PATH, not the
/// shell's: ffmpeg and ffprobe installed by Homebrew would not be found. Their usual
/// folders go on the end of it, before anything is started.
#[cfg(target_os = "macos")]
fn find_homebrew_tools() {
    let path = std::env::var("PATH").unwrap_or_default();
    let mut dirs: Vec<&str> = path.split(':').filter(|d| !d.is_empty()).collect();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin"] {
        if !dirs.contains(&extra) && std::path::Path::new(extra).is_dir() {
            dirs.push(extra);
        }
    }
    std::env::set_var("PATH", dirs.join(":"));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = STARTED.set(Instant::now());
    #[cfg(target_os = "macos")]
    find_homebrew_tools();
    tauri::Builder::default()
        // MP3s served from an exact frame, for seeks the webview would otherwise guess (frames.rs).
        .register_asynchronous_uri_scheme_protocol("ribbonmp3", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || responder.respond(frames::respond(&app, request)));
        })
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
            home::sources_read,
            home::sources_write,
            home::reveal_home,
            home::reset_home,
            home::app_settings_read,
            home::app_settings_write,
            online::catalog_search,
            ebook::ebook_open,
            ebook::export::ebook_export,
            speech::speech_openings,
            speech::speech_transcribe,
            frames::audio_prepare,
            speech::speech_download_model,
            speech::speech_model_ok,
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
