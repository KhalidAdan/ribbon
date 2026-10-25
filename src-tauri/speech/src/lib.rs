//! The narrator's words (#65, #57): stretches of a book's audio decoded by
//! ffmpeg and heard by whisper.cpp, as one line or phrase by phrase with when
//! each phrase and word is said. The app hears with it on a machine with a
//! graphics card (src-tauri/src/speech.rs), for its own books and for a
//! server's (#152). The model is a whisper.cpp `ggml` file.

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

/// Half the machine at most, six threads: what hearing takes while someone reads.
pub fn half_the_machine() -> usize {
    std::thread::available_parallelism().map_or(2, |n| (n.get() / 2).clamp(1, 6))
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

    fn params<'a>(language: Option<&'a str>, threads: usize) -> FullParams<'a, 'a> {
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(language);
        params.set_n_threads(threads.max(1) as i32);
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
        let mut params = Self::params(language, half_the_machine());
        // whisper encodes a 30-second window (1,500 frames) whatever the clip; a short clip needs only its own
        // frames, 50 a second, plus a little room. Several times faster for a few seconds of speech.
        let frames = (samples.len() as f32 / RATE as f32 * 50.0).ceil() as i32 + 64;
        params.set_audio_ctx(frames.min(1500));
        state.full(params, samples).map_err(|e| format!("could not transcribe: {e}"))?;
        let text: Vec<String> = state.as_iter().filter_map(|s| s.to_str_lossy().ok().map(|t| t.trim().to_string())).filter(|t| !t.is_empty()).collect();
        Ok(text.join(" "))
    }

    /// Everything said in a stretch of audio, phrase by phrase, each with when it starts and ends
    /// in milliseconds from the stretch's start (#57), and when each of its words starts, heard on
    /// `threads` threads.
    pub fn said(&self, samples: &[f32], language: Option<&str>, threads: usize) -> Result<Vec<Said>, String> {
        let mut state = self.ctx.create_state().map_err(|e| e.to_string())?;
        let mut params = Self::params(language, threads);
        // Each token's time, so each word's: when a word is said, rather than a guess by its place in its phrase.
        params.set_token_timestamps(true);
        state.full(params, samples).map_err(|e| format!("could not transcribe: {e}"))?;
        let eot = self.ctx.token_eot();
        Ok(state
            .as_iter()
            .filter_map(|seg| {
                let words = seg.to_str_lossy().ok()?.trim().to_string();
                if words.is_empty() {
                    return None;
                }
                let word_ms = word_starts(&seg, eot, words.split_whitespace().count());
                // whisper's timestamps are hundredths of a second.
                Some(Said { start_ms: seg.start_timestamp().max(0) as u64 * 10, end_ms: seg.end_timestamp().max(0) as u64 * 10, words, word_ms })
            })
            .collect())
    }
}

/// When each word of a phrase starts, in milliseconds from its stretch's start: the time of the first
/// token of each, a word being the tokens from one that starts with a space to the next. Tokens from
/// the end-of-text token on are whisper's own (timestamps, language), not words. Empty when the words
/// found aren't `count`, the phrase's words apart by spaces, so a word is never given another's time.
fn word_starts(seg: &whisper_rs::WhisperSegment<'_>, eot: whisper_rs::WhisperTokenId, count: usize) -> Vec<u64> {
    let mut starts = Vec::new();
    let mut in_word = false;
    for i in 0..seg.n_tokens() {
        let Some(token) = seg.get_token(i) else { continue };
        if token.token_id() >= eot {
            continue;
        }
        let Ok(text) = token.to_str_lossy() else { continue };
        if text.trim().is_empty() {
            in_word = false;
            continue;
        }
        if text.starts_with(char::is_whitespace) || !in_word {
            starts.push(token.token_data().t0.max(0) as u64 * 10);
        }
        in_word = !text.ends_with(char::is_whitespace);
    }
    if starts.len() == count {
        starts
    } else {
        Vec::new()
    }
}

