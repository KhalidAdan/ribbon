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

    /// The words in a clip, as one line. `language` is a two-letter code, or None to let whisper guess.
    pub fn words(&self, samples: &[f32], language: Option<&str>) -> Result<String, String> {
        let mut state = self.ctx.create_state().map_err(|e| e.to_string())?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(language);
        // Half the machine at most: this runs while someone reads.
        params.set_n_threads(std::thread::available_parallelism().map_or(2, |n| (n.get() / 2).clamp(1, 4)) as i32);
        params.set_no_context(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        state.full(params, samples).map_err(|e| format!("could not transcribe: {e}"))?;
        let text: Vec<String> = state.as_iter().filter_map(|s| s.to_str_lossy().ok().map(|t| t.trim().to_string())).filter(|t| !t.is_empty()).collect();
        Ok(text.join(" "))
    }
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

/// Transcribe the start of each clip, `seconds` long. One answer per clip, in order; a clip that
/// could not be heard gives an empty answer rather than failing the rest.
pub fn opening_words(model: &Path, clips: &[Clip], seconds: f32, language: Option<&str>) -> Result<Vec<String>, String> {
    let mut slot = LISTENER.lock().map_err(|_| "the speech model is busy".to_string())?;
    if slot.as_ref().map_or(true, |l| l.path != model) {
        *slot = Some(Listener::load(model)?);
    }
    let listener = slot.as_ref().expect("loaded");
    Ok(clips
        .iter()
        .map(|c| match decode_clip(Path::new(&c.path), c.start_ms, seconds).and_then(|s| listener.words(&s, language)) {
            Ok(t) => t,
            Err(e) => {
                log::warn!("could not hear {} at {} ms: {e}", c.path, c.start_ms);
                String::new()
            }
        })
        .collect())
}

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
