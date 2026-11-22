# AGENTS.md

Read [Architecture and operation](docs/architecture.md) before editing the
adapter. [Benchmarks](docs/benchmarks.md) records test inputs, measurements
and reproduction commands.

- The MCP entry point and loopback tests are in src/main.rs. Run
  cargo test --locked and cargo build --release --locked after changing it.
- The adapter uses stdio for MCP messages and the configured RustXNG HTTP
  service for retrieval. Preserve the tool argument and result fields that
  MCP callers use.
- Keep three benchmark cases distinct. Direct RustXNG HTTP measures the
  upstream service. This adapter measures the same path through MCP. The
  full my-web-search server runs a separate retrieval pipeline.
- Publish benchmark counters and timings. Keep provider response bodies,
  personal settings and API keys out of the repository.
