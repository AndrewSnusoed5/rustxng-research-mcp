use reqwest::{Client, Url, redirect::Policy};
use rmcp::{
    ErrorData, ServerHandler, ServiceExt, handler::server::wrapper::Parameters,
    model::CallToolResult, tool, tool_handler, tool_router, transport::stdio,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::{env, error::Error, time::Duration};
use tokio::sync::Semaphore;

const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:29483";
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
static REQUESTS: Semaphore = Semaphore::const_new(4);

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Search {
    /// Search query sent to RustXNG.
    query: String,
    /// Number of results requested, from 1 to 20 for search or 1 to 10 for research.
    limit: Option<usize>,
    /// Optional RustXNG language code, such as en or fr.
    language: Option<String>,
    /// Optional comma-separated RustXNG engine names.
    engines: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct ResultItem {
    title: String,
    url: String,
    #[serde(default)]
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    engine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_content_truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_content_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_content_error: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct SearchResults {
    results: Vec<ResultItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    unresponsive_engines: Vec<serde_json::Value>,
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    page_text_note: Option<&'static str>,
}

#[derive(Clone)]
struct RustXng {
    client: Client,
    search_url: Url,
}

impl RustXng {
    fn new(endpoint: &str) -> Result<Self, Box<dyn Error>> {
        let mut url = Url::parse(endpoint)?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("RUSTXNG_URL must be a credential-free HTTP(S) base URL".into());
        }
        let path = format!("{}/search", url.path().trim_end_matches('/'));
        url.set_path(&path);
        let client = Client::builder()
            .redirect(Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(40))
            .user_agent(concat!("rustxng-research-mcp/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self {
            client,
            search_url: url,
        })
    }

    fn request_url(&self, args: &Search, research: bool) -> Result<(Url, usize), ErrorData> {
        let query = args.query.trim();
        if query.is_empty() || query.chars().count() > 1000 {
            return Err(ErrorData::invalid_params(
                "query must contain 1 to 1000 characters",
                None,
            ));
        }
        let limit = args.limit.unwrap_or(if research { 5 } else { 10 });
        let max = if research { 10 } else { 20 };
        if !(1..=max).contains(&limit) {
            return Err(ErrorData::invalid_params(
                format!("limit must be between 1 and {max}"),
                None,
            ));
        }
        let mut url = self.search_url.clone();
        {
            let mut params = url.query_pairs_mut();
            params
                .append_pair("q", query)
                .append_pair("format", "json")
                .append_pair("max_results", &limit.to_string());
            for (key, value, max_chars) in [
                ("language", &args.language, 32),
                ("engines", &args.engines, 240),
            ] {
                if let Some(value) = value.as_deref().map(str::trim) {
                    if value.is_empty() || value.chars().count() > max_chars {
                        return Err(ErrorData::invalid_params(format!("invalid {key}"), None));
                    }
                    params.append_pair(key, value);
                }
            }
            if args.engines.is_some() {
                params.append_pair("strict_engines", "1");
            }
            if research {
                params.append_pair("include_raw_content", "1");
            }
        }
        Ok((url, limit))
    }

    async fn run(&self, args: Search, research: bool) -> Result<CallToolResult, ErrorData> {
        let (url, limit) = self.request_url(&args, research)?;
        let _permit = REQUESTS.try_acquire().map_err(|_| {
            ErrorData::internal_error("RustXNG request limit reached; try again shortly", None)
        })?;
        let mut response = self.client.get(url).send().await.map_err(|_| {
            ErrorData::internal_error("Could not reach RustXNG within the request deadline", None)
        })?;
        if !response.status().is_success() {
            return Err(ErrorData::internal_error(
                format!("RustXNG returned HTTP {}", response.status().as_u16()),
                None,
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| ErrorData::internal_error("Could not read the RustXNG response", None))?
        {
            if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(bytes.len()) {
                return Err(ErrorData::internal_error(
                    "RustXNG response exceeds 8 MiB",
                    None,
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        let mut parsed: SearchResults = serde_json::from_slice(&bytes)
            .map_err(|_| ErrorData::internal_error("RustXNG returned invalid search JSON", None))?;
        parsed.results.truncate(limit);
        if research
            && !parsed.results.is_empty()
            && parsed
                .results
                .iter()
                .all(|row| row.raw_content.is_none() && row.raw_content_status.is_none())
        {
            parsed.page_text_note = Some(
                "RustXNG omitted page text and retrieval status. Check page fetching on the RustXNG server, including its upstream proxy configuration.",
            );
        }
        let value = serde_json::to_value(parsed)
            .map_err(|_| ErrorData::internal_error("Could not encode the tool result", None))?;
        Ok(CallToolResult::structured(value))
    }
}

#[tool_router]
impl RustXng {
    #[tool(
        description = "Search a self-hosted RustXNG instance and return result links, titles and snippets."
    )]
    async fn rustxng_search(
        &self,
        Parameters(args): Parameters<Search>,
    ) -> Result<CallToolResult, ErrorData> {
        self.run(args, false).await
    }

    #[tool(
        description = "Search RustXNG and include page text and retrieval status from the same response."
    )]
    async fn rustxng_research(
        &self,
        Parameters(args): Parameters<Search>,
    ) -> Result<CallToolResult, ErrorData> {
        self.run(args, true).await
    }
}

#[tool_handler(
    name = "rustxng-research-mcp",
    version = "0.1.0",
    instructions = "Use rustxng_search for links and snippets. Use rustxng_research for source text from RustXNG."
)]
impl ServerHandler for RustXng {}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let endpoint = env::var("RUSTXNG_URL").unwrap_or_else(|_| DEFAULT_ENDPOINT.into());
    RustXng::new(&endpoint)?
        .serve(stdio())
        .await?
        .waiting()
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    fn args(query: &str) -> Search {
        Search {
            query: query.into(),
            limit: None,
            language: None,
            engines: None,
        }
    }

    #[test]
    fn validates_endpoint_and_arguments() {
        let tool = RustXng::new("http://127.0.0.1:29483/instance/").unwrap();
        let (url, limit) = tool.request_url(&args("C++ & Rust"), true).unwrap();
        assert_eq!(url.path(), "/instance/search");
        assert_eq!(limit, 5);
        let pairs = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(pairs["q"], "C++ & Rust");
        assert_eq!(pairs["include_raw_content"], "1");
        assert!(tool.request_url(&args("  "), false).is_err());
        assert!(
            tool.request_url(
                &Search {
                    limit: Some(11),
                    ..args("test")
                },
                true
            )
            .is_err()
        );
        assert!(RustXng::new("https://user:password@example.com").is_err());
    }

    #[tokio::test]
    async fn preserves_page_text_and_unavailable_status_over_http() {
        let stub = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let tool = RustXng::new(&format!("http://{}", stub.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = stub.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut buffer = [0; 1024];
                let len = socket.read(&mut buffer).await.unwrap();
                assert!(len > 0);
                request.extend_from_slice(&buffer[..len]);
                if request.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            let request = std::str::from_utf8(&request).unwrap();
            assert!(request.contains("include_raw_content=1"));
            assert!(request.contains("engines=wikipedia&strict_engines=1"));
            let body = r#"{"results":[{"title":"First","url":"https://example.com/","raw_content":"Full text","raw_content_status":"ok"},{"title":"Second","url":"https://example.org/","content":"Snippet","raw_content_status":"robots_blocked"}]}"#;
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let reply = tool
            .run(
                Search {
                    engines: Some("wikipedia".into()),
                    ..args("test")
                },
                true,
            )
            .await
            .unwrap();
        let value = reply.structured_content.unwrap();
        assert_eq!(value["results"][0]["raw_content"], "Full text");
        assert_eq!(value["results"][1]["raw_content_status"], "robots_blocked");
        assert!(value["results"][1].get("raw_content").is_none());
        server.await.unwrap();
    }
}
