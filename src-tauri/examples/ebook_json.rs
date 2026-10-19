//! The book model of an EPUB, as the app gets it, for the dev server and
//! for looking at a book: `cargo run --example ebook_json -- <epub> <cache folder>`.

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(path), Some(cache)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: ebook_json <epub> <cache folder>");
        std::process::exit(2);
    };
    match ribbon_lib::ebook::open_cached(path, std::path::Path::new(cache)) {
        Ok(json) => println!("{json}"),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}
