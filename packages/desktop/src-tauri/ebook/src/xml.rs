//! A small element tree for the EPUB's own files (container, package,
//! navigation, NCX, encryption), which are a few kilobytes each. Names
//! are local names: `dc:title` is `title`, `epub:type` is `type`.

use super::content::entity;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

#[derive(Default, Debug)]
pub struct Node {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Node>,
    /// Text directly inside, before any child.
    pub text: String,
}

impl Node {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    pub fn is(&self, name: &str) -> bool {
        self.name.eq_ignore_ascii_case(name)
    }

    pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> + 'a {
        self.children.iter().filter(move |c| c.is(name))
    }

    pub fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|c| c.is(name))
    }

    /// Every element of this name below, in document order.
    pub fn descendants<'a>(&'a self, name: &str, out: &mut Vec<&'a Node>) {
        for c in &self.children {
            if c.is(name) {
                out.push(c);
            }
            c.descendants(name, out);
        }
    }

    pub fn find(&self, name: &str) -> Option<&Node> {
        let mut out = Vec::new();
        self.descendants(name, &mut out);
        out.into_iter().next()
    }

    /// All the text inside, whitespace collapsed.
    pub fn all_text(&self) -> String {
        fn gather(n: &Node, out: &mut String) {
            out.push_str(&n.text);
            for c in &n.children {
                gather(c, out);
                out.push(' ');
            }
        }
        let mut s = String::new();
        gather(self, &mut s);
        s.split_whitespace().collect::<Vec<_>>().join(" ")
    }
}

/// Parse a document into its root's children under an unnamed node. Forgiving: stops at the first error.
pub fn parse(text: &str) -> Node {
    let mut reader = Reader::from_str(text);
    let config = reader.config_mut();
    config.check_end_names = false;
    config.allow_unmatched_ends = true;
    let mut stack = vec![Node::default()];
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => stack.push(node(&e)),
            Ok(Event::Empty(e)) => {
                let n = node(&e);
                stack.last_mut().expect("root").children.push(n);
            }
            Ok(Event::End(_)) => {
                if stack.len() > 1 {
                    let n = stack.pop().expect("node");
                    stack.last_mut().expect("root").children.push(n);
                }
            }
            Ok(Event::Text(t)) => push_text(&mut stack, &String::from_utf8_lossy(t.as_ref())),
            Ok(Event::CData(t)) => push_text(&mut stack, &String::from_utf8_lossy(t.as_ref())),
            Ok(Event::GeneralRef(r)) => {
                let s = match r.resolve_char_ref() {
                    Ok(Some(ch)) => ch.to_string(),
                    _ => entity(&String::from_utf8_lossy(r.as_ref())).unwrap_or("").to_string(),
                };
                push_text(&mut stack, &s);
            }
            Ok(Event::Eof) | Err(_) => break,
            Ok(_) => {}
        }
    }
    while stack.len() > 1 {
        let n = stack.pop().expect("node");
        stack.last_mut().expect("root").children.push(n);
    }
    stack.pop().expect("root")
}

fn push_text(stack: &mut [Node], s: &str) {
    let top = stack.last_mut().expect("root");
    // Text after a child belongs to the child's trailing side; for these files only leading text matters.
    if top.children.is_empty() {
        top.text.push_str(s);
    } else {
        // Keep it findable by all_text without a mixed-content model.
        top.children.push(Node { name: "#text".into(), text: s.to_string(), ..Node::default() });
    }
}

fn node(e: &BytesStart) -> Node {
    let name = String::from_utf8_lossy(e.local_name().as_ref()).into_owned();
    let attrs = e
        .attributes()
        .flatten()
        .map(|a| {
            let key = String::from_utf8_lossy(a.key.local_name().as_ref()).into_owned();
            let value = a.unescape_value_with(entity).map(|v| v.into_owned()).unwrap_or_else(|_| String::from_utf8_lossy(&a.value).into_owned());
            (key, value)
        })
        .collect();
    Node { name, attrs, ..Node::default() }
}
