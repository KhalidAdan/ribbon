//! The read-along export: a copy of a book's EPUB with its narration and
//! the timing between them inside, as EPUB 3 Media Overlays, the way
//! Storyteller makes them. Any reader that plays Media Overlays can read
//! it along; Ribbon reads it as level 3. The original is never touched.
//!
//! Each sentence is wrapped in a `<span id>` where it sits in the chapter's
//! own XHTML (the parser traces where every character came from, and tags
//! go in at those bytes, so nothing else in the file changes). A sentence
//! that runs across a tag is wrapped up to the tag. Each chapter's stretch
//! of the audiobook is cut and re-encoded (AAC, 64 kbps mono), and a SMIL
//! file says when each sentence is read. Audio files are named for where
//! they start in the audiobook (`-at-<ms>ms`), so Ribbon maps the export
//! back onto the recording beside it exactly.

use super::content::Cache;
use super::source::{BlockRange, ChapterSource, Mark};
use super::paths::resolve;
use super::{package_file, Zip};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// The class readers give the sentence being read, and how it looks in readers that use the book's own CSS.
const ACTIVE_CLASS: &str = "-epub-media-overlay-active";
const CSS: &str = ".-epub-media-overlay-active { background-color: rgba(217, 119, 6, 0.22); border-radius: 2px; }\n";

#[derive(Deserialize, Debug, Clone)]
pub struct Sentence {
    pub block: usize,
    /// UTF-16 offsets in the block's text, as the model has them.
    pub start: u32,
    pub end: u32,
    /// When it is read, in ms of the section's audio.
    #[serde(rename = "beginMs")]
    pub begin_ms: u64,
    #[serde(rename = "endMs")]
    pub end_ms: u64,
}

/// A piece of the audiobook: a file and a stretch of it.
#[derive(Deserialize, Debug, Clone)]
pub struct Segment {
    pub path: String,
    #[serde(rename = "fromMs")]
    pub from_ms: u64,
    #[serde(rename = "toMs")]
    pub to_ms: u64,
}

#[derive(Deserialize, Debug, Clone)]
pub struct SectionPlan {
    /// The chapter's path in the EPUB.
    pub href: String,
    /// Where its audio starts in the audiobook.
    #[serde(rename = "bookMs")]
    pub book_ms: u64,
    pub sentences: Vec<Sentence>,
    pub audio: Vec<Segment>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Plan {
    pub epub: String,
    pub out: String,
    pub sections: Vec<SectionPlan>,
}

/// A link to a stylesheet, put at the end of the head.
fn link_css(xhtml: &str, href: &str) -> String {
    let lower = xhtml.to_ascii_lowercase();
    match lower.find("</head>") {
        Some(i) => format!("{}<link rel=\"stylesheet\" type=\"text/css\" href=\"{href}\"/>{}", &xhtml[..i], &xhtml[i..]),
        None => xhtml.to_string(),
    }
}

/// `to` (a path in the book) as written in `from` (a file in the book).
pub fn relative(from: &str, to: &str) -> String {
    let from_dir: Vec<&str> = from.split('/').collect::<Vec<_>>()[..from.split('/').count() - 1].to_vec();
    let to_parts: Vec<&str> = to.split('/').collect();
    let common = from_dir.iter().zip(&to_parts).take_while(|(a, b)| a == b).count();
    let mut out: Vec<String> = std::iter::repeat("..".to_string()).take(from_dir.len() - common).collect();
    out.extend(to_parts[common..].iter().map(|p| percent_encode(p)));
    out.join("/")
}

fn percent_encode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// A SMIL clock value: seconds with three decimals.
fn secs(ms: u64) -> String {
    format!("{}.{:03}s", ms / 1000, ms % 1000)
}

/// A duration as EPUB metadata gives it: h:mm:ss.fff.
fn hms(ms: u64) -> String {
    format!("{}:{:02}:{:02}.{:03}", ms / 3_600_000, (ms / 60_000) % 60, (ms / 1000) % 60, ms % 1000)
}

fn smil(smil_path: &str, text_path: &str, audio_path: &str, clips: &[(String, u64, u64)]) -> String {
    let text = relative(smil_path, text_path);
    let audio = relative(smil_path, audio_path);
    let mut out = String::new();
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<smil xmlns=\"http://www.w3.org/ns/SMIL\" xmlns:epub=\"http://www.idpf.org/2007/ops\" version=\"3.0\">\n<body>\n");
    out.push_str(&format!("<seq epub:textref=\"{text}\">\n"));
    for (i, (id, begin, end)) in clips.iter().enumerate() {
        out.push_str(&format!("<par id=\"p{}\"><text src=\"{text}#{id}\"/><audio src=\"{audio}\" clipBegin=\"{}\" clipEnd=\"{}\"/></par>\n", i + 1, secs(*begin), secs(*end)));
    }
    out.push_str("</seq>\n</body>\n</smil>\n");
    out
}

