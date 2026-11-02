//! The one request the webview cannot make itself: Audible's catalog
//! search sends no CORS headers, so a page cannot read its answer. This
//! command builds that one URL from a title, an author and a region, and
//! nothing else; it is not a general fetch.

use std::time::Duration;

fn host_for(region: &str) -> &'static str {
    match region {
        "uk" => "api.audible.co.uk",
        "ca" => "api.audible.ca",
        "au" => "api.audible.com.au",
        "de" => "api.audible.de",
        "fr" => "api.audible.fr",
        "it" => "api.audible.it",
        "es" => "api.audible.es",
        "in" => "api.audible.in",
        "jp" => "api.audible.co.jp",
        _ => "api.audible.com",
    }
}

/// Search Audible's catalog by title and author. Returns the answer's
/// JSON as text, for the web side to read.
#[tauri::command]
pub async fn catalog_search(title: String, author: String, region: String) -> Result<String, String> {
    let url = reqwest::Url::parse_with_params(
        &format!("https://{}/1.0/catalog/products", host_for(&region)),
        &[
            ("title", title.as_str()),
            ("author", author.as_str()),
            ("num_results", "10"),
            ("products_sort_by", "Relevance"),
            ("response_groups", "product_attrs,contributors"),
        ],
    )
    .map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("Ribbon/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let r = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("catalog answered {}", r.status()));
    }
    r.text().await.map_err(|e| e.to_string())
}
