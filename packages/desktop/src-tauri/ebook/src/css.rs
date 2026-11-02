//! The publisher's CSS, read only for what the text means: which
//! paragraphs are indented, centred or set apart, which words are italic,
//! bold or small capitals, and what is hidden. Ribbon sets the type
//! itself, so sizes, fonts and colours are not read at all.
//!
//! Only simple selectors are kept: a tag, one or more classes, or a tag
//! with classes. Anything with a combinator, an id, an attribute or a
//! pseudo-class is skipped, and so are at-rules.

/// What a rule, or a whole element, says. `None` means "not said here".
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct Style {
    pub indent: Option<bool>,
    pub align: Option<Align>,
    pub space: Option<bool>,
    /// Room after the element, which sets the next block apart.
    pub after: Option<bool>,
    pub inset: Option<bool>,
    pub italic: Option<bool>,
    pub bold: Option<bool>,
    pub small_caps: Option<bool>,
    pub hidden: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Align {
    Start,
    Center,
    End,
    Justify,
}

impl Align {
    pub fn name(self) -> Option<&'static str> {
        match self {
            Align::Start => None,
            Align::Center => Some("center"),
            Align::End => Some("end"),
            // Justifying is the reader's choice, not the publisher's.
            Align::Justify => None,
        }
    }
}

impl Style {
    /// `other` wins wherever it says something.
    pub fn over(self, other: Style) -> Style {
        Style {
            indent: other.indent.or(self.indent),
            align: other.align.or(self.align),
            space: other.space.or(self.space),
            after: other.after.or(self.after),
            inset: other.inset.or(self.inset),
            italic: other.italic.or(self.italic),
            bold: other.bold.or(self.bold),
            small_caps: other.small_caps.or(self.small_caps),
            hidden: other.hidden.or(self.hidden),
        }
    }
}

struct Rule {
    tag: Option<String>,
    classes: Vec<String>,
    style: Style,
    specificity: u32,
    order: usize,
}

/// Every simple rule from the stylesheets a chapter uses, in order.
#[derive(Default)]
pub struct Sheet {
    rules: Vec<Rule>,
}

impl Sheet {
    pub fn add(&mut self, css: &str) {
        let css = strip_comments(css);
        let mut rest = css.as_str();
        while let Some(open) = rest.find('{') {
            let selectors = rest[..open].trim();
            let Some(close) = matching_brace(rest, open) else { break };
            let body = &rest[open + 1..close];
            rest = &rest[close + 1..];
            // At-rules: @media, @font-face, @page and the rest. Their insides are skipped.
            if let Some(at) = selectors.rfind('@') {
                // A statement like `@import url(x);` can sit before the next rule.
                let after = &selectors[at..];
                if !after.contains(';') {
                    continue;
                }
            }
            let selectors = selectors.rsplit(';').next().unwrap_or("").trim();
            let style = parse_declarations(body);
            if style == Style::default() {
                continue;
            }
            for sel in selectors.split(',') {
                if let Some((tag, classes)) = simple_selector(sel.trim()) {
                    let specificity = classes.len() as u32 * 10 + u32::from(tag.is_some());
                    let order = self.rules.len();
                    self.rules.push(Rule { tag, classes, style, specificity, order });
                }
            }
        }
    }

    /// What the sheet says about an element with this tag and these classes.
    pub fn style_of(&self, tag: &str, classes: &[&str]) -> Style {
        let mut matched: Vec<&Rule> = self
            .rules
            .iter()
            .filter(|r| r.tag.as_deref().map_or(true, |t| t.eq_ignore_ascii_case(tag)) && r.classes.iter().all(|c| classes.contains(&c.as_str())))
            .collect();
        matched.sort_by_key(|r| (r.specificity, r.order));
        matched.into_iter().fold(Style::default(), |acc, r| acc.over(r.style))
    }
}

