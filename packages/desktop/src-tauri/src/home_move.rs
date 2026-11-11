//! Moving the Ribbon folder (home.rs) to another place on this computer,
//! such as a second disk, so the system's disk keeps only the system.
//!
//! Everything in it is copied to the new place, file by file, with each
//! file's modified time kept: the scan reads a file's tags again when its
//! time changes, and a server's books are in here. Then the place where the
//! folder started out gets a note saying where it went, and Ribbon starts
//! again there. The old copy is deleted on that next start, when nothing
//! has its files open: Windows won't delete an open file, and the log is
//! open for as long as Ribbon runs.
//!
//! The page stops everything that writes here before it asks for the move
//! (playing, downloading, transcribing), so the copy is the whole folder.

use crate::home;
use serde::Serialize;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::Emitter;

/// Left in the folder after a move, naming the folders it was moved from, one a line, until they are deleted.
const MOVED_FROM: &str = "moved-from.txt";

/// The name a moved Ribbon folder has. Only folders with this name, or the
/// place the folder started out, are ever deleted after a move.
const FOLDER_NAME: &str = "Ribbon";

/// How the copy's progress reaches the page: `{ done, total }` in bytes.
const PROGRESS: &str = "ribbon://home-move";

/// Folders inside folders, as deep as the copy follows them. The Ribbon
/// folder is a few deep; a link that loops back on itself is not followed for ever.
const MAX_DEPTH: usize = 32;

/// What a move to a picked folder would do, to ask about before it starts.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MovePlan {
    /// Where the Ribbon folder is now.
    pub from: String,
    /// Where it would go: a folder named Ribbon in the one picked, or the one picked when that's its name.
    pub to: String,
    /// What it holds, to copy.
    pub bytes: u64,
    pub files: u64,
    /// Free on the disk it would go to.
    pub free_bytes: u64,
}

/// Ask what moving the Ribbon folder into `picked` would do, or why it can't go there.
#[tauri::command]
pub async fn home_move_check(picked: String) -> Result<MovePlan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let from = home::home_dir();
        let to = destination(&from, &home::base_dir(), Path::new(&picked), &library_folders())?;
        let tally = tally(&from)?;
        let free_bytes = free_space(&to)?;
        Ok(MovePlan { from: shown(&from), to: shown(&to), bytes: tally.bytes, files: tally.files, free_bytes })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Move the Ribbon folder into `picked`: copy it, then say where it went.
/// Ribbon is started again after this (by the page), in the new folder.
#[tauri::command]
pub async fn home_move(app: tauri::AppHandle, picked: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let from = home::home_dir();
        let base = home::base_dir();
        let to = destination(&from, &base, Path::new(&picked), &library_folders())?;
        let total = tally(&from)?.bytes;
        log::info!("moving the Ribbon folder from {} to {} ({total} bytes)", from.display(), to.display());
        let started = Instant::now();
        let mut said = Instant::now() - Duration::from_secs(1);
        let copied = move_home(&from, &base, &to, &mut |done| {
            // Ten times a second is enough for a progress bar.
            if said.elapsed() >= Duration::from_millis(100) {
                said = Instant::now();
                let _ = app.emit(PROGRESS, serde_json::json!({ "done": done, "total": total.max(done) }));
            }
        })?;
        let _ = app.emit(PROGRESS, serde_json::json!({ "done": copied.bytes, "total": copied.bytes }));
        log::info!("moved the Ribbon folder: {} files, {} bytes in {} ms", copied.files, copied.bytes, started.elapsed().as_millis());
        home::set_home_dir(to);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// On starting: delete the folders a move left behind, now nothing has their
/// files open. The Ribbon that moved may take a moment to finish closing,
/// its log still open, so each is tried a few times; one that still can't be
/// deleted is tried again next start.
pub fn finish() {
    let home = home::home_dir();
    let note = home.join(MOVED_FROM);
    let Ok(text) = std::fs::read_to_string(&note) else { return };
    let base = home::base_dir();
    let mut left = Vec::new();
    for old in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let mut tries = 0;
        let deleted = loop {
            tries += 1;
            match delete_left_behind(Path::new(old), &home, &base) {
                Err(_) if tries < 5 => std::thread::sleep(Duration::from_secs(2)),
                done => break done,
            }
        };
        match deleted {
            Ok(true) => log::info!("deleted the Ribbon folder's old copy in {old}"),
            Ok(false) => log::warn!("left {old} as it is: it isn't a Ribbon folder this one was moved from"),
            Err(e) => {
                log::warn!("could not delete the Ribbon folder's old copy in {old} yet: {e}");
                left.push(old.to_string());
            }
        }
    }
    let written = if left.is_empty() { std::fs::remove_file(&note) } else { std::fs::write(&note, left.join("\n") + "\n") };
    if let Err(e) = written {
        log::warn!("could not update {}: {e}", note.display());
    }
}

