fn main() {
  // Speech runs on the GPU through Vulkan (whisper.cpp). vulkan-1.dll comes with
  // every graphics driver, but not with a machine that has none: load it only
  // when speech is first used, so Ribbon itself always starts. speech.rs checks
  // it is there before hearing anything.
  if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
    println!("cargo:rustc-link-arg=/DELAYLOAD:vulkan-1.dll");
    println!("cargo:rustc-link-lib=delayimp");
  }
  tauri_build::build()
}
