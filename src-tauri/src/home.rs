//! The one folder Ribbon owns on this machine: `%LOCALAPPDATA%\Ribbon` on
//! Windows (or `RIBBON_HOME`), holding the mirror of every library's
//! records and covers, the logs, and the registry of libraries opened
//! here. Records beside the books stay the truth and travel with them;
//! this folder is what the app needs to open fast and to remember you.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Where Ribbon keeps its own files. Computable before the app exists,
/// because the log plugin needs it first.
pub fn home_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("RIBBON_HOME") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }
    let base = if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library").join("Application Support"))
    } else {
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share")))
    };
    base.unwrap_or_else(std::env::temp_dir).join("Ribbon")
}

pub fn mirror_base() -> PathBuf {
    home_dir().join("mirror")
}

pub fn logs_dir() -> PathBuf {
    home_dir().join("logs")
}

fn registry_path() -> PathBuf {
    home_dir().join("libraries.tsv")
}

/// A library opened on this machine. Tab-separated on disk: paths hold
/// commas and quotes, never tabs or newlines.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub root: String,
    /// ISO 8601.
    pub last_opened: String,
}

fn read_registry() -> Vec<LibraryEntry> {
    let Ok(text) = std::fs::read_to_string(registry_path()) else { return Vec::new() };
    text.lines()
        .filter_map(|line| {
            let (last_opened, root) = line.split_once('\t')?;
            (!root.trim().is_empty()).then(|| LibraryEntry { root: root.trim().to_string(), last_opened: last_opened.trim().to_string() })
        })
        .collect()
}

fn write_registry(entries: &[LibraryEntry]) -> Result<(), String> {
    let dir = home_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let body: String = entries.iter().map(|e| format!("{}\t{}\n", e.last_opened, e.root)).collect();
    let tmp = dir.join("libraries.tsv.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, registry_path()).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeInfo {
    pub path: String,
    pub libraries: Vec<LibraryEntry>,
}

/// The folder and the libraries opened here, most recent first.
#[tauri::command]
pub fn home_info() -> HomeInfo {
    let mut libraries = read_registry();
    libraries.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
    HomeInfo { path: home_dir().display().to_string(), libraries }
}

/// Record that a library was opened now; it becomes the one to reopen.
#[tauri::command]
pub fn remember_library(root: String) -> Result<(), String> {
    let now = chrono_now();
    let mut entries: Vec<LibraryEntry> = read_registry().into_iter().filter(|e| !same_root(&e.root, &root)).collect();
    entries.push(LibraryEntry { root, last_opened: now });
    write_registry(&entries)
}

/// Drop a library from the registry; the next launch shows the picker.
#[tauri::command]
pub fn forget_library(root: String) -> Result<(), String> {
    let entries: Vec<LibraryEntry> = read_registry().into_iter().filter(|e| !same_root(&e.root, &root)).collect();
    write_registry(&entries)
}

fn settings_path() -> PathBuf {
    home_dir().join("settings.json")
}

/// App-level settings (not per book, not per library): a JSON object.
#[tauri::command]
pub fn app_settings_read() -> serde_json::Value {
    std::fs::read_to_string(settings_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| serde_json::json!({}))
}

#[tauri::command]
pub fn app_settings_write(settings: serde_json::Value) -> Result<(), String> {
    let dir = home_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join("settings.json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, settings_path()).map_err(|e| e.to_string())
}

/// Open the folder in the system file browser.
#[tauri::command]
pub fn reveal_home() -> Result<(), String> {
    let dir = home_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let (cmd, arg) = if cfg!(target_os = "windows") {
        ("explorer", dir.display().to_string())
    } else if cfg!(target_os = "macos") {
        ("open", dir.display().to_string())
    } else {
        ("xdg-open", dir.display().to_string())
    };
    std::process::Command::new(cmd).arg(arg).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Remove the mirror and the registry. Logs stay; nothing beside the
/// books is touched. The next open is a first-ever open again.
#[tauri::command]
pub fn reset_home() -> Result<(), String> {
    let mirror = mirror_base();
    if mirror.is_dir() {
        std::fs::remove_dir_all(&mirror).map_err(|e| e.to_string())?;
    }
    let reg = registry_path();
    if reg.is_file() {
        std::fs::remove_file(&reg).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn same_root(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
    norm(a) == norm(b)
}

/// ISO 8601 UTC without pulling in a date crate: the registry only sorts by it.
fn chrono_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // Civil-from-days (Howard Hinnant), enough for a sortable timestamp.
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_iso_and_sortable() {
        let t = chrono_now();
        assert_eq!(t.len(), 20, "{t}");
        assert!(t.starts_with("20"));
        assert!(t.ends_with('Z'));
    }

    #[test]
    fn roots_compare_without_case_or_slash_noise() {
        assert!(same_root("\\\\nas\\media\\Books\\", "//nas/media/books"));
        assert!(!same_root("E:/a", "E:/b"));
    }
}
