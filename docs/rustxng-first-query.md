# First-query latency in RustXNG

The first lookup of a query can involve DNS, TCP/TLS setup, provider processing,
and waiting for the last selected provider. Repeating an identical request can
reuse a result already assembled. The first-user experience depends on whether
the URL, language, engines, and result limit match a saved request. For the
direct SearXNG comparison, see [SearXNG versus RustXNG](searxng-vs-rustxng.md).

## Fresh queries

On 22 November 2026, RustXNG v0.32.0 ran on Windows 11 with Standard.
Each strategy had its own service process and fresh in-memory cache per
pass. The same 12 Wikipedia-reference queries ran twice. Request order
rotated by query and pass. Provider traffic was live. Latencies include
reading the complete HTTP JSON response. The metrics describe this
workload and its engine choices.

| Settings | p50 | p90 | Reference in top five | Median result rows | Calls with a Wiby result |
| --- | ---: | ---: | ---: | ---: | ---: |
| Parallel Wikipedia + Wiby | 396 ms | 670 ms | 24/24 | 21.5 | 20/24 |
| Staged, one engine per tier, eight results required | 386 ms | 640 ms | 24/24 | 10 | 0/24 |
| Parallel with a 450 ms deadline | 420 ms | 462 ms | 19/24 | 10 | 0/24 |
| Wikipedia only | 411 ms | 663 ms | 24/24 | 10 | 0/24 |

Staging gained 10 ms at p50 on this panel and removed the wider Wiby
coverage. The tight deadline reduced p90 by 31%, with five reference
misses. Parallel stays the general-purpose configuration. Wikipedia alone
is an intentional engine filter for encyclopedia requests.
[RustXNG strategy configuration](https://github.com/RustXNG/RustXNG/blob/main/settings.toml)

## Process startup and caching

A separate test restarted RustXNG for each condition. It used six topics
and the same parallel Wikipedia + Wiby requests. An unrelated warm-up
query used the same language and engines as the measured query.

| Request | p50 | p90 | Samples |
| --- | ---: | ---: | ---: |
| First query after service readiness | 706 ms | 745 ms | 6 |
| New query after an unrelated warm-up | 534 ms | 910 ms | 6 |
| Same query again in the running service | 1.23 ms | 1.47 ms | 12 |

The unrelated warm-up lowered the median in this small run. Its slowest
sample was higher. The large latency reduction came from reusing the
identical result. The measurements and script are linked below.

## Keeping a small cache on SSD

The MCP adapter optionally keeps successful rustxng_search responses in a
local SQLite database. It uses an exact request key that includes the
upstream endpoint and query parameters. It stores up to 256 recent
entries, with a 128 KiB cap per cached response. The default lifetime is
600 seconds. The database stores search snippets and links. Calls to
rustxng_research still use upstream page retrieval.

Set the path in the existing local server's environment. Use a dedicated
file in an existing local directory. Omit the path to use the default
upstream-only behavior.

~~~json
{
  "RUSTXNG_DISK_CACHE_PATH": "C:/path/to/rustxng-cache.sqlite3",
  "RUSTXNG_DISK_CACHE_TTL_SECONDS": "600"
}
~~~

The lifetime can be set from 10 to 3600 seconds. Empty results and
responses with reported engine failures stay on the live path.
Cached snippets stay on the local machine your MCP server runs on.
The durable cache benefits identical requests across restarts, including
requests made while the upstream service is temporarily unavailable.

With the upstream fixture returning HTTP 503, **20 process restarts**
returned the saved response with **0 upstream requests**. Tool-call
latency after MCP initialization was **0.565 ms p50 and 0.674 ms p90**.
The OS page cache could stay warm between these process restarts.
[Disk-cache measurements](disk-cache-results.jsonl)

The upstream service also supports a Valkey cache. Where Valkey is
available, persistence can be configured at that layer with RDB or AOF
for clients shared across processes. This run tested the adapter's SQLite
cache and RustXNG's in-process cache. [RustXNG settings](https://github.com/RustXNG/RustXNG/blob/main/settings.toml) · [Valkey persistence](https://valkey.io/topics/persistence/)

For frequently repeated work, keep RustXNG running and use the exact
queries you actually reuse. To return previously unseen queries quickly
over a stable set of documentation, build a local RustXNG index of those
sites and use live providers for the wider web.
[RustXNG local indexing](https://github.com/RustXNG/RustXNG)

## Reproduce

~~~sh
node bench/first-pass.mjs /absolute/path/to/rustxng > docs/rustxng-first-pass-results.jsonl
node bench/disk-cache.mjs ./target/release/rustxng-research-mcp > docs/disk-cache-results.jsonl
~~~

The first script launches temporary loopback instances. The disk benchmark
uses a local HTTP fixture, seeds one result, restarts the MCP adapter in
each timed sample, and checks that the stored entry avoids HTTP. It also
checks that changing the language causes a cache miss.
[Fresh-query measurements](rustxng-first-pass-results.jsonl)