fn strip_comments(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(i) = rest.find("/*") {
        out.push_str(&rest[..i]);
        match rest[i + 2..].find("*/") {
            Some(j) => rest = &rest[i + 2 + j + 2..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

fn matching_brace(s: &str, open: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (i, ch) in s[open..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(open + i);
                }
            }
            _ => {}
        }
    }
    None
}

/// `p`, `.Body_Text`, `p.Body_Text`, `span.a.b`. Anything else is not simple.
fn simple_selector(sel: &str) -> Option<(Option<String>, Vec<String>)> {
    if sel.is_empty() || sel.contains(|c: char| c.is_whitespace() || matches!(c, '>' | '+' | '~' | ':' | '[' | '#' | '*' | '|')) {
        return None;
    }
    let mut parts = sel.split('.');
    let tag = parts.next().unwrap_or("");
    let classes: Vec<String> = parts.map(str::to_string).collect();
    if classes.iter().any(|c| c.is_empty()) {
        return None;
    }
    let tag = if tag.is_empty() { None } else { Some(tag.to_ascii_lowercase()) };
    if tag.is_none() && classes.is_empty() {
        return None;
    }
    Some((tag, classes))
}

/// The declarations of one rule, or of a `style` attribute.
pub fn parse_declarations(body: &str) -> Style {
    let mut s = Style::default();
    for decl in body.split(';') {
        let Some((prop, value)) = decl.split_once(':') else { continue };
        let prop = prop.trim().to_ascii_lowercase();
        let value = value.replace("!important", "").trim().to_ascii_lowercase();
        match prop.as_str() {
            "text-indent" => s.indent = Some(length(&value).is_some_and(|v| v > 0.0)),
            "text-align" => {
                s.align = match value.as_str() {
                    "center" => Some(Align::Center),
                    "right" | "end" => Some(Align::End),
                    "justify" => Some(Align::Justify),
                    "left" | "start" => Some(Align::Start),
                    _ => None,
                }
            }
            "margin-top" => s.space = Some(spaced(&value)),
            "margin-bottom" => s.after = Some(spaced(&value)),
            "margin" => {
                // One to four values: top, right, bottom, left, as CSS repeats them.
                let v: Vec<&str> = value.split_whitespace().collect();
                let (top, bottom, left) = match v.len() {
                    1 => (v[0], v[0], v[0]),
                    2 => (v[0], v[0], v[1]),
                    3 => (v[0], v[2], v[1]),
                    4 => (v[0], v[2], v[3]),
                    _ => continue,
                };
                s.space = Some(spaced(top));
                s.after = Some(spaced(bottom));
                s.inset = Some(spaced(left));
            }
            "margin-left" | "padding-left" => s.inset = Some(spaced(&value)),
            "font-style" => s.italic = Some(value == "italic" || value == "oblique"),
            "font-weight" => s.bold = Some(value == "bold" || value == "bolder" || value.parse::<u32>().is_ok_and(|w| w >= 600)),
            "font-variant" | "font-variant-caps" => s.small_caps = Some(value.contains("small-caps")),
            "display" => s.hidden = Some(value == "none"),
            _ => {}
        }
    }
    s
}

/// A length in ems, near enough: ems and rems as they are, pixels at 16
/// to the em, points at 12, percentages of a 30-em line. Zero for zero,
/// None for anything else.
fn length(v: &str) -> Option<f32> {
    let v = v.trim();
    if v == "0" {
        return Some(0.0);
    }
    let split = v.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+'))?;
    let n: f32 = v[..split].parse().ok()?;
    match &v[split..] {
        "em" | "rem" => Some(n),
        "px" => Some(n / 16.0),
        "pt" => Some(n / 12.0),
        "%" => Some(n * 0.3),
        "ex" | "ch" => Some(n / 2.0),
        _ => None,
    }
}

/// Enough room to read as a gap: half a line or more.
fn spaced(v: &str) -> bool {
    length(v).is_some_and(|n| n >= 0.5)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_simple_rules_and_skips_the_rest() {
        let mut sheet = Sheet::default();
        sheet.add(
            "/* InDesign */ @font-face { font-family: X; src: url(x.otf); } \
             p.Body_Text { text-indent: 1.5em; font-size: 0.833em; } \
             p.No_Indent { text-indent:0px; } \
             .Italic { font-style: italic } \
             @media amzn-kf8 { p { text-indent: 3em } } \
             div > p { text-align: center } \
             h1, .Chapter { text-align: center; margin-top: 2em } \
             .Hide { display: none }",
        );
        assert_eq!(sheet.style_of("p", &["Body_Text"]).indent, Some(true));
        assert_eq!(sheet.style_of("p", &["No_Indent"]).indent, Some(false));
        assert_eq!(sheet.style_of("span", &["Italic"]).italic, Some(true));
        // The @media rule and the child combinator are both ignored.
        assert_eq!(sheet.style_of("p", &[]), Style::default());
        let h = sheet.style_of("h1", &[]);
        assert_eq!((h.align, h.space), (Some(Align::Center), Some(true)));
        assert_eq!(sheet.style_of("p", &["Chapter"]).align, Some(Align::Center));
        assert_eq!(sheet.style_of("div", &["Hide"]).hidden, Some(true));
    }

    #[test]
    fn classes_beat_tags_and_later_beats_earlier() {
        let mut sheet = Sheet::default();
        sheet.add("p.a { text-indent: 1em } p { text-indent: 0 } p { font-style: italic } p { font-style: normal }");
        assert_eq!(sheet.style_of("p", &["a"]).indent, Some(true));
        assert_eq!(sheet.style_of("p", &[]).indent, Some(false));
        assert_eq!(sheet.style_of("p", &[]).italic, Some(false));
    }

    #[test]
    fn reads_style_attributes() {
        let s = parse_declarations("font-weight: 700; font-variant: small-caps; margin: 1em 0 0 0; text-align: right !important");
        assert_eq!((s.bold, s.small_caps, s.space, s.after, s.inset, s.align), (Some(true), Some(true), Some(true), Some(false), Some(false), Some(Align::End)));
        let q = parse_declarations("margin: 0 20px 43px");
        assert_eq!((q.space, q.after, q.inset), (Some(false), Some(true), Some(true)));
        assert_eq!(parse_declarations("text-indent: -1em").indent, Some(false));
    }
}
