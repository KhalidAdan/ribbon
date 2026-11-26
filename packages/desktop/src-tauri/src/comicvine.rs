//! ComicVine, for the comics in a folder on this computer
//! (docs/BOOK-DETAILS.md, section 7, "Where it runs"). Its API sends no
//! CORS headers, so the web view can't read its answers, and its pictures
//! are on hosts the web view doesn't load from: the requests come through
//! here. As `online.rs` builds only Audible's address, this builds only
//! ComicVine's: the four kinds of request Ribbon makes (an issue, a run, a
//! run's issue by its number, runs by name), each checked, with the
//! person's key put in. It is not a general fetch.
//!
//! What is asked, how often, and what an answer means are core's
//! (packages/core/src/comicvine.ts and comicvine-gate.ts), the same rules
//! the server goes by: one request at a time, a second and a half apart,
//! no more than 180 to a resource in an hour, a blocked one waited out.
//! This sends one request and hands back what came, as it came.
//!
//! The key goes only to ComicVine, in the request, and never into an error
//! or the log: a failed request is answered as status 0 and nothing more,
//! since reqwest's own errors carry the address, and the address the key.

use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::{redirect, Url};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

/// ComicVine's API.
const API: &str = "https://comicvine.gamespot.com/api/";

/// ComicVine's site, where an issue's page is: what a matched comic links back to.
const SITE: &str = "comicvine.gamespot.com";

/// The most an answer may be: its biggest, a search of twenty runs, is tens of kilobytes.
const ANSWER_BYTES: usize = 4 * 1024 * 1024;

/// The biggest picture of a run that is fetched, as on the server.
const PICTURE_BYTES: usize = 2 * 1024 * 1024;

const TIMEOUT: Duration = Duration::from_secs(15);

/// What Ribbon calls itself to ComicVine, which asks every client to say.
const USER_AGENT: &str = concat!("Ribbon/", env!("CARGO_PKG_VERSION"), " (a home library of comics and books)");

/// One request to ComicVine's API as core makes it (comicvine.ts, `CvRequest`), without the key.
#[derive(Debug, Deserialize)]
pub struct CvRequest {
    pub resource: String,
    pub path: String,
    #[serde(default)]
    pub params: HashMap<String, String>,
}

/// ComicVine's answer as it came, for core to read (comicvine.ts, `outcomeOf`): its HTTP status, 0 when it couldn't be reached, and its text.
#[derive(Debug, Serialize, PartialEq)]
pub struct CvReply {
    pub status: u16,
    pub body: String,
}

/// Ask ComicVine's API one request, with the person's key.
#[tauri::command]
pub async fn comicvine_ask(key: String, request: CvRequest) -> Result<CvReply, String> {
    ask(API, &key, &request).await
}

