//! Everything a narrator says in stretches of a book, phrase by phrase, as the app hears it for
//! read-along (#57): `cargo run --release --example transcribe -- <model> <seconds> <language|auto> <audio> <ms> [<audio> <ms>…]`.
//! RIBBON_BATCH=N hears N stretches per call; RIBBON_GENTLE=1 hears them as while a book plays (one at
//! a time, two threads). Prints each phrase with its times, and how long each call took.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 5 || args.len() % 2 == 0 {
        eprintln!("usage: transcribe <model> <seconds> <language|auto> <audio> <ms> [<audio> <ms>…]");
        std::process::exit(2);
    }
    let model = std::path::Path::new(&args[0]);
    let seconds: f32 = args[1].parse().expect("seconds");
    let language = if args[2] == "auto" { None } else { Some(args[2].as_str()) };
    let clips: Vec<ribbon_lib::speech::Clip> = args[3..].chunks(2).map(|c| ribbon_lib::speech::Clip { path: c[0].clone(), start_ms: c[1].parse().expect("ms") }).collect();
    let started = std::time::Instant::now();
    let _ = ribbon_lib::speech::opening_words(model, &clips[..1], 1.0, language).expect("load");
    eprintln!("model loaded in {:?}", started.elapsed());
    let n = std::env::var("RIBBON_BATCH").ok().and_then(|s| s.parse::<usize>().ok()).unwrap_or(1).max(1);
    let gentle = std::env::var("RIBBON_GENTLE").is_ok_and(|v| v == "1");
    let all = std::time::Instant::now();
    for batch in clips.chunks(n) {
        let t = std::time::Instant::now();
        let said = ribbon_lib::speech::transcribe(model, batch, seconds, language, gentle).expect("transcribe");
        eprintln!("{} stretches of {seconds} s in {:.1} s", batch.len(), t.elapsed().as_secs_f32());
        for s in said.into_iter().flatten() {
            println!("{:>9} {:>9}  {}", s.start_ms, s.end_ms, s.words);
        }
    }
    eprintln!("{} s of audio in {:.1} s", clips.len() as f32 * seconds, all.elapsed().as_secs_f32());
}
