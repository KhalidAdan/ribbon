// swift-tools-version:5.3

import PackageDescription

let package = Package(
  name: "tauri-plugin-folders",
  platforms: [
    .iOS(.v14)
  ],
  products: [
    .library(
      name: "tauri-plugin-folders",
      type: .static,
      targets: ["tauri-plugin-folders"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-folders",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
