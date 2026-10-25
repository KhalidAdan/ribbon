//! The narrator's words, on this machine (#65): a few seconds of a book's
//! audio decoded by ffmpeg and transcribed by whisper.cpp, so a chapter's
//! opening words can be matched against the text, and whole stretches of it
//! for read-along (#57). Nothing leaves the machine. The hearing itself is
//! the `ribbon-speech` crate (src-tauri/speech), which the server runs too;
//! here are the app's commands over it. The model is a whisper.cpp `ggml`
//! file the listener chose or downloaded.

use std::path::Path;

pub use ribbon_speech::{decode_clip, Clip, Said};

/// True when this machine has a Vulkan driver, which whisper.cpp needs to run on the GPU. Ribbon
/// loads vulkan-1.dll only when speech is first used (build.rs); without it, hearing is refused
/// rather than crashing.
#[cfg(windows)]
pub fn vulkan_available() -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryW(name: *const u16) -> *mut std::ffi::c_void;
    }
    let name: Vec<u16> = "vulkan-1.dll\0".encode_utf16().collect();
    // Kept loaded: whisper.cpp is about to use it.
    !unsafe { LoadLibraryW(name.as_ptr()) }.is_null()
}

/// Elsewhere the GPU is always there: Metal on Apple's systems (Cargo.toml).
#[cfg(not(windows))]
pub fn vulkan_available() -> bool {
    true
}

/// How many stretches to transcribe at once: RIBBON_SPEECH_WAYS, else three: on an RTX 2070, 8 minutes of audio took 13 s one at a time, 8.3 s two at once, 7.5 s three, 7.4 s four.
fn transcribe_ways() -> usize {
    std::env::var("RIBBON_SPEECH_WAYS").ok().and_then(|s| s.parse().ok()).unwrap_or(3)
}

/// Hearing needs a GPU driver on Windows; refused rather than crashing without one.
fn need_gpu() -> Result<(), String> {
    if vulkan_available() {
        Ok(())
    } else {
        Err("speech needs a graphics driver with Vulkan, and this machine has none".into())
    }
}

/// Each clip's answer, or None for one that couldn't be heard, said in the log: one bad clip never fails the rest.
fn or_none<T>(clips: &[Clip], heard: Vec<Result<T, String>>) -> Vec<Option<T>> {
    clips
        .iter()
        .zip(heard)
        .map(|(c, h)| {
            h.map_err(|e| log::warn!("could not hear {} at {} ms: {e}", c.path, c.start_ms))
                .ok()
        })
        .collect()
}

/// Transcribe the start of each clip, `seconds` long, as one line each; None for a clip that couldn't be heard.
pub fn opening_words(model: &Path, clips: &[Clip], seconds: f32, language: Option<&str>) -> Result<Vec<Option<String>>, String> {
    need_gpu()?;
    Ok(or_none(clips, ribbon_speech::opening_words(model, clips, seconds, language)?))
}

/// Transcribe each clip, `seconds` long, phrase by phrase, with times in milliseconds of its file;
/// None for a clip that couldn't be heard, which is never the same as one with nothing said in it (#152).
/// `gentle`: one clip at a time on two threads, while a book plays, so playback comes first.
pub fn transcribe(model: &Path, clips: &[Clip], seconds: f32, language: Option<&str>, gentle: bool) -> Result<Vec<Option<Vec<Said>>>, String> {
    need_gpu()?;
    let (ways, threads) = if gentle { (1, 2) } else { (transcribe_ways(), ribbon_speech::half_the_machine()) };
    Ok(or_none(clips, ribbon_speech::transcribe(model, clips, seconds, language, ways, threads)?))
}

/// Transcribe stretches of a book's audio, phrase by phrase (#57). Runs off the main thread; gently
/// (`gentle`) on a thread of its own at a lower priority, which the threads it starts share, so the
/// audio a book is playing is never kept waiting.
#[tauri::command]
pub async fn speech_transcribe(model: String, clips: Vec<Clip>, seconds: f32, language: Option<String>, gentle: Option<bool>) -> Result<Vec<Option<Vec<Said>>>, String> {
    let gentle = gentle.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        if !gentle {
            return transcribe(Path::new(&model), &clips, seconds, language.as_deref(), false);
        }
        std::thread::spawn(move || {
            lower_priority();
            transcribe(Path::new(&model), &clips, seconds, language.as_deref(), true)
        })
        .join()
        .unwrap_or_else(|_| Err("transcribing panicked".into()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// This thread, and the ones it starts, behind the audio: Apple's "utility" class.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn lower_priority() {
    // SAFETY: changes only the calling thread's scheduling class.
    unsafe {
        libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0);
    }
}

/// Elsewhere fewer threads do the work, which is what playback needs.
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn lower_priority() {}

/// Hear the opening seconds of each clip with the model at `model`. Runs off the main thread.
#[tauri::command]
pub async fn speech_openings(model: String, clips: Vec<Clip>, seconds: f32, language: Option<String>) -> Result<Vec<Option<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || opening_words(Path::new(&model), &clips, seconds, language.as_deref())).await.map_err(|e| e.to_string())?
}

/// Let go of the speech model before the app exits. The GPU's own teardown at exit can't free a device
/// still holding a model, and aborts: every quit after hearing anything crashed. A batch still being
/// heard is waited for (the model is held while it's heard), which is seconds.
pub fn unload() {
    ribbon_speech::unload();
}

/// The model Ribbon offers to download: whisper small, multilingual, quantised (about 190 MB). Against
/// base, it hears about a third fewer words wrong, at 29 times real time on an M2's graphics against
/// base's 45 (#152).
pub const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin";
pub const MODEL_FILE: &str = "ggml-small-q5_1.bin";
pub const MODEL_PROGRESS: &str = "ribbon://model-progress";

/// Download the speech model into the Ribbon folder, reporting progress as
/// events, to a temporary file renamed into place when whole. Resolves to its path.
#[tauri::command]
pub async fn speech_download_model(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Emitter;
    let dir = crate::home::home_dir().join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join(MODEL_FILE);
    let tmp = dir.join(format!("{MODEL_FILE}.part"));
    let client = reqwest::Client::builder().user_agent(concat!("Ribbon/", env!("CARGO_PKG_VERSION"))).build().map_err(|e| e.to_string())?;
    let mut r = client.get(MODEL_URL).send().await.map_err(|e| format!("could not reach Hugging Face: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("Hugging Face answered {}", r.status()));
    }
    let total = r.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut done: u64 = 0;
    let mut last = std::time::Instant::now();
    while let Some(chunk) = r.chunk().await.map_err(|e| format!("the download stopped: {e}"))? {
        std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        if last.elapsed() > std::time::Duration::from_millis(200) {
            last = std::time::Instant::now();
            let _ = app.emit(MODEL_PROGRESS, serde_json::json!({ "done": done, "total": total }));
        }
    }
    drop(file);
    if total > 0 && done != total {
        let _ = std::fs::remove_file(&tmp);
        return Err("the download was cut short".into());
    }
    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    let _ = app.emit(MODEL_PROGRESS, serde_json::json!({ "done": done, "total": total }));
    Ok(target.to_string_lossy().into_owned())
}

/// True when a file looks like a whisper.cpp model: a ggml file of some size.
#[tauri::command]
pub fn speech_model_ok(path: String) -> bool {
    ribbon_speech::is_model(Path::new(&path))
}