/// Where the Ribbon folder would go when `picked` is chosen, or why not there,
/// in words to show: a folder named Ribbon in the one picked, unless that's
/// its name already or it's where the folder started out. `from` is where
/// it is now, `base` where it started out.
fn destination(from: &Path, base: &Path, picked: &Path, libraries: &[PathBuf]) -> Result<PathBuf, String> {
    if !picked.is_dir() {
        return Err(format!("{} isn't there.", picked.display()));
    }
    if picked.to_str().is_none() {
        return Err("Ribbon can't keep that folder's name in its note of where it went. Pick another folder.".into());
    }
    let named = picked.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.eq_ignore_ascii_case(FOLDER_NAME));
    let to = if named || same(picked, base) { picked.to_path_buf() } else { picked.join(FOLDER_NAME) };
    if same(&to, from) {
        return Err("The Ribbon folder is there already.".into());
    }
    if inside(&to, from) {
        return Err("That's inside the Ribbon folder. Pick a folder outside it.".into());
    }
    if let Some(books) = libraries.iter().find(|l| same(&to, l) || inside(&to, l)) {
        return Err(format!("That's inside {}, a folder of your books: Ribbon would find its own files there as books. Pick a folder outside it.", books.display()));
    }
    if to.exists() {
        if !to.is_dir() {
            return Err(format!("There's a file named {FOLDER_NAME} there. Pick another folder."));
        }
        // Where the folder started out is empty but for the note when the folder is elsewhere.
        let others = std::fs::read_dir(&to).map_err(|e| e.to_string())?.filter_map(Result::ok).any(|e| !(same(&to, base) && e.file_name() == home::MOVED_NOTE));
        if others {
            return Err(format!("There's a folder named {FOLDER_NAME} there already, with files in it. Pick another folder, or empty that one first."));
        }
    }
    Ok(to)
}

/// Copy the Ribbon folder in `from` to `to` and say where it went: in a note
/// where it started out (`base`), or none when it's back there; and in the new
/// folder, the old one to delete on the next start. If the copy fails, what
/// it made is removed and nothing has moved.
fn move_home(from: &Path, base: &Path, to: &Path, progress: &mut dyn FnMut(u64)) -> Result<Tally, String> {
    let made = !to.exists();
    // Nothing, or where the folder started out with only its note.
    let there = tally(to)?;
    let mut copier = Copier { buf: vec![0; 1 << 20], copied: Tally::default(), progress };
    let copied = copier.copy_dir(from, to, 0).and_then(|_| {
        // What landed is what was copied: every file there, at its size.
        let copied = copier.copied;
        let landed = tally(to)?;
        if landed.files != there.files + copied.files || landed.bytes != there.bytes + copied.bytes {
            return Err(format!("the copy has {} files and {} bytes, but {} files and {} bytes were copied", landed.files - there.files, landed.bytes - there.bytes, copied.files, copied.bytes));
        }
        carry_over(from, to)?;
        // An older folder still waiting to be deleted (its note came with the copy) is remembered with this one.
        let earlier = std::fs::read_to_string(to.join(MOVED_FROM)).unwrap_or_default();
        let mut olds: Vec<String> = earlier.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect();
        olds.push(shown(from));
        std::fs::write(to.join(MOVED_FROM), olds.join("\n") + "\n").map_err(|e| e.to_string())?;
        Ok(copied)
    });
    let copied = match copied {
        Ok(copied) => copied,
        Err(e) => {
            undo_copy(to, made);
            return Err(e);
        }
    };
    // The one step that moves it: from here on, Ribbon starts in the new folder.
    let pointed = if same(to, base) { remove_note(base) } else { write_note(base, to) };
    if let Err(e) = pointed {
        undo_copy(to, made);
        return Err(format!("could not leave a note where the Ribbon folder started out: {e}"));
    }
    Ok(copied)
}

