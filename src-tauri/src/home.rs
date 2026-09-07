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

fn sources_path() -> PathBuf {
    home_dir().join("sources.tsv")
}

/// Lines of `stamp<TAB>path`; blank paths are skipped.
fn parse_tsv(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let (stamp, path) = line.split_once('\t')?;
            (!path.trim().is_empty()).then(|| (stamp.trim().to_string(), path.trim().to_string()))
        })
        .collect()
}

fn write_tsv(file: PathBuf, rows: impl Iterator<Item = (String, String)>) -> Result<(), String> {
    let dir = home_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let body: String = rows.map(|(stamp, path)| format!("{stamp}\t{path}\n")).collect();
    let tmp = file.with_extension("tsv.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, file).map_err(|e| e.to_string())
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
    parse_tsv(&text).into_iter().map(|(last_opened, root)| LibraryEntry { root, last_opened }).collect()
}

fn write_registry(entries: &[LibraryEntry]) -> Result<(), String> {
    write_tsv(registry_path(), entries.iter().map(|e| (e.last_opened.clone(), e.root.clone())))
}

/// A folder the library is populated from. The books stay in place;
/// Ribbon reads them there and keeps its records beside them.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceEntry {
    pub root: String,
    /// ISO 8601.
    pub added_at: String,
}

fn read_sources_file() -> Option<Vec<SourceEntry>> {
    let text = std::fs::read_to_string(sources_path()).ok()?;
    Some(parse_tsv(&text).into_iter().map(|(added_at, root)| SourceEntry { root, added_at }).collect())
}

/// The library's sources, in the order they were added. The first time
/// this build runs, the folder an older build opened most recently
/// becomes the first source, so nothing is lost across the change.
#[tauri::command]
pub fn sources_read() -> Vec<SourceEntry> {
    if let Some(list) = read_sources_file() {
        return list;
    }
    let seeded: Vec<SourceEntry> = home_info().libraries.into_iter().take(1).map(|e| SourceEntry { root: e.root, added_at: e.last_opened }).collect();
    if !seeded.is_empty() {
        if let Err(e) = sources_write(seeded.clone()) {
            log::warn!("could not write the sources file: {e}");
        }
    }
    seeded
}

#[tauri::command]
pub fn sources_write(sources: Vec<SourceEntry>) -> Result<(), String> {
    write_tsv(sources_path(), sources.into_iter().map(|s| (s.added_at, s.root)))
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
    for file in [registry_path(), sources_path()] {
        if file.is_file() {
            std::fs::remove_file(&file).map_err(|e| e.to_string())?;
        }
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
    fn tsv_rows_keep_the_path_after_the_first_tab() {
        let rows = parse_tsv("2026-01-01T00:00:00Z\t\\\\nas\\media\\Books\n\n2026-01-02T00:00:00Z\t\nbad line\n2026-01-03T00:00:00Z\tE:\\a\tb\n");
        assert_eq!(rows, vec![("2026-01-01T00:00:00Z".to_string(), "\\\\nas\\media\\Books".to_string()), ("2026-01-03T00:00:00Z".to_string(), "E:\\a\tb".to_string())]);
    }

    #[test]
    fn roots_compare_without_case_or_slash_noise() {
        assert!(same_root("\\\\nas\\media\\Books\\", "//nas/media/books"));
        assert!(!same_root("E:/a", "E:/b"));
    }
}
