# SearXNG vs RustXNG

RustXNG is a Rust rewrite of the Python SearXNG metasearch engine. This
benchmark calls each service's JSON search endpoint directly. The test
uses shared engine names and the same queries, languages, and host.
[Upstream RustXNG](https://github.com/RustXNG/RustXNG) · [SearXNG Search API](https://docs.searxng.org/dev/search_api.html)

![SearXNG and RustXNG compared on first-call latency, repeat latency and top-five retrieval](searxng-vs-rustxng.png)

## Results

| Engines | Service | First p50 | First p90 | Repeat p50 | Reference in top 5 | Median results |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Wikipedia | SearXNG | 342.70 ms | 1,486.15 ms | 101.85 ms | 20/24 | 1 |
| Wikipedia | RustXNG | 407.15 ms | 711.27 ms | 1.13 ms | 24/24 | 10 |
| Wikipedia + Wiby | SearXNG | 316.36 ms | 362.44 ms | 178.23 ms | 20/24 | 12 |
| Wikipedia + Wiby | RustXNG | 596.46 ms | 958.44 ms | 1.64 ms | 24/24 | 21.5 |

SearXNG answered faster at the median on the first pass for both engine
sets. With Wikipedia alone, RustXNG's first-pass p90 was 52% lower.
SearXNG's repeated-query median was about 90–109 times the RustXNG median in this
setup, with cache behavior included.

RustXNG put the expected article in the top five for all 12 queries in
each pass. SearXNG did so for 10 and missed the expected articles for
“Mars rover Curiosity” and “Voyager 1 spacecraft.” The routes had zero
HTTP errors and reported zero engine failures. [All 96 numeric records](engine-benchmark-results.jsonl)

With the same HTTPS provider payload and ten identical result rows, the two services measured 3.841 ms and 0.806 ms at p50. [Matched-work test and architecture notes](architecture-latency.md).

## Setup and scope

- 22 November 2026, Windows 11, loopback HTTP and live upstream providers.
- SearXNG 2026.11.21+c6ee3e9, Python 3.12.1, Granian 2.8.8, one
  worker and the [benchmark settings](../bench/searxng.yml). Wikipedia
  list output was enabled for top-five scoring. Valkey was off. A small
  Windows import shim supplied the Unix pwd module stub for the unused
  Valkey error-logging path. The search implementation came from the
  upstream checkout.
- RustXNG v0.32.0, native Windows release, Standard profile. The
  request restricted RustXNG to the named engines with strict_engines.
- Twelve English and Russian queries per engine set. Both servers received
  each query twice, with order alternated across topics and reversed on
  the repeat. The first pass used each query expression once for the
  specified engine set. The second engine set ran after the first, so
  provider-level reuse was possible across sets.
- Latency includes HTTP and reading the complete JSON response. p90 is
  the nearest-rank percentile. Top-five hit counts use a Wikipedia URL
  selected in advance for each query. Median results counts the complete
  response list; the hit metric uses its first five rows.

The adapters can query providers differently, even with the same engine
names. For example, SearXNG's Wikipedia adapter uses a page-summary
lookup. This panel measures the service users get with these settings,
including its provider calls and caching. The workload emphasizes
Wikipedia references and has 12 distinct topics. [SearXNG Wikipedia implementation](https://github.com/searxng/searxng/blob/c6ee3e9fd0235004a694e63720efc869bb1e3594/searx/engines/wikipedia.py)

## Reproduce

Run both services bound to loopback on the same host. Start SearXNG using
the repository's benchmark settings and enable the JSON search format.
On Linux, with SearXNG dependencies available, a Granian command is:

~~~sh
SEARXNG_SETTINGS_PATH=/absolute/path/to/rustxng-research-mcp/bench/searxng.yml \
  granian --interface wsgi --host 127.0.0.1 --port 18888 --workers 1 searx.webapp:app
~~~

The Windows run copied [searxng_windows.py](../bench/searxng_windows.py)
into the isolated SearXNG checkout as benchmark_wsgi.py. Install
requirements.txt and requirements-server.txt in a virtual environment,
set the same settings path, and use benchmark_wsgi:app as the Granian
target. Use a dedicated loopback benchmark instance with no
Valkey URL.

~~~sh
rustxng --profile standard --bind 127.0.0.1 --port 29483
node bench/compare-engines.mjs http://127.0.0.1:18888 http://127.0.0.1:29483 > docs/engine-benchmark-results.jsonl
python bench/plot.py
~~~

See [Adapter and downloader benchmarks](benchmarks.md) for the separate
MCP and page-retrieval measurements.
