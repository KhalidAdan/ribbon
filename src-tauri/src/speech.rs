//! The narrator's words, on this machine (#65): a few seconds of a book's
//! audio decoded by ffmpeg and transcribed by whisper.cpp, so a chapter's
//! opening words can be matched against the text. Nothing leaves the
//! machine. The model is a whisper.cpp `ggml` file the listener chose or
//! downloaded.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// whisper.cpp hears 16 kHz mono.
const RATE: u32 = 16_000;

/// A clip of a book's audio as whisper hears it: `seconds` from `start_ms` of `path`, 16 kHz mono f32.
pub fn decode_clip(path: &Path, start_ms: u64, seconds: f32) -> Result<Vec<f32>, String> {
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-loglevel", "error", "-nostdin"])
        // Seeking before the input is fast: ffmpeg jumps instead of decoding up to the start.
        .args(["-ss", &format!("{:.3}", start_ms as f64 / 1000.0), "-t", &format!("{seconds:.2}")])
        .arg("-i")
        .arg(path)
        .args(["-vn", "-ac", "1", "-ar", &RATE.to_string(), "-f", "f32le", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("could not run ffmpeg: {e}"))?;
    let mut bytes = Vec::new();
    child.stdout.take().expect("stdout").read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let mut err = String::new();
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_string(&mut err);
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("ffmpeg could not read the audio: {}", err.trim()));
    }
    Ok(bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
}

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

/// A loaded whisper model, kept while it is in use: loading takes a second or more.
pub struct Listener {
    ctx: WhisperContext,
    path: PathBuf,
}

impl Listener {
    pub fn load(model: &Path) -> Result<Self, String> {
        let path = model.to_string_lossy().into_owned();
        let ctx = WhisperContext::new_with_params(&path, WhisperContextParameters::default()).map_err(|e| format!("could not load the speech model: {e}"))?;
        Ok(Self { ctx, path: model.to_path_buf() })
    }

    fn params<'a>(language: Option<&'a str>, gentle: bool) -> FullParams<'a, 'a> {
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(language);
        // Half the machine at most, six threads: this runs while someone reads. Gently, two: while a book plays.
        let threads = if gentle { 2 } else { std::thread::available_parallelism().map_or(2, |n| (n.get() / 2).clamp(1, 6)) };
        params.set_n_threads(threads as i32);
        params.set_no_context(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params
    }

    /// The words in a clip, as one line. `language` is a two-letter code, or None to let whisper guess.
    pub fn words(&self, samples: &[f32], language: Option<&str>) -> Result<String, String> {
        let mut state = self.ctx.create_state().map_err(|e| e.to_string())?;
        let mut params = Self::params(language, false);
        // whisper encodes a 30-second window (1,500 frames) whatever the clip; a short clip needs only its own
        // frames, 50 a second, plus a little room. Several times faster for a few seconds of speech.
        let frames = (samples.len() as f32 / RATE as f32 * 50.0).ceil() as i32 + 64;
        params.set_audio_ctx(frames.min(1500));
        state.full(params, samples).map_err(|e| format!("could not transcribe: {e}"))?;
        let text: Vec<String> = state.as_iter().filter_map(|s| s.to_str_lossy().ok().map(|t| t.trim().to_string())).filter(|t| !t.is_empty()).collect();
        Ok(text.join(" "))
    }

    /// Everything said in a stretch of audio, phrase by phrase, each with when it starts and ends
    /// in milliseconds from the stretch's start (#57).
    pub fn said(&self, samples: &[f32], language: Option<&str>, gentle: bool) -> Result<Vec<Said>, String> {
        let mut state = self.ctx.create_state().map_err(|e| e.to_string())?;
        let params = Self::params(language, gentle);
        state.full(params, samples).map_err(|e| format!("could not transcribe: {e}"))?;
        Ok(state
            .as_iter()
            .filter_map(|seg| {
                let words = seg.to_str_lossy().ok()?.trim().to_string();
                // whisper's timestamps are hundredths of a second.
                (!words.is_empty()).then(|| Said { start_ms: seg.start_timestamp().max(0) as u64 * 10, end_ms: seg.end_timestamp().max(0) as u64 * 10, words })
            })
            .collect())
    }
}

