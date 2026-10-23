//! A book's model, for the server (server/src/library/readalong.ts): the
//! same parse the app makes, so places and transcripts made on any device
//! point at the same characters.
//!
//!   ribbon-ebook <epub> <cache folder>
//!
//! Prints the model as JSON, and keeps it (with the book's images) in the
//! cache folder, so an unchanged EPUB is parsed once.

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(path), Some(cache)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: ribbon-ebook <epub> <cache folder>");
        std::process::exit(2);
    };
    match ribbon_ebook::open_cached(path, std::path::Path::new(cache)) {
        Ok(json) => println!("{json}"),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}