/// Cut a stretch of the audiobook (one piece or several, joined) and encode it for the book.
fn encode(segments: &[Segment], out: &Path) -> Result<(), String> {
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y"]);
    for s in segments {
        cmd.args(["-ss", &format!("{:.3}", s.from_ms as f64 / 1000.0), "-to", &format!("{:.3}", s.to_ms as f64 / 1000.0), "-i"]).arg(&s.path);
    }
    if segments.len() > 1 {
        let inputs: String = (0..segments.len()).map(|i| format!("[{i}:a]")).collect();
        cmd.args(["-filter_complex", &format!("{inputs}concat=n={}:v=0:a=1[a]", segments.len()), "-map", "[a]"]);
    } else {
        cmd.args(["-map", "0:a"]);
    }
    cmd.args(["-vn", "-ac", "1", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart"]).arg(out).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let o = cmd.output().map_err(|e| format!("could not run ffmpeg: {e}"))?;
    if !o.status.success() {
        return Err(format!("ffmpeg could not encode the narration: {}", String::from_utf8_lossy(&o.stderr).trim()));
    }
    Ok(())
}

/// The package file with the overlays added: each chapter's item names its SMIL, the new files are in
/// the manifest, and the metadata gives each overlay's length, the active class and where it came from.
fn amend_package(opf: &str, opf_path: &str, overlays: &[(String, String, String, String, u64)], extra: &[(String, String, String)], source_name: &str) -> Result<String, String> {
    let mut out = opf.to_string();
    // Each chapter's item: media-overlay, by its href.
    let mut at = 0;
    let mut items: Vec<(usize, usize, String)> = Vec::new(); // (tag start, tag end, resolved href)
    while let Some(i) = out[at..].find("<item") {
        let start = at + i;
        let Some(len) = out[start..].find('>') else { break };
        let tag = &out[start..start + len + 1];
        at = start + len + 1;
        if !tag[5..].starts_with(|c: char| c.is_whitespace()) {
            continue;
        }
        if let Some(href) = attr(tag, "href") {
            items.push((start, start + len + 1, resolve(opf_path, &href)));
        }
    }
    let wanted: HashMap<&str, &str> = overlays.iter().map(|(chapter, smil_id, ..)| (chapter.as_str(), smil_id.as_str())).collect();
    for (start, end, href) in items.into_iter().rev() {
        let Some(smil_id) = wanted.get(href.as_str()) else { continue };
        let tag = &out[start..end];
        if attr(tag, "media-overlay").is_some() {
            return Err("this book already has read-along".into());
        }
        let close = if tag.ends_with("/>") { end - 2 } else { end - 1 };
        out.insert_str(close, &format!(" media-overlay=\"{smil_id}\""));
    }
    let manifest_end = out.find("</manifest>").ok_or("the package has no manifest")?;
    let mut items = String::new();
    for (_, smil_id, smil_path, _, _) in overlays {
        items.push_str(&format!("<item id=\"{smil_id}\" href=\"{}\" media-type=\"application/smil+xml\"/>\n", relative(opf_path, smil_path)));
    }
    for (id, path, media_type) in extra {
        items.push_str(&format!("<item id=\"{id}\" href=\"{}\" media-type=\"{media_type}\"/>\n", relative(opf_path, path)));
    }
    out.insert_str(manifest_end, &items);
    let metadata_end = out.find("</metadata>").ok_or("the package has no metadata")?;
    let total: u64 = overlays.iter().map(|o| o.4).sum();
    let mut metas = String::new();
    for (_, smil_id, _, _, ms) in overlays {
        metas.push_str(&format!("<meta property=\"media:duration\" refines=\"#{smil_id}\">{}</meta>\n", hms(*ms)));
    }
    metas.push_str(&format!("<meta property=\"media:duration\">{}</meta>\n<meta property=\"media:active-class\">{ACTIVE_CLASS}</meta>\n", hms(total)));
    metas.push_str(&format!("<meta property=\"ribbon:read-along-of\">{}</meta>\n", escape(source_name)));
    out.insert_str(metadata_end, &metas);
    // The ribbon: prefix, declared on the package.
    let package = out.find("<package").ok_or("no package element")?;
    let tag_end = package + out[package..].find('>').ok_or("broken package element")?;
    let tag = &out[package..tag_end];
    const PREFIX: &str = "ribbon: https://github.com/KhalidAdan/ribbon#";
    match tag.find("prefix=\"") {
        Some(i) => out.insert_str(package + i + 8, &format!("{PREFIX} ")),
        None => out.insert_str(package + 8, &format!(" prefix=\"{PREFIX}\"")),
    }
    Ok(out)
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let mut from = 0;
    while let Some(i) = tag[from..].find(name) {
        let at = from + i;
        from = at + name.len();
        let before = tag[..at].chars().last();
        if !before.is_some_and(|c| c.is_whitespace()) {
            continue;
        }
        let rest = tag[from..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else { continue };
        let rest = rest.trim_start();
        let quote = rest.chars().next()?;
        if quote != '"' && quote != '\'' {
            continue;
        }
        let end = rest[1..].find(quote)?;
        return Some(rest[1..1 + end].to_string());
    }
    None
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Make the read-along EPUB the plan describes. `progress(done, total)` counts chapters encoded.
pub fn export(plan: &Plan, progress: &(dyn Fn(usize, usize) + Sync)) -> Result<(), String> {
    let file = std::fs::File::open(&plan.epub).map_err(|e| format!("could not open the EPUB: {e}"))?;
    let mut zip = Zip { archive: ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| format!("not a zip file ({e})"))? };
    let (opf_path, opf) = package_file(&mut zip).map_err(|e| e.message())?;
    let base = opf_path.rsplit_once('/').map_or(String::new(), |(d, _)| format!("{d}/"));
    let css_path = format!("{base}ribbon/read-along.css");

    // Each chapter: its sentences tagged in place.
    let mut cache = Cache::default();
    let mut replaced: HashMap<String, Vec<u8>> = HashMap::new();
    let mut overlays: Vec<(String, String, String, String, u64)> = Vec::new(); // (chapter, smil id, smil path, audio path, ms)
    let mut smils: Vec<(String, String)> = Vec::new();
    let mut extra: Vec<(String, String, String)> = vec![("ribbon-css".into(), css_path.clone(), "text/css".into())];
    let mut jobs: Vec<(Vec<Segment>, String)> = Vec::new();
    for (n, section) in plan.sections.iter().enumerate() {
        let Some(xhtml) = zip.text(&section.href) else { continue };
        let chapter = ChapterSource::read(&xhtml, &section.href, &mut zip, &mut cache);
        let ids: Vec<String> = (1..=section.sentences.len()).map(|i| format!("ribbon-s{}-{i}", n + 1)).collect();
        let marks: Vec<Mark> = section.sentences.iter().zip(&ids).map(|(s, id)| Mark { range: BlockRange { block: s.block, start: s.start, end: s.end }, open: format!("<span id=\"{id}\">"), close: "</span>".into() }).collect();
        let (tagged, wrapped) = chapter.wrap(&marks);
        let clips: Vec<(String, u64, u64)> = ids.iter().zip(&section.sentences).zip(&wrapped).filter(|(_, w)| **w).map(|((id, s), _)| (id.clone(), s.begin_ms, s.end_ms)).collect();
        if clips.is_empty() {
            continue;
        }
        replaced.insert(section.href.clone(), link_css(&tagged, &relative(&section.href, &css_path)).into_bytes());
        let ms: u64 = section.audio.iter().map(|a| a.to_ms.saturating_sub(a.from_ms)).sum();
        let audio_path = format!("{base}ribbon/audio/{:03}-at-{}ms.m4a", n + 1, section.book_ms);
        let smil_path = format!("{base}ribbon/{:03}.smil", n + 1);
        let smil_id = format!("ribbon-smil-{}", n + 1);
        smils.push((smil_path.clone(), smil(&smil_path, &section.href, &audio_path, &clips)));
        extra.push((format!("ribbon-audio-{}", n + 1), audio_path.clone(), "audio/mp4".into()));
        overlays.push((section.href.clone(), smil_id, smil_path, audio_path.clone(), ms));
        jobs.push((section.audio.clone(), audio_path));
    }
    if overlays.is_empty() {
        return Err("nothing in this book is matched to its narration yet".into());
    }
    let source_name = Path::new(&plan.epub).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let package = amend_package(&opf, &opf_path, &overlays, &extra, &source_name)?;

    // The narration, chapter by chapter, a few at once.
    let tmp = std::env::temp_dir().join(format!("ribbon-export-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let done = std::sync::atomic::AtomicUsize::new(0);
    let next = std::sync::atomic::AtomicUsize::new(0);
    let total = jobs.len();
    let failed: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
    let ways = std::thread::available_parallelism().map_or(2, |n| (n.get() / 2).clamp(1, 4));
    std::thread::scope(|s| {
        for _ in 0..ways {
            s.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if i >= total || failed.lock().map(|f| f.is_some()).unwrap_or(true) {
                    break;
                }
                let (segments, _) = &jobs[i];
                if let Err(e) = encode(segments, &tmp.join(format!("{i}.m4a"))) {
                    *failed.lock().unwrap() = Some(e);
                    break;
                }
                progress(done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1, total);
            });
        }
    });
    if let Some(e) = failed.into_inner().unwrap_or(None) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }

    // The book: mimetype first and stored, the original's files as they were (but the changed ones), then the new.
    let out_tmp = PathBuf::from(format!("{}.part", plan.out));
    let result = (|| -> Result<(), String> {
        let mut w = ZipWriter::new(std::io::BufWriter::new(std::fs::File::create(&out_tmp).map_err(|e| e.to_string())?));
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        w.start_file("mimetype", stored).map_err(|e| e.to_string())?;
        w.write_all(b"application/epub+zip").map_err(|e| e.to_string())?;
        let mut skip: HashSet<String> = replaced.keys().cloned().collect();
        skip.insert(opf_path.clone());
        skip.insert("mimetype".into());
        for i in 0..zip.archive.len() {
            let f = zip.archive.by_index_raw(i).map_err(|e| e.to_string())?;
            if skip.contains(f.name()) {
                continue;
            }
            w.raw_copy_file(f).map_err(|e| e.to_string())?;
        }
        w.start_file(opf_path.as_str(), deflated).map_err(|e| e.to_string())?;
        w.write_all(package.as_bytes()).map_err(|e| e.to_string())?;
        for (path, bytes) in &replaced {
            w.start_file(path.as_str(), deflated).map_err(|e| e.to_string())?;
            w.write_all(bytes).map_err(|e| e.to_string())?;
        }
        w.start_file(css_path.as_str(), deflated).map_err(|e| e.to_string())?;
        w.write_all(CSS.as_bytes()).map_err(|e| e.to_string())?;
        for (path, text) in &smils {
            w.start_file(path.as_str(), deflated).map_err(|e| e.to_string())?;
            w.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        }
        for (i, (_, path)) in jobs.iter().enumerate() {
            w.start_file(path.as_str(), stored.large_file(true)).map_err(|e| e.to_string())?;
            let mut f = std::fs::File::open(tmp.join(format!("{i}.m4a"))).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, &mut w).map_err(|e| e.to_string())?;
        }
        w.finish().map_err(|e| e.to_string())?.flush().map_err(|e| e.to_string())?;
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    if let Err(e) = result {
        let _ = std::fs::remove_file(&out_tmp);
        return Err(e);
    }
    std::fs::rename(&out_tmp, &plan.out).map_err(|e| format!("could not put the export in place: {e}"))?;
    Ok(())
}

/// Export a book's read-along EPUB beside it, reporting chapters encoded as `ribbon://export-progress`.
#[tauri::command]
pub async fn ebook_export(app: tauri::AppHandle, plan: Plan) -> Result<String, String> {
    use tauri::Emitter;
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |done: usize, total: usize| {
            let _ = app.emit("ribbon://export-progress", serde_json::json!({ "done": done, "total": total }));
        };
        export(&plan, &emit).map(|_| plan.out.clone())
    })
    .await
    .map_err(|e| e.to_string())?
}


#[cfg(test)]
#[path = "export_tests.rs"]
mod tests;
