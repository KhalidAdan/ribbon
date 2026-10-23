//! Where a moment of an MP3 starts, for the server (server/src/library/frames.ts):
//! the same frame the app would play from, so the TV hears what it shows.
//!
//!   ribbon-frames <mp3> <index file> <ms>
//!
//! Prints `{"byte":…,"ms":…}`: the byte where the frame holding that moment
//! starts, and the moment that frame starts at. The file's frame index is kept
//! in the index file, so a file is read whole only once.

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(mp3), Some(kept), Some(ms)) = (args.get(1), args.get(2), args.get(3).and_then(|m| m.parse::<f64>().ok())) else {
        eprintln!("usage: ribbon-frames <mp3> <index file> <ms>");
        std::process::exit(2);
    };
    match ribbon_frames::index_kept_at(std::path::Path::new(mp3), std::path::Path::new(kept)) {
        Ok(index) => {
            let (byte, at) = index.at(ms);
            println!("{{\"byte\":{byte},\"ms\":{}}}", at.round());
        }
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}
