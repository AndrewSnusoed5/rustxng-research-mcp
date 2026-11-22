import { isDeepStrictEqual } from "node:util";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createInterface } from "node:readline";

const [base, wrapper, native] = process.argv.slice(2);
if (!base || !wrapper) {
  throw new Error("Usage: node bench/compare.mjs <RustXNG URL> <wrapper executable> [my-web-search-rust executable]");
}
const limit = 5;
const trials = Number(process.env.BENCH_TRIALS ?? 2);
const topics = [
  ["Python task groups", "Python asyncio TaskGroup exceptions cancellation and ExceptionGroup", "en", /remaining tasks.{0,100}cancel/i, /exceptiongroup/i],
  ["nginx request routing", "nginx HTTP request processing default_server missing Host request header", "en", /property of the listen port.{0,70}server name/i, /(?:return\s+444|code 444)/i],
  ["HTTP status 429", "HTTP RFC 6585 429 Too Many Requests Retry-After header", "en", /rate limiting/i, /Retry-After/i],
  ["Rust atomic ordering", "Rust AtomicUsize compare_exchange failure ordering and return value", "en", /failure.{0,110}(?:Relaxed.{0,45}Acquire|Acquire.{0,45}Relaxed)/i, /Err.{0,75}(?:previous|current|old) value/i],
  ["Warcraft auctions", "World of Warcraft auction house 5% cut cancel auction deposit fee", "en", /5% of the winning bid/i, /deposit plus a fee/i],
  ["AV1 specification", "AV1 bitstream format Alliance for Open Media royalty free", "en", /alliance for open media/i, /royalty.free/i],
  ["Annual leave in Russian law", "статья 115 ТК РФ продолжительность основного оплачиваемого отпуска", "ru", /28 календарн\w* д(?:ней|ня)|28 календарных дней/i, /ежегодн.{0,50}оплачиваем.{0,20}отпуск/i],
  ["Sourdough fermentation", "sourdough fermentation lactic acid bacteria yeast carbon dioxide pH", "en", /carbon dioxide/i, /lactic acid bacteria/i],
];

async function httpSearch(url, query, language) {
  const target = new URL(url);
  target.pathname = target.pathname.replace(/\/$/, "") + "/search";
  target.search = new URLSearchParams({
    q: query, format: "json", max_results: String(limit), language, include_raw_content: "1",
  });
  const response = await fetch(target, { signal: AbortSignal.timeout(40_000) });
  if (!response.ok) throw Error("HTTP " + response.status);
  return response.json();
}

async function mcp(executable, env) {
  const child = spawn(executable, [], {
    windowsHide: true, shell: false, detached: false, stdio: ["pipe", "pipe", "ignore"], env,
  });
  const closed = once(child, "close");
  const lines = createInterface({ input: child.stdout });
  const replies = new Map();
  let sequence = 0;
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const reply = replies.get(message.id);
    if (reply) reply.resolve(message);
  });
  function fail(error) {
    for (const reply of replies.values()) reply.reject(error);
  }
  child.on("error", fail);
  child.on("exit", () => fail(Error("MCP process exited")));
  child.stdin.on("error", fail);
  function send(method, params, id) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params, id }) + "\n");
  }
  async function request(method, params) {
    const id = ++sequence;
    let timer;
    try {
      const message = await new Promise((resolve, reject) => {
        replies.set(id, { resolve, reject });
        timer = setTimeout(() => reject(Error("MCP timed out")), 48_000);
        send(method, params, id);
      });
      if (message.error || message.result?.isError) throw Error("MCP tool or protocol error");
      return message.result;
    } finally {
      clearTimeout(timer);
      replies.delete(id);
    }
  }
  try {
    await request("initialize", {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "benchmark", version: "1" },
    });
    send("notifications/initialized");
  } catch (error) {
    child.kill();
    throw error;
  }
  return {
    call: (name, args) => request("tools/call", { name, arguments: args }),
    close: async () => { child.stdin.end(); await closed; },
  };
}

