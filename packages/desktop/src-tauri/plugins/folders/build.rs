const COMMANDS: &[&str] = &["pick", "restore", "keep"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
