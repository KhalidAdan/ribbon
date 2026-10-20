# End-to-end checks

What unit tests cannot see, checked in the built app with real input: a
book opening from cold and to the page left, pages swiped, the window
resized, the narrator followed, the whole book scrolled through. They run
before every release ([docs/RELEASING.md](../../docs/RELEASING.md)). The
0.12.0 regression, where resizing blanked the reader, is why they exist:
nothing covered resizing.

```bash
npm run e2e -- --build
```

That builds the measurement build and runs every check. After that, `npm run e2e`
runs them against the last build. Some checks only: `npm run e2e -- swipe resize`.
With the CPU six times slower, as a slow laptop or a phone: `--slow 6`. It exits
non-zero and lists what failed.

| Check | What it holds Ribbon to |
| --- | --- |
| `open` | Opens from cold. Opened again, it draws the page you left at once (the snapshot) and the real page replaces it without moving. Read last, it opens at your page, ready no later than its pairing. Listened to last, it opens at the narrator. |
| `swipe` | The page follows a pen or finger; a long drag turns, a short slow one springs back, a quick flick turns; a trackpad's sideways swipe turns; a mouse turns on the press, once. |
| `resize` | In pages and in scroll, no frame without text while the window's edge is dragged; laid out again for the new size; text when it is back. |
| `readalong` | The narrator's sentence is marked and the mark moves on, the page turns with the narrator, the bar counts down; turning away stops following and offers Go to the narrator, which brings it back. |
| `scroll` | The wheel scrolls and the place follows; the whole book scrolls through in 10 s without a frame lacking text, ending in its last section. |

## The speed report

```bash
npm run e2e -- speed
npm run e2e -- speed --slow 6
```

How fast Ribbon feels: opening, page turns by key and click, scrolling, the whole
book, reading along, playing with the library showing. Each part prints what the
app measured of itself (`src/app/perf.ts`): React's renders, input to the frame
that showed it, long tasks, chapter layout, time between frames. It is not a pass
or a fail. Compare it with the last release's numbers.

## What it needs

- **Windows.** The app's webview there is WebView2, which is Chromium: started with
  a debugging port, playwright-core drives it over CDP. macOS's WKWebView has no
  such port, so on a Mac these checks cannot run yet ([docs/MAC.md](../../docs/MAC.md)).
- **The measurement build** (`RIBBON_PROFILE=1`, which `--build` makes). It uses
  React's profiling build and puts the controller on the page as `window.__ribbon`
  for the checks. Release installers are built without it.
- **A test library**: a folder with one book that you own as audio *and* EPUB, with
  its narration transcribed (open it in Ribbon with a speech model once, and let
  read-along finish), so its `.ribbon/` holds the transcript. Put it in
  `.e2e/library` (ignored by git) or name it with `--library` or `RIBBON_E2E_LIBRARY`.
  Ribbon writes `.ribbon/` records into it as it runs, **so never point it at your
  real library** (and never at a share). The checks use sections 10 to 20 of the
  book, so it should be a novel, not a short story.

Each run starts the app with a fresh Ribbon folder and webview profile under
`.e2e/run`, so no run depends on the one before. `--attach` drives an app already
running with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`
instead.

## Adding a check

A check is a `Check` in `checks/`, listed in `run.ts`: a name, one line saying
what it covers, and `run(ribbon, tally)`. Drive the app as a reader would (keys,
clicks, the wheel, `Input.dispatchMouseEvent` with a pen), read `window.__ribbon`
to see what happened, and `tally.expect(holds, "what a reader would notice", detail)`.
`app.ts` has the shared parts: opening the reader, silence, lines on screen, the place.
