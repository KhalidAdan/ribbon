# One shelf, two renderers

The desktop's bookcase (three.js, in `src/bookcase3d`) is meant to look like the Apple app's (SceneKit, in
`packages/apple/Ribbon/Bookcase`). These pages are how that is checked: both draw the same thirty public-domain
books, and the pages set the two pictures side by side.

```bash
npm run dev -w @ribbon/desktop
```

- `/tools/shelf-proof/index.html`: the shelf from the front, the desktop's above the Apple app's. In the console,
  `proof.layout` lists where the two layouts differ (nothing, when the rules match) and `proof.compare()` gives how
  far apart the two pictures are, in colour steps out of 255.
- `/tools/shelf-proof/angles.html`: the same shelf from seven other angles, two with a book pulled out. `?only=<name>`
  shows one at full size.

Any number of the lamps and the developing (`LAMP` in `src/bookcase3d/lamplight.ts`) can be tried from the address
bar, as `?lamp=300000&exposure=1.2`. `node tools/shelf-proof/snap.mjs <address> <file.png>` saves a page as a picture.

## The Apple app's pictures

`ref/` holds what SceneKit drew: `scenekit-*.jpg`, and `scenekit-layout.json`, where it put every book. They are
made by `ShelfReference.swift`, which is kept here and not among the Apple app's tests because it writes files. To
make them again after the Apple bookcase changes:

```bash
cp packages/desktop/tools/shelf-proof/ShelfReference.swift packages/apple/RibbonTests/
cd packages/apple && xcodegen generate
TEST_RUNNER_SHELF_FOLDER=<a folder holding ref/books.json and ref/views.json> xcodebuild test \
  -project Ribbon.xcodeproj -scheme Ribbon -destination 'platform=iOS Simulator,name=<an iPad>' \
  -only-testing:RibbonTests/ShelfReference CODE_SIGNING_ALLOWED=NO
rm packages/apple/RibbonTests/ShelfReference.swift
```

It writes PNGs; `sips -s format jpeg -s formatOptions 88` makes the JPEGs kept here.

## What made the two match

Each of these was found by measuring the two pictures, and each is commented where it is done:

- SceneKit reads the studio's light with nothing brighter than white (`textures.ts`), and the studio stands turned
  half way round (`studioTurn`).
- SceneKit reads the scanned cloth at full sharpness however small it is drawn (`sharp` in `textures.ts`).
- The lamps' strength, the fill, and the curve the picture is developed with (`LAMP`).

Still different, and left so by the owner's choice (10 November 2026): SceneKit's fine stripes on the books' sides
and tops, a harder edge to the shadow from the shelf above, and slightly duller foil away from the lamp.
