# Architecture and operation

[RustXNG Research MCP](../README.md) connects a local MCP client to a RustXNG
HTTP service. RustXNG owns the search providers, queries and page extraction.
This repository contains the stdio adapter.

RustXNG also has a built-in stdio mode, rustxng mcp, with the search and
read_page tools. This adapter is for an MCP client that should share an
existing RustXNG HTTP service. Its research call requests search results
and available text together.

~~~mermaid
sequenceDiagram
    participant C as OpenCode / MCP client
    participant M as rustxng-research-mcp
    participant R as RustXNG HTTP service
    participant P as Search providers and source sites
    C->>M: tools/call over stdio
    M->>M: Validate inputs and acquire a request slot
    M->>M: Check optional SQLite cache for a link search
    alt Fresh saved response
        M-->>C: Structured MCP result
    else Live request
        M->>R: GET /search?format=json
        R->>P: Search with the selected profile
        opt rustxng_research
            R->>P: Retrieve page text per RustXNG settings
        end
        R-->>M: Results and available retrieval status
        M-->>C: Structured MCP result
    end
~~~

## What a call does

1. The MCP client starts the executable and performs the MCP initialization
   handshake over stdin/stdout. Startup parses RUSTXNG_URL and creates a
   reusable HTTP client.
2. A call validates the query and result limit. The two tools share one
   implementation. A fresh SQLite hit can complete a link search locally.
   Live requests use GET /search with
   q, format=json and max_results. Optional language and engines go in the
   same request. Supplying engines also enables strict_engines.
3. rustxng_research adds include_raw_content=1. RustXNG uses its configured
   page fetcher and limits. The adapter reads a bounded response, deserializes
   supported fields, and truncates the result list to the limit.
4. The tool returns structured JSON. Each item has title, url and content
   (the snippet). When supplied by RustXNG, it also keeps engine, raw_content,
   raw_content_truncated, raw_content_status and raw_content_error.
   The response may include unresponsive_engines or a page_text_note.

| Property | Adapter behavior |
| --- | --- |
| Upstream endpoint | RUSTXNG_URL, default http://127.0.0.1:29483. A base path can precede /search. |
| Query | 1–1000 characters after trimming |
| rustxng_search limit | Default 10, permitted 1–20 |
| rustxng_research limit | Default 5, permitted 1–10 |
| Concurrent requests | Four per process. A call arriving with all slots in use returns a retryable error. |
| HTTP deadlines | 3 seconds to connect and 40 seconds for the request |
| HTTP response cap | 8 MiB |
| HTTP transport | Direct connections and no redirect following. The endpoint uses a credential-free HTTP(S) base URL. |
| Search, page and engine caches | RustXNG owns upstream caches. The adapter can also persist link searches in an optional SQLite cache. |

The implementation and its loopback protocol tests are in
[src/main.rs](../src/main.rs). Cargo.lock pins the build dependencies.

## Using the tools

Use rustxng_search when you need candidate URLs and summaries. Use
rustxng_research when reading source pages. A page can have a valid snippet
and an empty raw_content field. Inspect the per-page status. For example,
robots_blocked is a flag from the upstream page-fetch stage.

~~~json
{"query":"Tokio graceful shutdown cancellation token","language":"en","limit":5}
~~~

For a manually configured OpenCode server, use the
[README example](../README.md#quick-start) and run opencode mcp list.
For a direct upstream check, use the same query as the MCP call.

~~~sh
curl --get "http://127.0.0.1:29483/search" \
  --data-urlencode "q=Tokio graceful shutdown cancellation token" \
  --data "format=json&language=en&max_results=5&include_raw_content=1"
~~~

| What you see | Where to check |
| --- | --- |
| Server absent from the MCP client | Local command path and stdio configuration |
| Could not reach RustXNG | RUSTXNG_URL, listener, port and the direct /search request |
| Engine failures or no results | RustXNG profile, engine IDs, network and provider logs |
| Links with little or no page text | raw_content_status, raw_content_error, page fetch configuration and proxy compatibility upstream |
| Frequent request limit errors | Limit tool-call concurrency per adapter process to four |

## API keys and related projects

RUSTXNG_URL sets the upstream service. To persist recent link searches, set RUSTXNG_DISK_CACHE_PATH and optionally RUSTXNG_DISK_CACHE_TTL_SECONDS. [Cache instructions](rustxng-first-query.md#keeping-a-small-cache-on-ssd). Configure a provider API key in
the RustXNG process if the provider and profile require one. The Standard
profile can search through its available public providers. Provider quotas
and result availability still apply. [RustXNG profiles and configuration](https://github.com/RustXNG/RustXNG)

The my-web-search server is the
separate full pipeline. It also uses direct providers, local BGE reranking,
independent fetching, archives, PDF/OCR and citation bundles. Optional
OpenAlex or Brave keys apply to its own configured provider adapters.
See [the benchmark](benchmarks.md) for the additional time and coverage
observed on the same RustXNG service.
