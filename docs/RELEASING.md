# Releasing Ribbon

A release is a version number, two Windows installers on GitHub, and the
end-to-end checks passing on the build they came from. In order:

## 1. Everything merged, everything green

```bash
npm run typecheck
npm test
npm run test:rust
```

## 2. The end-to-end checks, at both speeds

```bash
npm run e2e -- --build
npm run e2e -- --slow 6
```

Every check passes at both speeds ([tools/e2e](../tools/e2e/README.md)). When a
release touches the reader, the player or opening books, also run the speed
report at both speeds and compare it with the last release's numbers:

```bash
npm run e2e -- speed
npm run e2e -- speed --slow 6
```

A number that got worse is a question to answer before the release, not after.

## 3. The version, in five files

`package.json` and `package-lock.json` (`npm version X.Y.Z --no-git-tag-version`
does both), and `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` (the `ribbon`
package) and `src-tauri/tauri.conf.json`. Commit them as "Release X.Y.Z" on
`main` and push.

## 4. The installers

Built without `RIBBON_PROFILE`: the installers are the plain build.

```bash
npm run tauri build
```

On Windows this needs the Vulkan SDK, LLVM and CMake for whisper.cpp (see
[MAC.md](MAC.md) for the Mac's equivalents). A shell started before the SDK was
installed lacks `VULKAN_SDK`: set it to the SDK's folder and put its `Bin` on the
`PATH` first. The installers land in `target/release/bundle/nsis` (`.exe`) and
`target/release/bundle/msi` (`.msi`).

## 5. On GitHub

```bash
gh release create vX.Y.Z --target main --title "Ribbon X.Y.Z" --notes-file notes.md target/release/bundle/nsis/Ribbon_X.Y.Z_x64-setup.exe target/release/bundle/msi/Ribbon_X.Y.Z_x64_en-US.msi
```

The notes say what changed for someone using Ribbon, in plain words. They open
with what it runs on and what it installs over: "Windows x64. Installs over any
0.12, 0.11, … release, and everything carries over."

## 6. Installed

The setup installs over the running version only when Ribbon is closed. Run
`Ribbon_X.Y.Z_x64-setup.exe` (or `/S` for a silent install) and check the
version in Settings.

## Merging a stack of pull requests

When pull requests are stacked (each based on the one before), merge them in
order **without deleting their branches** until the last is in: deleting a
merged base branch makes GitHub close the pull request stacked on it rather
than move it to `main`. Point each at `main` (`gh pr edit N --base main`) once
the one below it is merged, then delete the branches at the end.