/// Point what in the copy names the old folder at the new one: a setting that
/// holds a path in it (the speech model's), and each server's folder, whose
/// mirror is named by its path (`scan::mirror_name`). Only the copy changes.
fn carry_over(from: &Path, to: &Path) -> Result<(), String> {
    let (old, new) = (shown(from), shown(to));
    let settings = to.join("settings.json");
    if let Some(mut value) = std::fs::read_to_string(&settings).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) {
        if repoint(&mut value, &old, &new) {
            let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
            std::fs::write(&settings, text).map_err(|e| format!("could not update the settings: {e}"))?;
        }
    }
    let sources_file = to.join("sources.tsv");
    let Some(sources) = home::sources_in(&sources_file) else { return Ok(()) };
    if !sources.iter().any(|s| s.server.is_some()) {
        return Ok(());
    }
    let mirror = to.join("mirror");
    let mut moved = Vec::new();
    for mut source in sources {
        // A server's folder is Ribbon's own, `servers/<its id>`, wherever the Ribbon folder is (`serverRoot` in the controller).
        let name = Path::new(&source.root).file_name().map(|n| n.to_os_string());
        if let (Some(_), Some(name)) = (&source.server, name) {
            let (was, now) = (shown(&from.join("servers").join(&name)), shown(&to.join("servers").join(&name)));
            let (was_mirror, now_mirror) = (mirror.join(crate::scan::mirror_name(&was)), mirror.join(crate::scan::mirror_name(&now)));
            if was_mirror.is_dir() && !now_mirror.exists() {
                std::fs::rename(&was_mirror, &now_mirror).map_err(|e| format!("could not rename a server's mirror: {e}"))?;
            }
            source.root = now;
        }
        moved.push(source);
    }
    home::write_sources_to(&sources_file, moved)
}

/// Point every string in a JSON value that's a path in the folder `old` at the
/// same place in `new`. True when one was.
fn repoint(value: &mut serde_json::Value, old: &str, new: &str) -> bool {
    match value {
        serde_json::Value::String(s) => {
            let starts = s.len() > old.len() && s.is_char_boundary(old.len()) && home::comparable(&s[..old.len()]) == home::comparable(old);
            if starts && matches!(s.as_bytes()[old.len()], b'/' | b'\\') {
                *s = format!("{new}{}", &s[old.len()..]);
                return true;
            }
            false
        }
        serde_json::Value::Array(items) => items.iter_mut().fold(false, |any, v| repoint(v, old, new) || any),
        serde_json::Value::Object(map) => map.values_mut().fold(false, |any, v| repoint(v, old, new) || any),
        _ => false,
    }
}

fn write_note(base: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(base).map_err(|e| e.to_string())?;
    let tmp = base.join("moved.txt.tmp");
    std::fs::write(&tmp, shown(to) + "\n").map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, base.join(home::MOVED_NOTE)).map_err(|e| e.to_string())
}

fn remove_note(base: &Path) -> Result<(), String> {
    match std::fs::remove_file(base.join(home::MOVED_NOTE)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Take back a copy that didn't finish: the folder it made, or what it put in
/// one that was empty, keeping the note when that's where the folder started out.
fn undo_copy(to: &Path, made: bool) {
    let undone = if made { std::fs::remove_dir_all(to) } else { empty(to, Some(home::MOVED_NOTE)) };
    if let Err(e) = undone {
        log::warn!("could not remove the unfinished copy in {}: {e}", to.display());
    }
}

/// Delete a folder the Ribbon folder was moved from. False, and nothing
/// deleted, when it isn't one: the folder Ribbon is in now or holds it, or a
/// folder neither named Ribbon nor where it started out. Where it started
/// out keeps its note.
fn delete_left_behind(old: &Path, home: &Path, base: &Path) -> Result<bool, String> {
    if same(old, home) || inside(home, old) || inside(old, home) {
        return Ok(false);
    }
    let named = old.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.eq_ignore_ascii_case(FOLDER_NAME));
    if same(old, base) {
        empty(old, Some(home::MOVED_NOTE)).map_err(|e| e.to_string())?;
        return Ok(true);
    }
    if !named {
        return Ok(false);
    }
    match std::fs::remove_dir_all(old) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(true),
    }
}

