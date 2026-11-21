//! Signing in to a Ribbon server through the system browser (docs/SERVER.md,
//! section 6): for a server whose people prove who they are on pages of its
//! own, with a passkey, which a web view inside the app can't do.
//!
//! The app listens on a port of this computer for a moment, opens the
//! server's sign-in page in the browser saying to come back to that port,
//! and waits. When the browser returns it carries a one-time code (or the
//! reason there's none) in its address; the browser is shown a page saying
//! to go back to Ribbon, and the code goes to the app, which trades it for
//! its session.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// How long someone has to sign in in the browser: as long as the server keeps the sign-in open.
const PATIENCE: Duration = Duration::from_secs(10 * 60);

/// Which wait is the current one. A newer sign-in, or a cancel, moves it on, and the wait before it stops.
static CURRENT: AtomicU64 = AtomicU64::new(0);

/// Open `start` (the server's `/sign-in/start`, with the app's challenge) in
/// the browser and wait for it to come back: what its address carried, a
/// `code` or an `error`.
#[tauri::command]
pub async fn server_browser_sign_in(start: String) -> Result<HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || wait_for_browser(&start, |url| open::that(url).map_err(|e| format!("Ribbon couldn't open your browser: {e}"))))
        .await
        .map_err(|e| e.to_string())?
}

/// Stop waiting for the browser: the person changed their mind.
#[tauri::command]
pub fn server_browser_sign_in_cancel() {
    CURRENT.fetch_add(1, Ordering::SeqCst);
}

