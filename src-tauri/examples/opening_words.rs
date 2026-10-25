//! What a narrator says at the start of each of a book's chapters, as the
//! app hears it: `cargo run --release --example opening_words -- <model> <seconds> <language|auto> <audio> <ms> [<audio> <ms>…]`.
//! Prints one line per clip, with how long it took.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 5 || args.len() % 2 == 0 {
        eprintln!("usage: opening_words <model> <seconds> <language|auto> <audio> <ms> [<audio> <ms>…]");
        std::process::exit(2);
    }
    let model = std::path::Path::new(&args[0]);
    let seconds: f32 = args[1].parse().expect("seconds");
    let language = if args[2] == "auto" { None } else { Some(args[2].as_str()) };
    let clips: Vec<ribbon_lib::speech::Clip> = args[3..].chunks(2).map(|c| ribbon_lib::speech::Clip { path: c[0].clone(), start_ms: c[1].parse().expect("ms") }).collect();
    let started = std::time::Instant::now();
    let _ = ribbon_lib::speech::opening_words(model, &clips[..1], 1.0, language).expect("load");
    eprintln!("model loaded in {:?}", started.elapsed());
    // RIBBON_BATCH=6 hears clips in batches, the way the app does: each batch's clips are fetched at once.
    if let Some(n) = std::env::var("RIBBON_BATCH").ok().and_then(|s| s.parse::<usize>().ok()).filter(|&n| n > 1) {
        for batch in clips.chunks(n) {
            let t = std::time::Instant::now();
            let words = ribbon_lib::speech::opening_words(model, batch, seconds, language).expect("words");
            let each = t.elapsed().as_secs_f32() / batch.len() as f32;
            for (c, w) in batch.iter().zip(words) {
                println!("{:>9} ms  {each:>6.1}s  {}", c.start_ms, w.as_deref().unwrap_or("(could not hear it)"));
            }
        }
        return;
    }
    for c in &clips {
        let t = std::time::Instant::now();
        if let Err(e) = ribbon_lib::speech::decode_clip(std::path::Path::new(&c.path), c.start_ms, seconds) {
            eprintln!("{:>9} ms  could not decode: {e}", c.start_ms);
            continue;
        }
        let words = ribbon_lib::speech::opening_words(model, std::slice::from_ref(c), seconds, language).expect("words");
        println!("{:>9} ms  {:>6.1}s  {}", c.start_ms, t.elapsed().as_secs_f32(), words[0].as_deref().unwrap_or("(could not hear it)"));
    }
}
