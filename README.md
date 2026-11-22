# RustXNG Research MCP

A small Rust MCP server that connects AI clients to a self-hosted RustXNG instance. RustXNG is a Rust rewrite of the Python [SearXNG](https://github.com/searxng/searxng) metasearch engine. Search the web for links and snippets, or ask RustXNG for the source text it can retrieve. The server runs over stdio and talks to RustXNG through its documented HTTP API.

[Architecture and troubleshooting](docs/architecture.md) · [SearXNG vs RustXNG benchmark](docs/searxng-vs-rustxng.md)

## Quick start

Start [RustXNG](https://github.com/RustXNG/RustXNG) v0.32.0 or newer from its own release or source distribution.

```sh
rustxng --profile standard --bind 127.0.0.1 --port 29483
```

Build this client with Rust 1.89 or newer. On Windows, use a Developer PowerShell with the MSVC toolchain available.

```sh
cargo build --release --locked
cargo test --locked
```

Add the executable to your MCP client's local stdio configuration. Use the absolute path to `target/release/rustxng-research-mcp` and append `.exe` on Windows. The following entry goes in `opencode.json`.

```json
{
  "mcp": {
    "servers": {
      "rustxng-research": {
        "type": "local",
        "command": ["/absolute/path/to/rustxng-research-mcp"],
        "environment": { "RUSTXNG_URL": "http://127.0.0.1:29483" }
      }
    }
  }
}
```

The default endpoint is `http://127.0.0.1:29483`. `RUSTXNG_URL` can point to another RustXNG instance you operate.
See [OpenCode's local MCP configuration](https://opencode.ai/docs/mcp-servers/) for client options.

## Tools

| Tool | What it returns | Default limit |
| --- | --- | ---: |
| `rustxng_search` | Result links, titles, snippets and available engine status. | 10 |
| `rustxng_research` | Search results with page text and the per-page retrieval status reported by RustXNG. | 5 |

Each tool accepts `query`, `limit`, and optional `language` and `engines`. `engines` is a comma-separated list of engine IDs from your RustXNG profile. These arguments search for Tokio documentation in English.

```json
{"query":"Tokio task cancellation documentation","language":"en","limit":5}
```

This client makes one request to RustXNG per tool call. It keeps no query or page cache and asks for no credentials. Your RustXNG profile determines its external requests, page extraction capabilities, and cache policy. A result can have a snippet and a retrieval status even when the page text is unavailable.

RustXNG v0.32.0 requires direct connections for its page fetcher to validate destinations. If a search returns snippets but no page text, check the upstream server's own fetch and proxy configuration. Follow the settings required by your network. Text truncation and retrieval status are shown when RustXNG supplies them.

## SearXNG vs RustXNG

![Direct SearXNG versus RustXNG search latency, repeat latency and top-five retrieval](docs/searxng-vs-rustxng.png)

The [engine comparison](docs/searxng-vs-rustxng.md) tests both services directly with identical query text and shared engines. [Separate adapter and downloader results](docs/benchmarks.md) cover the MCP layer and full-page retrieval.

## Project status and license

This is an independent client for the RustXNG HTTP API. Install RustXNG separately under its own [AGPL-3.0-or-later license](https://github.com/RustXNG/RustXNG). This client's source is available under the [PolyForm Noncommercial License 1.0.0](LICENSE), subject to its terms. See [NOTICE](NOTICE) for attribution.

Maintained by [AndrewSnusoed5](https://github.com/AndrewSnusoed5). Stars, reproducible issue reports and pull requests are welcome.

## Support

Optional donations can be sent to the following wallet on **Solana mainnet**.

```text
CBBRkEL644LngYtDRkacVftVarrjfdg4NaBpUWbSJM5m
```

Use SOL, [native USDC](https://developers.circle.com/stablecoins/usdc-contract-addresses) or [USDT on Solana](https://tether.to/en/supported-protocols/). For an SPL token, use a sender wallet that supports creating the recipient's associated token account when needed. [View the wallet on Solana Explorer](https://explorer.solana.com/address/CBBRkEL644LngYtDRkacVftVarrjfdg4NaBpUWbSJM5m).