/// The small picture of a run's first cover, from ComicVine's own hosts only.
#[tauri::command]
pub async fn comicvine_picture(url: String) -> Result<tauri::ipc::Response, String> {
    let bytes = picture(&url).await.ok_or("ComicVine has no picture there.")?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Open one of ComicVine's pages in the system's browser: a matched comic's link back to it.
#[tauri::command]
pub async fn comicvine_open(url: String) -> Result<(), String> {
    let page = page_on_comicvine(&url).ok_or("Ribbon opens only ComicVine's own pages.")?;
    tauri::async_runtime::spawn_blocking(move || open::that(page.as_str()).map_err(|e| format!("Ribbon couldn't open your browser: {e}")))
        .await
        .map_err(|e| e.to_string())?
}

/// The request sent to `api` (ComicVine's, or a test's stand-in): its status and text, or status 0 when it couldn't be asked.
pub async fn ask(api: &str, key: &str, request: &CvRequest) -> Result<CvReply, String> {
    let url = api_url(api, key, request)?;
    let host = url.host_str().unwrap_or_default().to_owned();
    // A redirect is followed only on ComicVine's own host: the address carries the key.
    let client = client(redirect::Policy::custom(move |attempt| if attempt.url().host_str() == Some(host.as_str()) && attempt.previous().len() < 3 { attempt.follow() } else { attempt.stop() }))?;
    let unreachable = CvReply { status: 0, body: String::new() };
    let Ok(response) = client.get(url).header(ACCEPT, "application/json").send().await else {
        return Ok(unreachable);
    };
    let status = response.status().as_u16();
    match read_at_most(response, ANSWER_BYTES).await {
        Some(bytes) => Ok(CvReply { status, body: String::from_utf8_lossy(&bytes).into_owned() }),
        None => Ok(unreachable),
    }
}

/// The address a request goes to: ComicVine's API at `api`, one of the four
/// kinds of request Ribbon makes, with the key and JSON asked for. Anything
/// else is refused, so the command is never a general fetch.
pub fn api_url(api: &str, key: &str, request: &CvRequest) -> Result<Url, String> {
    if key.is_empty() || key.len() > 128 || !key.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("That isn't a ComicVine key: a key is letters and digits.".into());
    }
    let allowed: &[&str] = match (request.resource.as_str(), request.path.as_str()) {
        ("issue", path) if is_one(path, "issue/4000-") => &["field_list"],
        ("volume", path) if is_one(path, "volume/4050-") => &["field_list"],
        ("issues", "issues/") => &["filter", "field_list"],
        ("volumes", "volumes/") => &["filter", "field_list", "limit"],
        _ => return Err("Ribbon asks ComicVine only for an issue, a run, a run's issue by its number, or runs by name.".into()),
    };
    for (name, value) in &request.params {
        let fits = match name.as_str() {
            "field_list" => value.chars().all(|c| c.is_ascii_lowercase() || c == '_' || c == ','),
            "limit" => !value.is_empty() && value.len() <= 3 && value.chars().all(|c| c.is_ascii_digit()),
            "filter" => is_filter(&request.resource, value),
            _ => false,
        };
        if !allowed.contains(&name.as_str()) || !fits || value.len() > 500 {
            return Err(format!("Ribbon doesn't ask ComicVine with \"{name}\" there."));
        }
    }
    let mut url = Url::parse(api).and_then(|base| base.join(&request.path)).map_err(|_| "That isn't one of ComicVine's addresses.".to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("api_key", key);
        query.append_pair("format", "json");
        // In one order, so the same request is always the same address.
        let mut params: Vec<_> = request.params.iter().collect();
        params.sort();
        for (name, value) in params {
            query.append_pair(name, value);
        }
    }
    Ok(url)
}

/// An issue's or a run's own path: `issue/4000-1234567/`, `volume/4050-123456/`.
fn is_one(path: &str, start: &str) -> bool {
    path.strip_prefix(start).and_then(|rest| rest.strip_suffix('/')).is_some_and(|id| !id.is_empty() && id.len() <= 12 && id.chars().all(|c| c.is_ascii_digit()))
}

/// A search's filter, as core writes it: a run's issues by number (`volume:9001,issue_number:14`), or runs by name (`name:Saga`, with `,start_year:2012`).
fn is_filter(resource: &str, filter: &str) -> bool {
    if filter.chars().any(|c| c.is_control()) {
        return false;
    }
    match resource {
        "issues" => filter
            .strip_prefix("volume:")
            .and_then(|rest| rest.split_once(",issue_number:"))
            .is_some_and(|(run, number)| !run.is_empty() && run.chars().all(|c| c.is_ascii_digit()) && !number.is_empty() && !number.contains(',')),
        "volumes" => filter.strip_prefix("name:").is_some_and(|rest| !rest.trim().is_empty()),
        _ => false,
    }
}

/// A picture's address that is ComicVine's: over HTTPS, on one of its hosts.
pub fn picture_on_comicvine(url: &str) -> Option<Url> {
    let url = Url::parse(url).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let ours = ["gamespot.com", "comicvine.com"].iter().any(|domain| host == *domain || host.ends_with(&format!(".{domain}")));
    (url.scheme() == "https" && ours).then_some(url)
}