/// A phrase heard, with when it is said.
#[derive(serde::Serialize, Clone, Debug)]
pub struct Said {
    #[serde(rename = "startMs")]
    pub start_ms: u64,
    #[serde(rename = "endMs")]
    pub end_ms: u64,
    pub words: String,
}

/// The model kept between calls, reloaded when another is asked for.
static LISTENER: Mutex<Option<Listener>> = Mutex::new(None);

/// One clip to hear: an audio file and where in it.
#[derive(serde::Deserialize)]
pub struct Clip {
    pub path: String,
    #[serde(rename = "startMs")]
    pub start_ms: u64,
}

/// Hear each clip, `seconds` long, with the model at `model`, kept loaded between calls. One answer
/// per clip, in order; a clip that could not be heard gives the empty answer rather than failing the rest.
/// `ways` clips are heard at once, each in its own whisper state: the GPU sits idle between a
/// decoder's tokens, and another state's work fills the gaps.
fn hear_clips<T: Default + Send>(model: &Path, clips: &[Clip], seconds: f32, ways: usize, hear: impl Fn(&Listener, &[f32]) -> Result<T, String> + Sync) -> Result<Vec<T>, String> {
    if !vulkan_available() {
        return Err("speech needs a graphics driver with Vulkan, and this machine has none".into());
    }
    let mut slot = LISTENER.lock().map_err(|_| "the speech model is busy".to_string())?;
    if slot.as_ref().map_or(true, |l| l.path != model) {
        *slot = Some(Listener::load(model)?);
    }
    let listener = slot.as_ref().expect("loaded");
    // Every clip is a round trip to the share: fetch them all at once while whisper waits, then hear them in turn.
    let decoded: Vec<Result<Vec<f32>, String>> = std::thread::scope(|s| {
        let jobs: Vec<_> = clips.iter().map(|c| s.spawn(move || decode_clip(Path::new(&c.path), c.start_ms, seconds))).collect();
        jobs.into_iter().map(|j| j.join().unwrap_or_else(|_| Err("decoding panicked".into()))).collect()
    });
    let one = |i: usize| match decoded[i].as_ref().map_err(|e| e.clone()).and_then(|s| hear(listener, s)) {
        Ok(t) => t,
        Err(e) => {
            log::warn!("could not hear {} at {} ms: {e}", clips[i].path, clips[i].start_ms);
            T::default()
        }
    };
    let ways = ways.clamp(1, clips.len().max(1));
    if ways == 1 {
        return Ok((0..clips.len()).map(one).collect());
    }
    let next = std::sync::atomic::AtomicUsize::new(0);
    let mut out: Vec<(usize, T)> = std::thread::scope(|s| {
        let workers: Vec<_> = (0..ways)
            .map(|_| {
                s.spawn(|| {
                    let mut mine = Vec::new();
                    loop {
                        let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        if i >= clips.len() {
                            break mine;
                        }
                        mine.push((i, one(i)));
                    }
                })
            })
            .collect();
        workers.into_iter().flat_map(|w| w.join().unwrap_or_default()).collect()
    });
    out.sort_by_key(|(i, _)| *i);
    Ok(out.into_iter().map(|(_, t)| t).collect())
}

/// How many stretches to transcribe at once: RIBBON_SPEECH_WAYS, else three: on an RTX 2070, 8 minutes of audio took 13 s one at a time, 8.3 s two at once, 7.5 s three, 7.4 s four.
fn transcribe_ways() -> usize {
    std::env::var("RIBBON_SPEECH_WAYS").ok().and_then(|s| s.parse().ok()).unwrap_or(3)
}

