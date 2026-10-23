//! Paths inside an EPUB: relative to the file that names them,
//! percent-encoded, with `..` and `.` to fold away.

/// `href` as written in `base` (a file in the book), as a path from the book's root.
pub fn resolve(base: &str, href: &str) -> String {
    let href = percent_decode(href);
    let mut parts: Vec<&str> = if href.starts_with('/') {
        Vec::new()
    } else {
        let mut b: Vec<&str> = base.split('/').collect();
        b.pop();
        b
    };
    for seg in href.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

/// `chapter.xhtml#note-3` into its path and its fragment.
pub fn split_fragment(href: &str) -> (&str, Option<&str>) {
    match href.split_once('#') {
        Some((p, f)) => (p, Some(f)),
        None => (href, None),
    }
}

fn percent_decode(s: &str) -> String {
    if !s.contains('%') {
        return s.to_string();
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| (b as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_paths() {
        assert_eq!(resolve("OEBPS/content.opf", "Text/ch%201.xhtml"), "OEBPS/Text/ch 1.xhtml");
        assert_eq!(resolve("OEBPS/Text/ch1.xhtml", "../Images/a.jpg"), "OEBPS/Images/a.jpg");
        assert_eq!(resolve("OEBPS/Text/ch1.xhtml", "./ch2.xhtml"), "OEBPS/Text/ch2.xhtml");
        assert_eq!(resolve("content.opf", "ch1.xhtml"), "ch1.xhtml");
        assert_eq!(split_fragment("a.xhtml#x"), ("a.xhtml", Some("x")));
        assert_eq!(resolve("a/b.xhtml", "%E2%80%99.xhtml"), "a/’.xhtml");
    }
}