/// The wait itself, with the browser's opening passed in so a test can stand in for it.
fn wait_for_browser(start: &str, open: impl FnOnce(&str) -> Result<(), String>) -> Result<HashMap<String, String>, String> {
    if !(start.starts_with("https://") || start.starts_with("http://")) {
        return Err("That isn't a server's address.".into());
    }
    let me = CURRENT.fetch_add(1, Ordering::SeqCst) + 1;
    // Any free port, on this computer only: nothing else on the network can answer for the app.
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let joiner = if start.contains('?') { '&' } else { '?' };
    open(&format!("{start}{joiner}return=http%3A%2F%2F127.0.0.1%3A{port}%2Fsigned-in"))?;

    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let until = Instant::now() + PATIENCE;
    loop {
        if CURRENT.load(Ordering::SeqCst) != me {
            return Err("cancelled".into());
        }
        if Instant::now() > until {
            return Err("Nobody signed in in the browser. Try again.".into());
        }
        match listener.accept() {
            // A browser asks for other things too (a favicon): only the return itself ends the wait.
            Ok((stream, _)) => {
                if let Some(carried) = answer(stream) {
                    return Ok(carried);
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Answer one request from the browser. What the return's address carried, when this was the return.
fn answer(stream: TcpStream) -> Option<HashMap<String, String>> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line).ok()?;
    // "GET /signed-in?code=… HTTP/1.1"
    let target = line.split_whitespace().nth(1).unwrap_or("");
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != "/signed-in" {
        respond(&stream, "404 Not Found", "");
        return None;
    }
    let carried: HashMap<String, String> = query.split('&').filter_map(|pair| pair.split_once('=')).map(|(name, value)| (decoded(name), decoded(value))).collect();
    let said = if carried.contains_key("code") {
        "<h1>You're signed in</h1><p>Go back to Ribbon. You can close this tab.</p>"
    } else {
        "<h1>That didn't work</h1><p>Go back to Ribbon: it says why.</p>"
    };
    respond(&stream, "200 OK", &page(said));
    Some(carried)
}

fn respond(mut stream: &TcpStream, status: &str, body: &str) {
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}", body.len());
    let _ = stream.flush();
}

/// The page the browser is left on, in Ribbon's colours, light or dark as the system is.
fn page(body: &str) -> String {
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Ribbon</title>\
         <style>:root{{color-scheme:light dark}}body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#fafaf9;color:#0a0a0a;font:16px/1.5 ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",sans-serif;padding:24px 16px}}\
         main{{max-width:22rem}}h1{{font-size:1.25rem;font-weight:600;margin:0 0 .25rem}}p{{margin:0;color:#5f5f5f}}\
         @media (prefers-color-scheme:dark){{body{{background:#0a0a0a;color:#ededed}}p{{color:#a1a1a1}}}}</style></head><body><main>{body}</main></body></html>"
    )
}

/// A piece of a query as it was before it was percent-encoded for an address.
fn decoded(piece: &str) -> String {
    let bytes = piece.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        // "%41" is the byte 0x41; a "%" with anything else after it is just a "%".
        let escaped = (bytes[at] == b'%').then(|| piece.get(at + 1..at + 3)).flatten().and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match (bytes[at], escaped) {
            (_, Some(byte)) => {
                out.push(byte);
                at += 3;
            }
            (b'+', _) => {
                out.push(b' ');
                at += 1;
            }
            (byte, _) => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::sync::mpsc;
    use std::sync::Mutex;

    /// One wait at a time: they share which wait is the current one, as the app's do.
    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

    /// Ask this computer's port for a path, as the browser does when it comes back, and take the page it's shown.
    fn browse(address: &str) -> String {
        let rest = address.strip_prefix("http://").unwrap();
        let (host, path) = rest.split_once('/').unwrap();
        let mut stream = TcpStream::connect(host).unwrap();
        write!(stream, "GET /{path} HTTP/1.1\r\nHost: {host}\r\n\r\n").unwrap();
        let mut page = String::new();
        let _ = stream.read_to_string(&mut page);
        page
    }

    /// Where the app told the browser to come back to, out of the address it opened.
    fn return_address(opened: &str) -> String {
        decoded(opened.split("return=").nth(1).unwrap())
    }

    #[test]
    fn takes_the_code_the_browser_comes_back_with() {
        let _one = ONE_AT_A_TIME.lock().unwrap();
        let (opened, browser) = mpsc::channel::<String>();
        let visit = std::thread::spawn(move || {
            let opened = browser.recv().unwrap();
            assert!(opened.starts_with("https://ribbon.example/sign-in/start?challenge=abc&return=http%3A%2F%2F127.0.0.1%3A"));
            let back = return_address(&opened);
            // A browser asks for a favicon too; that isn't the return.
            assert!(browse(&back.replace("/signed-in", "/favicon.ico")).starts_with("HTTP/1.1 404"));
            browse(&format!("{back}?code=the%20one-time+code&state=x"))
        });
        let carried = wait_for_browser("https://ribbon.example/sign-in/start?challenge=abc", |url| {
            opened.send(url.to_string()).unwrap();
            Ok(())
        })
        .unwrap();
        assert_eq!(carried.get("code").map(String::as_str), Some("the one-time code"));
        assert!(visit.join().unwrap().contains("You're signed in"));
    }

    #[test]
    fn takes_the_reason_when_the_server_sends_one_instead() {
        let _one = ONE_AT_A_TIME.lock().unwrap();
        let (opened, browser) = mpsc::channel::<String>();
        let visit = std::thread::spawn(move || browse(&format!("{}?error=This%20account%20isn%27t%20allowed%20in%20here.", return_address(&browser.recv().unwrap()))));
        let carried = wait_for_browser("https://ribbon.example/sign-in/start?challenge=abc", |url| {
            opened.send(url.to_string()).unwrap();
            Ok(())
        })
        .unwrap();
        assert_eq!(carried.get("error").map(String::as_str), Some("This account isn't allowed in here."));
        assert!(!carried.contains_key("code"));
        assert!(visit.join().unwrap().contains("That didn't work"));
    }

    #[test]
    fn stops_waiting_when_cancelled() {
        let _one = ONE_AT_A_TIME.lock().unwrap();
        let waited = wait_for_browser("https://ribbon.example/sign-in/start?challenge=abc", |_| {
            server_browser_sign_in_cancel();
            Ok(())
        });
        assert_eq!(waited, Err("cancelled".to_string()));
    }

    #[test]
    fn opens_nothing_that_isnt_a_web_address() {
        let _one = ONE_AT_A_TIME.lock().unwrap();
        let waited = wait_for_browser("file:///etc/passwd", |_| panic!("opened it"));
        assert!(waited.is_err());
    }
}