/// Transcribe the start of each clip, `seconds` long, as one line each.
pub fn opening_words(model: &Path, clips: &[Clip], seconds: f32, language: Option<&str>) -> Result<Vec<String>, String> {
    hear_clips(model, clips, seconds, 1, |l, s| l.words(s, language))
}

/// Transcribe each clip, `seconds` long, phrase by phrase, with times in milliseconds of its file.
/// `gentle`: one clip at a time on two threads, while a book plays, so playback comes first.
pub fn transcribe(model: &Path, clips: &[Clip], seconds: f32, language: Option<&str>, gentle: bool) -> Result<Vec<Vec<Said>>, String> {
    let ways = if gentle { 1 } else { transcribe_ways() };
    let heard = hear_clips(model, clips, seconds, ways, |l, s| l.said(s, language, gentle))?;
    Ok(clips
        .iter()
        .zip(heard)
        .map(|(c, said)| said.into_iter().map(|s| Said { start_ms: s.start_ms + c.start_ms, end_ms: s.end_ms + c.start_ms, words: s.words }).collect())
        .collect())
}

/// Transcribe stretches of a book's audio, phrase by phrase (#57). Runs off the main thread; gently
/// (`gentle`) on a thread of its own at a lower priority, which the threads it starts share, so the
/// audio a book is playing is never kept waiting.
#[tauri::command]
pub async fn speech_transcribe(model: String, clips: Vec<Clip>, seconds: f32, language: Option<String>, gentle: Option<bool>) -> Result<Vec<Vec<Said>>, String> {
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
pub async fn speech_openings(model: String, clips: Vec<Clip>, seconds: f32, language: Option<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || opening_words(Path::new(&model), &clips, seconds, language.as_deref())).await.map_err(|e| e.to_string())?
}

/// The model Ribbon offers to download: whisper base, multilingual, quantised (about 57 MB).
pub const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin";
pub const MODEL_FILE: &str = "ggml-base-q5_1.bin";
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
    let Ok(meta) = std::fs::metadata(&path) else { return false };
    if meta.len() < 10 * 1024 * 1024 {
        return false;
    }
    let mut magic = [0u8; 4];
    std::fs::File::open(&path).and_then(|mut f| f.read_exact(&mut magic)).is_ok() && u32::from_le_bytes(magic) == 0x6767_6d6c
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_clip_at_sixteen_kilohertz() {
        let dir = std::env::temp_dir().join(format!("ribbon-speech-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mp3 = dir.join("tone.mp3");
        let made = Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=22050:duration=3"])
            .arg(&mp3)
            .status()
            .unwrap();
        assert!(made.success());
        let samples = decode_clip(&mp3, 1000, 1.0).unwrap();
        // One second, give or take a frame of the encoder.
        assert!((15_000..=17_000).contains(&samples.len()), "{} samples", samples.len());
        assert!(samples.iter().any(|s| s.abs() > 0.1));
        assert!(decode_clip(&dir.join("missing.mp3"), 0, 1.0).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn knows_a_model_file_from_anything_else() {
        let dir = std::env::temp_dir().join(format!("ribbon-model-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let small = dir.join("small.bin");
        std::fs::write(&small, b"lmgg").unwrap();
        assert!(!speech_model_ok(small.to_string_lossy().into_owned()));
        let wrong = dir.join("wrong.bin");
        std::fs::write(&wrong, vec![0u8; 11 * 1024 * 1024]).unwrap();
        assert!(!speech_model_ok(wrong.to_string_lossy().into_owned()));
        let mut good = 0x6767_6d6c_u32.to_le_bytes().to_vec();
        good.resize(11 * 1024 * 1024, 0);
        let model = dir.join("ggml-test.bin");
        std::fs::write(&model, good).unwrap();
        assert!(speech_model_ok(model.to_string_lossy().into_owned()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
