import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { directEnv as env, launchLoopback } from "./loopback-search.mjs";

const [rustxng, python, checkout, format = "html", candidate] = process.argv.slice(2);
if (!checkout || !["html", "json"].includes(format)) {
  throw Error("Usage: node bench/fresh-user-search.mjs <RustXNG> <SearXNG Python> <checkout> [html|json] [candidate RustXNG]");
}
const cadenceMs = Number(process.env.BENCH_USER_CADENCE_MS ?? 8000);
const limit = Number(process.env.BENCH_USER_TOPICS ?? 18);
if (!Number.isInteger(cadenceMs) || cadenceMs < 4000 || !Number.isInteger(limit) || limit < 1 || limit > 18) {
  throw Error("Use an integer cadence of at least 4000 ms and 1–18 topics.");
}
const engines = "wikipedia,wiby,github,hackernews";
const topics = [
  ["HTTP terminology", "what does HTTP 429 mean", "en", /\/(wiki\/HTTP_429|wiki\/List_of_HTTP_status_codes)\b/i],
  ["Python library", "python requests github", "en", /github\.com\/(psf|kennethreitz)\/requests\b/i],
  ["Space mission", "first rover on Mars Sojourner", "en", /en\.wikipedia\.org\/wiki\/Sojourner/i],
  ["Rust async", "tokio async runtime rust github", "en", /github\.com\/tokio-rs\/tokio\b/i],
  ["Optics", "Как образуется радуга", "ru", /ru\.wikipedia\.org\/wiki\/Радуга\b|ru\.wikipedia\.org\/wiki\/Радуга$/iu],
  ["Historical game", "NetHack source code github", "en", /github\.com\/NetHack\/NetHack\b/i],
  ["Graphics API", "Vulkan API Khronos GitHub", "en", /github\.com\/KhronosGroup\/Vulkan/i],
  ["Database internals", "what is write-ahead logging sqlite", "en", /wiki\/Write-ahead_logging|sqlite\.org\/wal\.html/i],
  ["Geography", "Почему Мёртвое море солёное", "ru", /ru\.wikipedia\.org\/wiki\/М[её]ртвое_море/iu],
  ["Public domain", "Project Gutenberg free ebooks", "en", /gutenberg\.org|\/wiki\/Project_Gutenberg/i],
  ["Web framework", "fastapi source code github", "en", /github\.com\/(fastapi|tiangolo)\/fastapi\b/i],
  ["Astronomy", "why Pluto is a dwarf planet", "en", /en\.wikipedia\.org\/wiki\/(Pluto|Dwarf_planet)\b/i],
  ["Open source reader", "Calibre ebook manager GitHub", "en", /github\.com\/kovidgoyal\/calibre\b/i],
  ["Historical event", "Первый искусственный спутник Земли", "ru", /ru\.wikipedia\.org\/wiki\/Спутник-1|ru\.wikipedia\.org\/wiki\/Первый_искусственный_спутник/iu],
  ["Web archive", "Internet Archive Wayback Machine", "en", /archive\.org|\/wiki\/(Wayback_Machine|Internet_Archive)\b/i],
  ["Image codec", "libjxl JPEG XL github", "en", /github\.com\/libjxl\/libjxl\b/i],
  ["Computing history", "who invented the computer mouse Engelbart", "en", /en\.wikipedia\.org\/wiki\/(Douglas_Engelbart|Computer_mouse)\b/i],
  ["Container tooling", "podman daemonless containers github", "en", /github\.com\/(containers|podman-container-tools)\/podman\b/i],
];

function htmlLinks(body, profile) {
  const titleLinks = profile === "searxng"
    ? /<h3>\s*<a\b[^>]*\bhref="([^"]+)"/g
    : /<a class="result-title" href="([^"]+)"/g;
  return [...body.matchAll(titleLinks)].map(([, url]) => url.replaceAll("&amp;", "&"));
}

