# Releasing Ribbon

A release is a version number, the installers on GitHub (two for Windows, a
disk image for the Mac), and the end-to-end checks passing on the commit they
came from. GitHub runs the checks and the end-to-end checks on every change
([checks.yml](../.github/workflows/checks.yml), [e2e.yml](../.github/workflows/e2e.yml))
and builds the installers from a version tag
([release.yml](../.github/workflows/release.yml)). In order:

## 1. Everything merged, everything green

The checks ([checks.yml](../.github/workflows/checks.yml)) run the types, the
unit tests and the Rust tests on Windows and on a Mac, for every pull request
and every push to `main`. `main` is green when its last run passed:

```bash
gh run list --workflow checks.yml --branch main --limit 1
```

The same three by hand:

```bash
npm run typecheck
npm test
npm run test:rust
```

## 2. The end-to-end checks, at both speeds

GitHub runs them at both speeds, side by side, on Windows, for every pull
request and every push to `main` ([e2e.yml](../.github/workflows/e2e.yml)), with
the public test library (The Wonderful Wizard of Oz,
[packages/desktop/tools/e2e](../packages/desktop/tools/e2e/README.md)). A pull request that changes only the docs
skips them. `main` is ready when its last run passed:

```bash
gh run list --workflow e2e.yml --branch main --limit 1
```

The same on the PC, with the public library or one of your own:

```bash
npm run e2e:library
npm run e2e -- --build --library .e2e/public-library
npm run e2e -- --slow 6 --library .e2e/public-library
```

Every check passes at both speeds.

On `main`, and when run by hand (`gh workflow run e2e.yml --ref <branch>`, for
speed work on a branch), a third job takes the speed report at both speeds and
sets it beside the last release's numbers (`packages/desktop/tools/e2e/speed-baseline.json`) on the run's summary page,
marking what moved by more than a quarter and more than 2 ms. A shared runner
is noisy, so a mark is a question rather than a verdict, but a number that got
worse is a question to answer before the release, not after. When a release
touches the reader, the player or opening books, also take the report on the PC,
where the hardware is real:

```bash
npm run e2e -- speed --json .e2e/speed-1x.json
npm run e2e -- speed --slow 6 --json .e2e/speed-6x.json
```

## 3. The version, in five files

`packages/desktop/package.json` and `package-lock.json` (`npm version X.Y.Z
--no-git-tag-version -w @ribbon/desktop` does both), and `packages/desktop/src-tauri/Cargo.toml`, `packages/desktop/src-tauri/Cargo.lock` (the `ribbon`
package) and `packages/desktop/src-tauri/tauri.conf.json`. Commit them as "Release X.Y.Z" on
`main` and push.

## 4. The installers

Tag the release commit and push the tag:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

The release workflow checks that the tag is the version in `package.json`,
makes a draft release, "Ribbon X.Y.Z", and builds on Windows and on a Mac
(Apple Silicon), without `RIBBON_PROFILE`: the installers are the plain build.
It attaches `Ribbon_X.Y.Z_x64-setup.exe`, `Ribbon_X.Y.Z_x64_en-US.msi` and
`Ribbon_X.Y.Z_aarch64.dmg` to the draft. Follow it with `gh run watch`.

To build the installers for a tag again (a run failed, or a release is missing
one), run the workflow by hand; files already attached are replaced:

```bash
gh workflow run release.yml -f tag=vX.Y.Z
```

### By hand

```bash
npm run tauri build
```

On Windows this needs the Vulkan SDK, LLVM and CMake for whisper.cpp (see
[MAC.md](MAC.md) for the Mac's equivalents). A shell started before the SDK was
installed lacks `VULKAN_SDK`: set it to the SDK's folder and put its `Bin` on the
`PATH` first. The installers land in `target/release/bundle/nsis` (`.exe`) and
`target/release/bundle/msi` (`.msi`); on a Mac, in `target/release/bundle/dmg`.
Attach them to the draft with `gh release upload vX.Y.Z <files> --clobber`.

The tag also publishes the server's image, for Intel and ARM machines, as
`ghcr.io/khalidadan/ribbon-server` at the version and at `latest`
([server-image.yml](../.github/workflows/server-image.yml)).

## 5. On GitHub

The notes say what changed for someone using Ribbon, in plain words. They open
with what it runs on and what it installs over: "Windows x64 and macOS (Apple
Silicon). Installs over any 0.12, 0.11, … release, and everything carries
over." Then publish the draft:

```bash
gh release edit vX.Y.Z --notes-file notes.md --draft=false
```

## 6. Installed

The setup installs over the running version only when Ribbon is closed. Run
`Ribbon_X.Y.Z_x64-setup.exe` (or `/S` for a silent install) and check the
version in Settings.

On a Mac, close Ribbon, open the `.dmg` and drag Ribbon to Applications. The
build is not signed with an Apple Developer ID, so the first time a downloaded
version opens, macOS refuses: open it from System Settings → Privacy & Security
→ Open Anyway.

## A change meant to change nothing

Moving folders or tidying a build should leave the app exactly as it was, and
passing tests can't show that: no test notices a style going missing. Vite's
build is repeatable, so the app itself can be compared, file for file. On every
pull request the **Same app** check says whether it built the same app as its
base, and with the label `same-app` a difference fails it. By hand:

```bash
npm run build
node tools/same-app.mjs ../other-checkout .
```

The **Server image** check builds the server's Docker image and starts it as a
stranger would, adds a folder and lists its book (`tools/check-server-image.sh`,
which also runs by hand). A pull request that changes how the installers are
built builds them too, as downloads on its run.

## Merging a stack of pull requests

When pull requests are stacked (each based on the one before), merge them in
order **without deleting their branches** until the last is in: deleting a
merged base branch makes GitHub close the pull request stacked on it rather
than move it to `main`. Point each at `main` (`gh pr edit N --base main`) once
the one below it is merged, then delete the branches at the end.