/// Remove everything in a folder but the file named `keep`.
fn empty(dir: &Path, keep: Option<&str>) -> std::io::Result<()> {
    let entries = match std::fs::read_dir(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        other => other?,
    };
    for entry in entries {
        let entry = entry?;
        if keep.is_some_and(|k| entry.file_name() == k) {
            continue;
        }
        // A link is removed, never what it leads to.
        if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(entry.path())?;
        } else {
            std::fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

/// Files and bytes in a folder and every folder in it.
#[derive(Default, Debug, PartialEq, Clone, Copy)]
struct Tally {
    files: u64,
    bytes: u64,
}

fn tally(dir: &Path) -> Result<Tally, String> {
    fn walk(dir: &Path, depth: usize, t: &mut Tally) -> Result<(), String> {
        for entry in std::fs::read_dir(dir).map_err(|e| format!("could not read {}: {e}", dir.display()))? {
            let path = entry.map_err(|e| e.to_string())?.path();
            let meta = std::fs::metadata(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
            if meta.is_dir() && depth < MAX_DEPTH {
                walk(&path, depth + 1, t)?;
            } else if meta.is_file() {
                t.files += 1;
                t.bytes += meta.len();
            }
        }
        Ok(())
    }
    let mut t = Tally::default();
    if dir.exists() {
        walk(dir, 0, &mut t)?;
    }
    Ok(t)
}

/// Copies a folder file by file through one buffer, saying how many bytes are done as it goes.
struct Copier<'a> {
    buf: Vec<u8>,
    copied: Tally,
    progress: &'a mut dyn FnMut(u64),
}

impl Copier<'_> {
    /// A link is copied as what it leads to, so nothing it reaches is lost.
    fn copy_dir(&mut self, from: &Path, to: &Path, depth: usize) -> Result<(), String> {
        std::fs::create_dir_all(to).map_err(|e| format!("could not make {}: {e}", to.display()))?;
        for entry in std::fs::read_dir(from).map_err(|e| format!("could not read {}: {e}", from.display()))? {
            let entry = entry.map_err(|e| e.to_string())?;
            let (src, dst) = (entry.path(), to.join(entry.file_name()));
            let meta = std::fs::metadata(&src).map_err(|e| format!("could not read {}: {e}", src.display()))?;
            if meta.is_dir() && depth < MAX_DEPTH {
                self.copy_dir(&src, &dst, depth + 1)?;
            } else if meta.is_file() {
                self.copy_file(&src, &dst).map_err(|e| format!("could not copy {}: {e}", src.display()))?;
            }
        }
        Ok(())
    }

    fn copy_file(&mut self, src: &Path, dst: &Path) -> std::io::Result<()> {
        let mut input = File::open(src)?;
        let modified = input.metadata()?.modified().ok();
        let mut output = File::create(dst)?;
        loop {
            let n = input.read(&mut self.buf)?;
            if n == 0 {
                break;
            }
            output.write_all(&self.buf[..n])?;
            self.copied.bytes += n as u64;
            (self.progress)(self.copied.bytes);
        }
        // After the last write, which would change it.
        if let Some(t) = modified {
            output.set_modified(t)?;
        }
        self.copied.files += 1;
        Ok(())
    }
}

/// The folders of books in the library on this machine: the Ribbon folder mustn't go in one.
fn library_folders() -> Vec<PathBuf> {
    home::sources_in(&home::home_dir().join("sources.tsv")).unwrap_or_default().into_iter().filter(|s| s.server.is_none()).map(|s| PathBuf::from(s.root)).collect()
}

/// The space free on the disk a folder would be on: asked of the nearest folder that exists.
fn free_space(dir: &Path) -> Result<u64, String> {
    let mut at = dir.to_path_buf();
    while !at.exists() {
        if !at.pop() {
            return Err(format!("{} isn't there.", dir.display()));
        }
    }
    fs4::available_space(&at).map_err(|e| e.to_string())
}

fn shown(path: &Path) -> String {
    path.display().to_string()
}

fn same(a: &Path, b: &Path) -> bool {
    home::comparable(&shown(a)) == home::comparable(&shown(b))
}

/// Whether `a` is somewhere inside `b`, not `b` itself.
fn inside(a: &Path, b: &Path) -> bool {
    home::comparable(&shown(a)).starts_with(&(home::comparable(&shown(b)) + "/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    /// A fresh folder of the test's own under the system's temporary folder.
    /// With an empty folder `disk` in it, as a second disk to move to.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ribbon-home-move-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("disk")).unwrap();
        dir
    }

    fn put(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// A Ribbon folder as one looks: a mirror, a server's book, the log.
    fn ribbon_folder(dir: &Path) {
        put(&dir.join("mirror").join("ab12").join("library.csv"), "id,title\n1,Dune\n");
        put(&dir.join("servers").join("cd34").join("Dune").join("Dune.mp3"), &"x".repeat(3_000_000));
        put(&dir.join("logs").join("ribbon.log"), "starting\n");
        put(&dir.join("sources.tsv"), "2026-11-11T00:00:00Z\t/books\n");
    }

    /// A server's folder in it, with its mirror, and the speech model chosen from it.
    fn with_a_server(dir: &Path) {
        let server = shown(&dir.join("servers").join("cd34"));
        put(&dir.join("sources.tsv"), &format!("2026-11-11T00:00:00Z\t/books\n2026-11-11T00:00:00Z\t{server}\thttps://books.example.net\tann\n"));
        put(&dir.join("mirror").join(crate::scan::mirror_name(&server)).join("library.csv"), "id,title\n2,Dune\n");
        let model = shown(&dir.join("models").join("ggml-small.bin"));
        put(&dir.join("settings.json"), &serde_json::json!({ "speechModel": model, "perfLog": true, "serverTokens": { "https://books.example.net ann": "t" } }).to_string());
    }

    #[test]
    fn the_whole_folder_moves_and_keeps_each_files_time() {
        let t = scratch("whole");
        let base = t.join("base");
        ribbon_folder(&base);
        let book = base.join("servers").join("cd34").join("Dune").join("Dune.mp3");
        let added = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        File::options().write(true).open(&book).unwrap().set_modified(added).unwrap();

        let to = destination(&base, &base, &t.join("disk"), &[]).unwrap();
        assert_eq!(to, t.join("disk").join("Ribbon"));
        let before = tally(&base).unwrap();
        let mut seen = 0;
        let copied = move_home(&base, &base, &to, &mut |done| seen = done).unwrap();

        assert_eq!(copied, before);
        assert_eq!(copied.files, 4);
        assert_eq!(seen, copied.bytes);
        assert_eq!(std::fs::read_to_string(to.join("mirror").join("ab12").join("library.csv")).unwrap(), "id,title\n1,Dune\n");
        let moved_book = to.join("servers").join("cd34").join("Dune").join("Dune.mp3");
        assert_eq!(std::fs::metadata(&moved_book).unwrap().len(), 3_000_000);
        assert_eq!(std::fs::metadata(&moved_book).unwrap().modified().unwrap(), added);
        // Ribbon starts in the new folder from now on, and deletes the old one there.
        assert_eq!(home::located(&base), to);
        assert_eq!(std::fs::read_to_string(to.join(MOVED_FROM)).unwrap(), format!("{}\n", base.display()));

        assert_eq!(delete_left_behind(&base, &to, &base), Ok(true));
        let left: Vec<_> = std::fs::read_dir(&base).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left, vec![std::ffi::OsString::from(home::MOVED_NOTE)]);
        assert_eq!(home::located(&base), to);
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn a_servers_folder_and_the_speech_model_are_found_in_the_new_place() {
        let t = scratch("server");
        let base = t.join("base");
        ribbon_folder(&base);
        with_a_server(&base);
        let to = destination(&base, &base, &t.join("disk"), &[]).unwrap();
        move_home(&base, &base, &to, &mut |_| ()).unwrap();

        let settings: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(to.join("settings.json")).unwrap()).unwrap();
        assert_eq!(settings["speechModel"], shown(&to.join("models").join("ggml-small.bin")));
        assert_eq!(settings["perfLog"], true);
        let sources = home::sources_in(&to.join("sources.tsv")).unwrap();
        let server = shown(&to.join("servers").join("cd34"));
        assert_eq!(sources.iter().map(|s| s.root.as_str()).collect::<Vec<_>>(), vec!["/books", server.as_str()]);
        assert_eq!(sources[1].server.as_ref().unwrap().person, "ann");
        // The server's mirror goes by its folder's new path, so the shelf paints from it at once.
        assert_eq!(std::fs::read_to_string(to.join("mirror").join(crate::scan::mirror_name(&server)).join("library.csv")).unwrap(), "id,title\n2,Dune\n");
        // The old folder is as it was.
        let old_settings = std::fs::read_to_string(base.join("settings.json")).unwrap();
        assert!(old_settings.contains("base"), "{old_settings}");
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn a_path_is_pointed_at_the_new_folder_only_when_it_is_in_the_old_one() {
        let mut v = serde_json::json!({ "a": "C:\\Users\\k\\AppData\\Local\\Ribbon\\models\\small.bin", "b": "C:\\Users\\k\\AppData\\Local\\RibbonX\\x", "c": ["c:/users/k/appdata/local/ribbon/y"], "d": 3 });
        assert!(repoint(&mut v, "C:\\Users\\k\\AppData\\Local\\Ribbon", "D:\\Ribbon"));
        assert_eq!(v, serde_json::json!({ "a": "D:\\Ribbon\\models\\small.bin", "b": "C:\\Users\\k\\AppData\\Local\\RibbonX\\x", "c": ["D:\\Ribbon/y"], "d": 3 }));
        assert!(!repoint(&mut serde_json::json!({ "a": "E:\\Books" }), "C:\\Ribbon", "D:\\Ribbon"));
    }

    #[test]
    fn moving_it_back_where_it_started_takes_the_note_away() {
        let t = scratch("back");
        let base = t.join("base");
        ribbon_folder(&base);
        let away = destination(&base, &base, &t.join("disk"), &[]).unwrap();
        move_home(&base, &base, &away, &mut |_| ()).unwrap();
        delete_left_behind(&base, &away, &base).unwrap();

        // Where it started out holds only the note, so it can go back there.
        let back = destination(&away, &base, &base, &[]).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(back, base);
        move_home(&away, &base, &back, &mut |_| ()).unwrap();
        assert_eq!(home::located(&base), base);
        assert!(!base.join(home::MOVED_NOTE).exists());
        assert_eq!(tally(&base).unwrap().files, 5, "the four files and the note of what to delete");

        assert_eq!(delete_left_behind(&away, &base, &base), Ok(true));
        assert!(!away.exists());
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn it_wont_go_where_it_cant() {
        let t = scratch("refused");
        let home = t.join("Ribbon");
        ribbon_folder(&home);
        let books = t.join("Books");
        std::fs::create_dir_all(books.join("Fantasy")).unwrap();
        let full = t.join("full").join("Ribbon");
        put(&full.join("notes.txt"), "mine");
        std::fs::create_dir_all(t.join("empty").join("Ribbon")).unwrap();

        let refused = |picked: PathBuf| destination(&home, &home, &picked, &[books.clone()]).unwrap_err();
        assert!(refused(t.join("nowhere")).contains("isn't there"));
        assert!(refused(t.clone()).contains("there already"));
        assert!(refused(home.join("mirror")).contains("inside the Ribbon folder"));
        assert!(refused(books.join("Fantasy")).contains("a folder of your books"));
        assert!(refused(t.join("full")).contains("with files in it"));
        // A folder named Ribbon, empty, is used as it is.
        assert_eq!(destination(&home, &home, &t.join("empty").join("Ribbon"), &[books.clone()]), Ok(t.join("empty").join("Ribbon")));
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn only_a_folder_it_was_moved_from_is_ever_deleted() {
        let t = scratch("deleted");
        let base = t.join("base");
        let home = t.join("disk").join("Ribbon");
        let other = t.join("Photos");
        put(&other.join("a.jpg"), "a");
        put(&home.join("logs").join("ribbon.log"), "x");
        // Not named Ribbon, nor where it started out.
        assert_eq!(delete_left_behind(&other, &home, &base), Ok(false));
        assert!(other.join("a.jpg").exists());
        // The folder Ribbon is in, or one that holds it.
        assert_eq!(delete_left_behind(&home, &home, &base), Ok(false));
        assert_eq!(delete_left_behind(&t.join("disk"), &home, &base), Ok(false));
        assert!(home.join("logs").join("ribbon.log").exists());
        // One already gone is done with.
        assert_eq!(delete_left_behind(&t.join("gone").join("Ribbon"), &home, &base), Ok(true));
        let _ = std::fs::remove_dir_all(&t);
    }

    #[cfg(unix)]
    #[test]
    fn a_copy_that_fails_leaves_everything_where_it_was() {
        use std::os::unix::fs::PermissionsExt;
        let t = scratch("failed");
        let base = t.join("base");
        ribbon_folder(&base);
        let locked = base.join("mirror").join("ab12").join("library.csv");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        if File::open(&locked).is_ok() {
            // Run as root, which reads anything: there's no failure to see.
            return;
        }
        let to = destination(&base, &base, &t.join("disk"), &[]).unwrap();
        let failed = move_home(&base, &base, &to, &mut |_| ()).unwrap_err();
        assert!(failed.contains("library.csv"), "{failed}");
        assert!(!to.exists());
        assert_eq!(home::located(&base), base);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();
        let _ = std::fs::remove_dir_all(&t);
    }
}
