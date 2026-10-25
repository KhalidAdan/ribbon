#!/bin/sh
# Ribbon's icon for the Apple TV and the iPad, made from the app's own
# (src-tauri/icons/icon-ios.svg): tvOS wants it in layers, so the focus can
# tilt it, at its own sizes, and a wide Top Shelf picture besides. The back
# layer is the icon's near-black tile; the front is the open book with its
# ribbon. The iPad takes it whole. Run it again when the icon changes:
#
#   sh tv/make-icons.sh
#
# Needs rsvg-convert and ImageMagick (brew install librsvg imagemagick).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
svg="$here/../src-tauri/icons/icon-ios.svg"
out="$here/Ribbon/Assets.xcassets/App Icon & Top Shelf Image.brandassets"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The book alone, on nothing: the icon without its tile, cut to what it draws.
grep -v 'fill="url(#tile)"' "$svg" > "$work/book.svg"
rsvg-convert -w 2048 -h 2048 "$work/book.svg" -o "$work/book-big.png"
magick "$work/book-big.png" -trim +repage "$work/book.png"

# back <width> <height> <file>: the tile's gradient, edge to edge, in colour
# (a grey gradient is kept as greyscale, and the book laid on it would turn grey too).
back() { magick -size "$1x$2" gradient:'#242424'-'#0a0a0a' -colorspace sRGB -type TrueColor "PNG24:$3"; }
# front <width> <height> <book height> <file>: the book, centred, on nothing.
front() { magick -background none "$work/book.png" -resize "x$3" -gravity center -extent "$1x$2" "$4"; }
# shelf <width> <height> <book height> <file>: the book on the tile, one picture.
shelf() { back "$1" "$2" "$work/shelf-back.png"; front "$1" "$2" "$3" "$work/shelf-front.png"; magick "$work/shelf-back.png" "$work/shelf-front.png" -composite "PNG24:$4"; }

icon="$out/App Icon.imagestack"
store="$out/App Icon - App Store.imagestack"
back 400 240 "$icon/Back.imagestacklayer/Content.imageset/back.png"
back 800 480 "$icon/Back.imagestacklayer/Content.imageset/back@2x.png"
front 400 240 176 "$icon/Front.imagestacklayer/Content.imageset/front.png"
front 800 480 352 "$icon/Front.imagestacklayer/Content.imageset/front@2x.png"
back 1280 768 "$store/Back.imagestacklayer/Content.imageset/back.png"
front 1280 768 560 "$store/Front.imagestacklayer/Content.imageset/front.png"
shelf 1920 720 440 "$out/Top Shelf Image.imageset/top-shelf.png"
shelf 3840 1440 880 "$out/Top Shelf Image.imageset/top-shelf@2x.png"
shelf 2320 720 440 "$out/Top Shelf Image Wide.imageset/top-shelf-wide.png"
shelf 4640 1440 880 "$out/Top Shelf Image Wide.imageset/top-shelf-wide@2x.png"
echo "made the icon and the Top Shelf pictures in $out"

# The iPad's: the icon as the phone has it, one square picture with its tile,
# which iPadOS rounds and sizes itself (no transparency, or it's refused).
ipad="$here/Ribbon/Assets.xcassets/App Icon.appiconset"
rsvg-convert -w 1024 -h 1024 "$svg" -o "$work/ipad.png"
magick "$work/ipad.png" -background '#0a0a0a' -alpha remove -alpha off "PNG24:$ipad/icon.png"
echo "made the iPad's icon in $ipad"
