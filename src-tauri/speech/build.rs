fn main() {
  // On the GPU on Windows (the `vulkan` feature), whisper.cpp links vulkan-1.dll, which comes with
  // every graphics driver, but not with a machine that has none: load it only when speech is first
  // used, so this crate's command and tests start anyway, as the app does (src-tauri/build.rs).
  if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") && std::env::var_os("CARGO_FEATURE_VULKAN").is_some() {
    println!("cargo:rustc-link-arg=/DELAYLOAD:vulkan-1.dll");
    println!("cargo:rustc-link-lib=delayimp");
  }
}
