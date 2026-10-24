//! Stretches of a book's narration heard phrase by phrase, for the server
//! (server/src/library/transcribe.ts): the same hearing the app does for
//! read-along, so a transcript made on the server matches one made on a device.
//!
//!   ribbon-speech <model> <seconds> <language|auto> <ways> <threads>
//!
//! Reads batches of clips from stdin, one JSON list a line,
//! `[{"path":…,"startMs":…}, …]`, and answers each with a line: one answer per
//! clip, in order, the phrases heard with their times in milliseconds of the
//! clip's file (`[{"startMs":…,"endMs":…,"words":…}, …]`), or `{"error":…}`
//! when the clip couldn't be heard. The model is loaded once, for every batch,
//! and let go when stdin closes.

use std::io::{BufRead, Write};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let parsed = (|| {
        let [model, seconds, language, ways, threads] = args.as_slice() else { return None };
        let language = (language != "auto").then_some(language.as_str());
        Some((model, seconds.parse::<f32>().ok()?, language, ways.parse::<usize>().ok()?, threads.parse::<usize>().ok()?))
    })();
    let Some((model, seconds, language, ways, threads)) = parsed else {
        eprintln!("usage: ribbon-speech <model> <seconds> <language|auto> <ways> <threads>, with a JSON list of clips on each line of stdin");
        std::process::exit(2);
    };
    let mut out = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let answer = match serde_json::from_str::<Vec<ribbon_speech::Clip>>(&line) {
            Err(e) => serde_json::json!({ "error": format!("the clips aren't a JSON list of {{path, startMs}}: {e}") }),
            Ok(clips) => match ribbon_speech::transcribe(std::path::Path::new(model), &clips, seconds, language, ways, threads) {
                // The model itself failed: every batch would, so say so and stop.
                Err(e) => {
                    eprintln!("{e}");
                    ribbon_speech::unload();
                    std::process::exit(1);
                }
                Ok(heard) => serde_json::Value::Array(
                    heard
                        .into_iter()
                        .map(|h| match h {
                            Ok(said) => serde_json::json!(said),
                            Err(error) => serde_json::json!({ "error": error }),
                        })
                        .collect(),
                ),
            },
        };
        if writeln!(out, "{answer}").and_then(|_| out.flush()).is_err() {
            break;
        }
    }
    // Before the GPU's own teardown at exit, which won't free a device still holding a model.
    ribbon_speech::unload();
}