function nativeResults(text) {
  return text.split(/^\d+\. [^\n]* \[(?:en|ru|zh)\]\s*\n(?=https?:\/\/)/m).slice(1).map((entry) => {
    const url = entry.split("\n")[0];
    const start = entry.indexOf("\n---\n");
    const raw_content = start === -1 ? "" : entry.slice(start + 5)
      .split(/\n\n\[(?:selected coverage|pipeline:|backend failures:|FB:|SRCH)/)[0].trim();
    return { url, raw_content };
  });
}

function data(results, controls) {
  const rows = results.slice(0, limit);
  const bodies = rows.map((row) => (row.raw_content ?? "").trim()).filter(Boolean);
  const normalized = bodies.map((body) => body.replace(/\s+/g, " "));
  return {
    results: rows.length,
    bodies: bodies.length,
    characters: bodies.reduce((sum, body) => sum + [...body].length, 0),
    facts: controls.filter((fact) => normalized.some((body) => fact.test(body))).length,
    controls: controls.length,
  };
}

async function fixture() {
  const results = Array.from({ length: limit }, (_, i) => ({
    title: "Fixture " + i, url: "https://example.com/" + i, content: "A local fixture.",
    raw_content: "Deterministic page text. ".repeat(350), raw_content_status: "ok",
  }));
  const payload = JSON.stringify({ results });
  const stub = createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(payload);
  });
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  const url = "http://127.0.0.1:" + stub.address().port;
  let client;
  try {
    client = await mcp(wrapper, { ...process.env, RUSTXNG_URL: url });
    const methods = [
      ["http", async () => (await httpSearch(url, "fixture", "en")).results],
      ["mcp", async () => (await client.call("rustxng_research", { query: "fixture", limit })).structuredContent.results],
    ];
    for (let i = -5; i < 60; i++) {
      for (const [profile, call] of i % 2 ? [...methods].reverse() : methods) {
        const start = performance.now();
        const output = await call();
        const ms = +(performance.now() - start).toFixed(3);
        if (!isDeepStrictEqual(output, results)) throw Error("Fixture output changed");
        if (i >= 0) console.log(JSON.stringify({ kind: "fixture", profile, trial: i + 1, ms }));
      }
    }
  } finally {
    await client?.close();
    stub.closeAllConnections();
    await new Promise((resolve) => stub.close(resolve));
  }
}

await fixture();
const client = await mcp(wrapper, { ...process.env, RUSTXNG_URL: base });
let full;
try {
  const profiles = [
    ["http", async (query, language) => (await httpSearch(base, query, language)).results],
    ["mcp", async (query, language) => (await client.call("rustxng_research", { query, language, limit })).structuredContent.results],
  ];
  if (native) {
    const env = { ...process.env, MWS_RUST_RUSTXNG_PORT: new URL(base).port, MWS_RUST_SEARXNG: "0",
      MWS_ROUTER: "0", MWS_DISK_PAGE_TTL_DAYS: "0", MWS_DISK_RESULT_TTL_DAYS: "0", MWS_RAM_RESULT_CACHE_MB: "0",
    };
    for (const name of ["BRAVE_API_KEY", "TAVILY_API_KEY", "EXA_API_KEY", "OPENALEX_API_KEY", "NCBI_API_KEY", "GITHUB_TOKEN", "MWS_RUST_RUSTXNG_EXE"]) delete env[name];
    full = await mcp(native, env);
    profiles.push(["native", async (query, lang) => nativeResults((await full.call("web_search", {
      query, lang, multi: false, numResults: limit, fetchTop: limit, bodyChars: 8000, maxTokens: 60000,
    })).content[0].text)]);
  }
  if (process.env.RUSTXNG_OLD_URL) {
    profiles.push(["old-http", async (query, language) => (await httpSearch(process.env.RUSTXNG_OLD_URL, query, language)).results]);
  }
  for (let trial = 1; trial <= trials; trial++) {
    for (const [index, [topic, query, lang, ...controls]] of topics.entries()) {
      const offset = (trial - 1 + index) % profiles.length;
      const order = [...profiles.slice(offset), ...profiles.slice(0, offset)];
      for (const [profile, call] of order) {
        const start = performance.now();
        try {
          const results = await call(query, lang);
          const ms = Math.round(performance.now() - start);
          console.log(JSON.stringify({ kind: "live", profile, trial, topic, ms, ...data(results, controls) }));
        } catch {
          console.log(JSON.stringify({ kind: "live", profile, trial, topic, error: true, controls: controls.length }));
        }
      }
    }
  }
} finally {
  await full?.close();
  await client.close();
}