/// A phrase heard, with when it is said, and when each of its words starts when whisper said.
#[derive(serde::Serialize, Clone, Debug)]
pub struct Said {
    #[serde(rename = "startMs")]
    pub start_ms: u64,
    #[serde(rename = "endMs")]
    pub end_ms: u64,
    pub words: String,
    #[serde(rename = "wordMs", skip_serializing_if = "Vec::is_empty")]
    pub word_ms: Vec<u64>,
}

/// The model kept between calls, reloaded when another is asked for.
static LISTENER: Mutex<Option<Listener>> = Mutex::new(None);

/// Let go of the model kept loaded, if one is.
pub fn unload() {
    if let Ok(mut slot) = LISTENER.lock() {
        *slot = None;
    }
}

/// One clip to hear: an audio file and where in it.
#[derive(serde::Deserialize, Clone, Debug)]
pub struct Clip {
    pub path: String,
    #[serde(rename = "startMs")]
    pub start_ms: u64,
}

/// Hear each clip, `seconds` long, with the model at `model`, kept loaded between calls. One answer
/// per clip, in order, each heard or why it couldn't be: a clip that fails doesn't fail the rest.
/// `ways` clips are heard at once, each in its own whisper state: the GPU sits idle between a
/// decoder's tokens, and another state's work fills the gaps.
fn hear_clips<T: Send>(model: &Path, clips: &[Clip], seconds: f32, ways: usize, hear: impl Fn(&Listener, &[f32]) -> Result<T, String> + Sync) -> Result<Vec<Result<T, String>>, String> {
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
    let one = |i: usize| decoded[i].as_ref().map_err(|e| e.clone()).and_then(|s| hear(listener, s));
    let ways = ways.clamp(1, clips.len().max(1));
    if ways == 1 {
        return Ok((0..clips.len()).map(one).collect());
    }
    let next = std::sync::atomic::AtomicUsize::new(0);
    let mut out: Vec<(usize, Result<T, String>)> = std::thread::scope(|s| {
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

/// The start of each clip, `seconds` long, as one line each.
pub fn opening_words(model: &Path, clips: &[Clip], seconds: f32, language: Option<&str>) -> Result<Vec<Result<String, String>>, String> {
    hear_clips(model, clips, seconds, 1, |l, s| l.words(s, language))
}

/// Each clip, `seconds` long, phrase by phrase, with times in milliseconds of its file: `ways` clips
/// at once, each on `threads` threads.
pub fn transcribe(model: &Path, clips: &[Clip], seconds: f32, language: Option<&str>, ways: usize, threads: usize) -> Result<Vec<Result<Vec<Said>, String>>, String> {
    let heard = hear_clips(model, clips, seconds, ways, |l, s| l.said(s, language, threads))?;
    Ok(clips
        .iter()
        .zip(heard)
        .map(|(c, said)| {
            said.map(|said| {
                said.into_iter()
                    .map(|s| Said { start_ms: s.start_ms + c.start_ms, end_ms: s.end_ms + c.start_ms, words: s.words, word_ms: s.word_ms.into_iter().map(|w| w + c.start_ms).collect() })
                    .collect()
            })
        })
        .collect())
}

/// True when a file looks like a whisper.cpp model: a ggml file of some size.
pub fn is_model(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else { return false };
    if meta.len() < 10 * 1024 * 1024 {
        return false;
    }
    let mut magic = [0u8; 4];
    std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut magic)).is_ok() && u32::from_le_bytes(magic) == 0x6767_6d6c
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
        assert!(!is_model(&small));
        let wrong = dir.join("wrong.bin");
        std::fs::write(&wrong, vec![0u8; 11 * 1024 * 1024]).unwrap();
        assert!(!is_model(&wrong));
        let mut good = 0x6767_6d6c_u32.to_le_bytes().to_vec();
        good.resize(11 * 1024 * 1024, 0);
        let model = dir.join("ggml-test.bin");
        std::fs::write(&model, good).unwrap();
        assert!(is_model(&model));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
