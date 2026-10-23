//! What an image is, for the reader's dark mode (docs/READING.md). Ink is
//! line art, ornaments, diagrams and images of text: dark marks without
//! much colour, on a light or clear ground. The reader turns ink light in
//! the dark, so it does not vanish on the page. Anything else is a
//! picture, which the reader only dims.

use image::{DynamicImage, GenericImageView};

pub const INK: &str = "ink";
pub const PICTURE: &str = "picture";

/// Points looked at along each side, at most: enough to tell, and quick.
const GRID: u64 = 64;

/// The image's tone. An image that cannot be decoded is a picture: drawn as it is, only dimmed.
pub fn tone(bytes: &[u8]) -> &'static str {
    match image::load_from_memory(bytes) {
        Ok(img) if is_ink(&img) => INK,
        _ => PICTURE,
    }
}

fn is_ink(img: &DynamicImage) -> bool {
    let (w, h) = (u64::from(img.width()), u64::from(img.height()));
    if w == 0 || h == 0 {
        return false;
    }
    let (cols, rows) = (w.min(GRID), h.min(GRID));
    // Every point is one of: clear, light (the ground), colour, mid grey, or dark (the marks).
    let (mut clear, mut light, mut colour, mut mid, mut n) = (0u64, 0u64, 0u64, 0u64, 0u64);
    for j in 0..rows {
        let y = ((2 * j + 1) * h / (2 * rows)) as u32;
        for i in 0..cols {
            let x = ((2 * i + 1) * w / (2 * cols)) as u32;
            let [r, g, b, a] = img.get_pixel(x, y).0;
            n += 1;
            if a < 40 {
                clear += 1;
                continue;
            }
            let chroma = r.max(g).max(b) - r.min(g).min(b);
            let luma = (u32::from(r) * 299 + u32::from(g) * 587 + u32::from(b) * 114) / 1000;
            if chroma >= 64 {
                colour += 1;
            } else if luma >= 190 {
                light += 1;
            } else if luma >= 90 {
                mid += 1;
            }
        }
    }
    // Little colour and few greys: marks on a ground, not a photograph.
    let marks = colour * 20 <= n && mid * 4 <= n;
    // A light ground for most of it, or a clear one. A mostly black image already sits well
    // on a dark page; turned, it would glare.
    let ground = (clear + light) * 2 >= n || clear * 10 >= n;
    marks && ground
}
