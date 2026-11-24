//! A CBR for the server and for Node (packages/host-node/src/cbr.ts), which have no RAR
//! reader of their own: the same one the app reads a CBR with.
//!
//!   ribbon-cbr list <cbr>            its files, as `{"entries":[{"name":…,"size":…,"packed":…}]}`
//!   ribbon-cbr entry <cbr> <name>    one file's bytes, on standard output
//!   ribbon-cbr cbz <cbr> <cbz>       the comic written out as a CBZ, its pages stored
//!
//! A CBR that is refused (locked, split, broken) is refused in a sentence on standard
//! error, and the command ends with 1.

use ribbon_cbr::{Cbr, PAGE_MAX};
use std::io::Write;
use std::path::Path;

fn run(args: &[String]) -> Result<(), String> {
    let open = |file: &String| Cbr::open(Path::new(file)).map_err(|e| e.to_string());
    match args {
        [what, file] if what == "list" => {
            let entries: Vec<_> = open(file)?.entries().iter().map(|e| serde_json::json!({ "name": e.name, "size": e.size, "packed": e.packed })).collect();
            println!("{}", serde_json::json!({ "entries": entries }));
            Ok(())
        }
        [what, file, name] if what == "entry" => {
            let bytes = open(file)?.read_entry(name, PAGE_MAX)?;
            std::io::stdout().write_all(&bytes).map_err(|e| e.to_string())
        }
        [what, file, target] if what == "cbz" => open(file)?.write_cbz(Path::new(target)),
        _ => {
            eprintln!("usage: ribbon-cbr list <cbr> | entry <cbr> <name> | cbz <cbr> <cbz>");
            std::process::exit(2);
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(why) = run(&args) {
        eprintln!("{why}");
        std::process::exit(1);
    }
}