/// A page on ComicVine's site, over HTTPS: the only pages Ribbon opens.
pub fn page_on_comicvine(url: &str) -> Option<Url> {
    let url = Url::parse(url).ok()?;
    (url.scheme() == "https" && url.host_str().is_some_and(|h| h.eq_ignore_ascii_case(SITE))).then_some(url)
}

/// A run's picture, fetched: only from ComicVine's hosts (redirects too), only an image, and small.
async fn picture(url: &str) -> Option<Vec<u8>> {
    let url = picture_on_comicvine(url)?;
    let client = client(redirect::Policy::custom(|attempt| if picture_on_comicvine(attempt.url().as_str()).is_some() && attempt.previous().len() < 3 { attempt.follow() } else { attempt.stop() })).ok()?;
    let response = client.get(url).send().await.ok()?;
    let image = response.headers().get(CONTENT_TYPE).and_then(|t| t.to_str().ok()).is_some_and(|t| t.to_ascii_lowercase().starts_with("image/"));
    if !response.status().is_success() || !image {
        return None;
    }
    read_at_most(response, PICTURE_BYTES).await.filter(|bytes| !bytes.is_empty())
}

fn client(redirects: redirect::Policy) -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(TIMEOUT).user_agent(USER_AGENT).redirect(redirects).build().map_err(|e| e.to_string())
}

