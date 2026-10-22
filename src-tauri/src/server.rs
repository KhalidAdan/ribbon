//! Books from a Ribbon server, kept on this device (docs/SERVER.md,
//! section 8): a book is downloaded before it plays, a file at a time,
//! straight to disk, so a long audiobook never passes through the web view.

use std::io::Write;
use std::time::{Duration, Instant};
use tauri::Emitter;

/// Progress of a download, as `{ target, done, total }` in bytes, a few times a second.
pub const DOWNLOAD_PROGRESS: &str = "ribbon://download-progress";

/// Download one file of a book from the server to `target`, as the person
/// signed in (`token`), saying how far along a few times a second.
#[tauri::command]
pub async fn server_download(app: tauri::AppHandle, url: String, token: String, target: String, size: u64) -> Result<(), String> {
    let mut last = Instant::now();
    download(&url, &token, &target, size, |done| {
        if done == size || last.elapsed() > Duration::from_millis(200) {
            last = Instant::now();
            let _ = app.emit(DOWNLOAD_PROGRESS, serde_json::json!({ "target": target, "done": done, "total": size }));
        }
    })
    .await
}

/// The download itself. It goes to `target.part` first and is renamed when
/// whole. A `.part` left by a download that stopped carries on from where it
/// was (a Range request); a server that sends the whole file instead starts
/// it over. A cut-short download keeps its `.part` for next time.
pub async fn download(url: &str, token: &str, target: &str, size: u64, mut progress: impl FnMut(u64)) -> Result<(), String> {
    let part = format!("{target}.part");
    if let Some(dir) = std::path::Path::new(target).parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    // Stopped after the last byte and before the rename.
    if have == size {
        std::fs::rename(&part, target).map_err(|e| e.to_string())?;
        progress(size);
        return Ok(());
    }
    let client = reqwest::Client::builder().user_agent(concat!("Ribbon/", env!("CARGO_PKG_VERSION"))).build().map_err(|e| e.to_string())?;
    let mut request = client.get(url).bearer_auth(token);
    if have > 0 && have < size {
        request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let mut response = request.send().await.map_err(|e| format!("could not reach the server: {e}"))?;
    let status = response.status().as_u16();
    let (mut file, mut done) = match status {
        206 => (std::fs::OpenOptions::new().append(true).open(&part).map_err(|e| e.to_string())?, have),
        200 => (std::fs::File::create(&part).map_err(|e| e.to_string())?, 0),
        401 => return Err("the server asked to sign in again".into()),
        _ => return Err(format!("the server answered {status}")),
    };
    loop {
        // What arrived before a cut is written first, so the next try carries on from it.
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(e) => {
                file.flush().map_err(|e| e.to_string())?;
                return Err(format!("the download stopped: {e}"));
            }
        };
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        progress(done);
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    if done != size {
        return Err("the download was cut short; it will carry on from there".into());
    }
    std::fs::rename(&part, target).map_err(|e| e.to_string())?;
    Ok(())
}

/// The space free for this app's files on the disk that holds `path`, in
/// bytes: checked before every download, so a book that won't fit is never
/// half downloaded.
#[tauri::command]
pub fn server_free_space(path: String) -> Result<u64, String> {
    let mut at = std::path::PathBuf::from(&path);
    // The folder may not exist yet: ask about the nearest one that does.
    while !at.exists() {
        if !at.pop() {
            return Err(format!("no such place: {path}"));
        }
    }
    fs4::available_space(&at).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::download;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// A server that answers each request in turn with what `answer` makes of
    /// its Range header (the start byte, if any): a status line, and the bytes
    /// to send, which may be fewer than the Content-Length promised.
    fn serve(answers: usize, answer: impl Fn(Option<u64>) -> (String, Vec<u8>) + Send + 'static) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/api/books/b/files/audio/01.mp3", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming().take(answers) {
                let mut stream = stream.unwrap();
                let mut request = Vec::new();
                let mut byte = [0u8; 1];
                while !request.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap() == 1 {
                    request.push(byte[0]);
                }
                let request = String::from_utf8_lossy(&request).to_lowercase();
                assert!(request.contains("authorization: bearer the-token"));
                let from = request.lines().find_map(|l| l.strip_prefix("range: bytes=")).and_then(|r| r.trim_end_matches('-').parse().ok());
                let (head, body) = answer(from);
                stream.write_all(head.as_bytes()).unwrap();
                stream.write_all(&body).unwrap();
            }
        });
        url
    }

    fn file() -> Vec<u8> {
        (0..100_000u32).map(|i| (i % 251) as u8).collect()
    }

    #[test]
    fn carries_on_from_where_a_download_was_cut() {
        let whole = file();
        let url = serve(2, move |from| match from {
            // The first try: the whole file promised, half of it sent.
            None => (format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", whole.len()), whole[..50_000].to_vec()),
            Some(start) => {
                let rest = whole[start as usize..].to_vec();
                (format!("HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{}/{}\r\n\r\n", rest.len(), whole.len() - 1, whole.len()), rest)
            }
        });
        let dir = std::env::temp_dir().join(format!("ribbon-download-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let target = dir.join("book").join("01.mp3");
        let target = target.to_str().unwrap();

        let cut = tauri::async_runtime::block_on(download(&url, "the-token", target, file().len() as u64, |_| ()));
        assert!(cut.is_err());
        assert_eq!(std::fs::metadata(format!("{target}.part")).unwrap().len(), 50_000);

        let mut seen = Vec::new();
        tauri::async_runtime::block_on(download(&url, "the-token", target, file().len() as u64, |done| seen.push(done))).unwrap();
        assert_eq!(std::fs::read(target).unwrap(), file());
        assert_eq!(seen.last(), Some(&(file().len() as u64)));
        assert!(seen.iter().all(|&done| done > 50_000));
        assert!(!std::path::Path::new(&format!("{target}.part")).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn says_when_the_sign_in_is_no_longer_taken() {
        let url = serve(1, |_| ("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n".into(), Vec::new()));
        let dir = std::env::temp_dir().join(format!("ribbon-refused-{}", std::process::id()));
        let target = dir.join("01.mp3");
        let answer = tauri::async_runtime::block_on(download(&url, "the-token", target.to_str().unwrap(), 10, |_| ()));
        assert_eq!(answer, Err("the server asked to sign in again".to_string()));
        assert!(!target.exists());
    }
}