async function sample([profile, { base }], [topic, q, language, expected], idleMs) {
  const uri = new URL("/search", base);
  uri.search = new URLSearchParams({ q, language, engines, safesearch: "0" });
  if (format === "json") uri.searchParams.set("format", "json");
  if (profile !== "searxng") {
    uri.searchParams.set("strict_engines", "1");
    if (format === "json") uri.searchParams.set("full", "1");
  }
  const row = { profile, format, topic, language, idleMs };
  const start = performance.now();
  try {
    const response = await fetch(uri, { signal: AbortSignal.timeout(15_000) });
    const headersMs = +(performance.now() - start).toFixed(2);
    if (!response.ok) throw Error("HTTP " + response.status);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes(format)) throw Error("Unexpected response type " + contentType);
    const body = await response.text();
    const ms = +(performance.now() - start).toFixed(2);
    const payload = format === "json" ? JSON.parse(body) : null;
    const urls = payload ? payload.results.map((result) => result.url) : htmlLinks(body, profile);
    const rank = urls.slice(0, 5).findIndex((url) => {
      try {
        return expected.test(decodeURIComponent(url));
      } catch {
        return false;
      }
    }) + 1;
    const timing = response.headers.get("server-timing") ?? "";
    const engineMs = profile === "searxng"
      ? Object.fromEntries([...timing.matchAll(/total_\d+_([^;]+);dur=([\d.]+)/g)]
          .map(([, name, value]) => [name, Number(value)]))
      : Object.fromEntries((payload?.timings ?? []).map(({ engine, total }) => [engine, +(total * 1000).toFixed(2)]));
    return { ...row, ms, headersMs, results: urls.length, rank, engineMs,
      ...(payload && { engineFailures: payload.unresponsive_engines?.length ?? 0 }) };
  } catch (error) {
    return { ...row, error: error.message };
  }
}

const temp = await mkdtemp(join(tmpdir(), "rustxng-fresh-user-"));
const services = [];
const configs = [];
async function writeConfig(name, contents) {
  const path = join(temp, name);
  configs.push(path);
  await writeFile(path, contents);
  return path;
}

try {
  const searConfig = await writeConfig("searxng.yml", [
    "use_default_settings:", "  engines:", "    keep_only: [" + engines + "]",
    "general:", '  contact_url: "https://github.com/AndrewSnusoed5/rustxng-research-mcp"',
    "server:", '  secret_key: "fresh-user-loopback-only"', "  limiter: false", "  public_instance: false",
    "search:", "  formats: [html, json]", "  autocomplete: ''",
    "valkey:", "  url: false", "outgoing:", "  request_timeout: 4.0", "  max_request_timeout: 5.0",
    "engines:", ...engines.split(",").flatMap((name) => [
      "  - name: " + name, "    disabled: false", ...(name === "wikipedia" ? ["    display_type: [list]"] : []),
    ]), "",
  ].join("\n"));
  const pyTarget = process.platform === "win32" ? "searxng_windows:app" : "searx.webapp:app";
  services.push(["searxng", await launchLoopback(python, (port) => [
    "-m", "granian", "--interface", "wsgi", "--host", "127.0.0.1", "--port", String(port), "--workers", "1", pyTarget,
  ], { cwd: resolve(checkout), env: { ...env, PYTHONDONTWRITEBYTECODE: "1", SEARXNG_SETTINGS_PATH: searConfig,
    PYTHONPATH: [resolve("bench"), env.PYTHONPATH].filter(Boolean).join(delimiter) } })]);

  const rustProfiles = [
    ["rustxng", rustxng, "[outgoing]\nkeepalive_expiry = 5.0\n"],
    candidate ? ["rustxng-candidate", candidate, ""]
      : ["rustxng-keepalive", rustxng, "[outgoing]\nkeepalive_expiry = 30.0\n"],
  ];
  for (const [profile, binary, settings] of rustProfiles) {
    const config = await writeConfig(profile + ".toml", settings);
    services.push([profile, await launchLoopback(binary, (port) => [
      "--profile", "standard", "--config", config, "--bind", "127.0.0.1", "--port", String(port),
    ], { env })]);
  }

  const lastEnd = new Map();
  for (const [index, topic] of topics.slice(0, limit).entries()) {
    const start = performance.now();
    for (let step = 0; step < services.length; step++) {
      const service = services[(index + step) % services.length];
      const began = performance.now();
      const ended = lastEnd.get(service[0]);
      console.log(JSON.stringify(await sample(service, topic, ended === undefined ? null : Math.round(began - ended))));
      lastEnd.set(service[0], performance.now());
      if (step < services.length - 1) await delay(Math.max(0, 1100 - (performance.now() - began)));
    }
    if (index + 1 < limit) await delay(Math.max(0, cadenceMs - (performance.now() - start)));
  }
} finally {
  await Promise.allSettled(services.map(([, service]) => service.close()));
  await Promise.allSettled(configs.map((path) => unlink(path)));
  await rmdir(temp);
}