/// A response's body, or None when it is cut short or bigger than `most`.
async fn read_at_most(mut response: reqwest::Response, most: usize) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if out.len() + chunk.len() > most {
            return None;
        }
        out.extend_from_slice(&chunk);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    const KEY: &str = "madeupkey0123456789";

    fn request(resource: &str, path: &str, params: &[(&str, &str)]) -> CvRequest {
        CvRequest { resource: resource.into(), path: path.into(), params: params.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect() }
    }

    #[test]
    fn builds_the_four_requests_core_makes_on_comicvines_api() {
        let issue = api_url(API, KEY, &request("issue", "issue/4000-123456/", &[("field_list", "id,name,issue_number")])).unwrap();
        assert_eq!(issue.as_str(), format!("https://comicvine.gamespot.com/api/issue/4000-123456/?api_key={KEY}&format=json&field_list=id%2Cname%2Cissue_number"));
        let run = api_url(API, KEY, &request("volume", "volume/4050-9001/", &[("field_list", "id,name,start_year")])).unwrap();
        assert_eq!(run.path(), "/api/volume/4050-9001/");
        let issues = api_url(API, KEY, &request("issues", "issues/", &[("field_list", "id"), ("filter", "volume:9001,issue_number:14")])).unwrap();
        assert_eq!(issues.as_str(), format!("https://comicvine.gamespot.com/api/issues/?api_key={KEY}&format=json&field_list=id&filter=volume%3A9001%2Cissue_number%3A14"));
        let runs = api_url(API, KEY, &request("volumes", "volumes/", &[("filter", "name:Made Up Saga,start_year:2018"), ("limit", "20")])).unwrap();
        assert_eq!(runs.host_str(), Some("comicvine.gamespot.com"));
        assert_eq!(runs.query_pairs().find(|(n, _)| n == "filter").unwrap().1, "name:Made Up Saga,start_year:2018");
    }

    #[test]
    fn refuses_anything_else() {
        // Another resource, a path that leaves the API, a page elsewhere, a path that isn't the resource's.
        for (resource, path) in [("characters", "characters/"), ("issue", "../../account/"), ("issue", "https://elsewhere.example/4000-1/"), ("issue", "volume/4050-1/"), ("volume", "volume/4050-/"), ("issue", "issue/4000-12x/"), ("issues", "issues/?x=1")] {
            assert!(api_url(API, KEY, &request(resource, path, &[])).is_err(), "{resource} {path}");
        }
        // A parameter Ribbon never sends, or one that isn't the shape core makes.
        assert!(api_url(API, KEY, &request("issue", "issue/4000-1/", &[("filter", "name:x")])).is_err());
        assert!(api_url(API, KEY, &request("issue", "issue/4000-1/", &[("api_key", "another")])).is_err());
        assert!(api_url(API, KEY, &request("issues", "issues/", &[("filter", "name:Saga")])).is_err());
        assert!(api_url(API, KEY, &request("volumes", "volumes/", &[("filter", "volume:1,issue_number:2")])).is_err());
        assert!(api_url(API, KEY, &request("volumes", "volumes/", &[("limit", "all")])).is_err());
        assert!(api_url(API, KEY, &request("issue", "issue/4000-1/", &[("field_list", "id&api_key=x")])).is_err());
        // A key that would be more than a key.
        for key in ["", "has space", "key&format=xml", &"k".repeat(200)] {
            assert!(api_url(API, key, &request("issue", "issue/4000-1/", &[])).is_err(), "{key}");
        }
    }

    #[test]
    fn fetches_pictures_and_opens_pages_only_from_comicvine() {
        assert!(picture_on_comicvine("https://comicvine.gamespot.com/a/uploads/scale_avatar/9/9001/x.jpg").is_some());
        assert!(picture_on_comicvine("https://static.comicvine.com/uploads/x.jpg").is_some());
        assert!(picture_on_comicvine("http://comicvine.gamespot.com/a/uploads/x.jpg").is_none());
        assert!(picture_on_comicvine("https://gamespot.com.elsewhere.example/x.jpg").is_none());
        assert!(picture_on_comicvine("https://notgamespot.com/x.jpg").is_none());
        assert!(page_on_comicvine("https://comicvine.gamespot.com/made-up-saga-2/4000-123456/").is_some());
        assert!(page_on_comicvine("https://www.gamespot.com/").is_none());
        assert!(page_on_comicvine("file:///etc/passwd").is_none());
        assert!(page_on_comicvine("javascript:alert(1)").is_none());
    }

    /// A stand-in for ComicVine on this machine that answers one request, and the request it was asked.
    fn stand_in(answer: &'static str) -> (String, std::sync::mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let api = format!("http://{}/api/", listener.local_addr().unwrap());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut stream = listener.incoming().next().unwrap().unwrap();
            let mut asked = Vec::new();
            let mut byte = [0u8; 1];
            while !asked.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap() == 1 {
                asked.push(byte[0]);
            }
            tx.send(String::from_utf8_lossy(&asked).into_owned()).unwrap();
            stream.write_all(answer.as_bytes()).unwrap();
        });
        (api, rx)
    }

    #[test]
    fn hands_back_comicvines_answer_as_it_came() {
        let body = r#"{"status_code":1,"error":"OK","results":{"id":123456}}"#;
        let answer: &'static str = Box::leak(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).into_boxed_str());
        let (api, asked) = stand_in(answer);
        let reply = tauri::async_runtime::block_on(ask(&api, KEY, &request("issue", "issue/4000-123456/", &[("field_list", "id")]))).unwrap();
        assert_eq!(reply, CvReply { status: 200, body: body.into() });
        let line = asked.recv().unwrap();
        assert!(line.starts_with(&format!("GET /api/issue/4000-123456/?api_key={KEY}&format=json&field_list=id HTTP/1.1")), "{line}");
        assert!(line.to_lowercase().contains("user-agent: ribbon/"));
    }

    #[test]
    fn says_status_0_and_nothing_else_when_comicvine_cant_be_reached() {
        // A port nobody listens on: the error reqwest gives carries the address, and the key with it.
        let closed = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
        let reply = tauri::async_runtime::block_on(ask(&format!("http://{closed}/api/"), KEY, &request("issue", "issue/4000-1/", &[]))).unwrap();
        assert_eq!(reply, CvReply { status: 0, body: String::new() });
    }

    #[test]
    fn hands_back_a_refusal_with_its_status() {
        let (api, _asked) = stand_in("HTTP/1.1 420 Enhance Your Calm\r\nContent-Length: 10\r\n\r\nSlow down.");
        let reply = tauri::async_runtime::block_on(ask(&api, KEY, &request("volumes", "volumes/", &[("filter", "name:Made Up Saga")]))).unwrap();
        assert_eq!(reply, CvReply { status: 420, body: "Slow down.".into() });
    }
}
