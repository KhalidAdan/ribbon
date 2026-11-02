//! The book model of an EPUB, as the app gets it, for the dev server and
//! for looking at a book: `cargo run --example ebook_json -- <epub> <cache folder>`.
//! `-- --package <epub>…` prints what a scan reads of each EPUB, one JSON
//! line each (`{"tags":{…},"hasCover":true}`, or `null`), and
//! `-- --cover <epub> <target>` copies its cover image.

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--package") {
        for path in &args[2..] {
            let line = match ribbon_lib::ebook::read_package_at(std::path::Path::new(path)) {
                Some(p) => serde_json::json!({ "tags": p.tags(), "hasCover": p.cover.is_some() }),
                None => serde_json::Value::Null,
            };
            println!("{line}");
        }
        return;
    }
    if args.get(1).map(String::as_str) == Some("--cover") {
        let (Some(src), Some(target)) = (args.get(2), args.get(3)) else {
            eprintln!("usage: ebook_json --cover <epub> <target>");
            std::process::exit(2);
        };
        match ribbon_lib::ebook::extract_cover(std::path::Path::new(src), std::path::Path::new(target)) {
            Ok(true) => println!("true"),
            Ok(false) => println!("false"),
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
        return;
    }
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
