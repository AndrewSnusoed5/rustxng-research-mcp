import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { directEnv as env, launchLoopback } from "./loopback-search.mjs";

const [rustxng, python, searxngCheckout] = process.argv.slice(2);
const probePagination = process.argv.includes("--pagination");
const probeIdle = process.argv.includes("--idle");
const rustKeepalive = Number(process.env.BENCH_RUST_KEEPALIVE_SECONDS ?? 5);
if (!searxngCheckout) throw Error("Usage: node bench/matched-provider.mjs <RustXNG> <SearXNG Python> <checkout>");
if (!Number.isInteger(rustKeepalive) || rustKeepalive < 1) {
  throw Error("BENCH_RUST_KEEPALIVE_SECONDS must be a positive integer");
}
function providerRows(query) {
  return Array.from({ length: 10 }, (_, index) => ({
    URL: "https://fixture-" + index + ".example.org/" + encodeURIComponent(query),
    Title: query + " matched title " + index,
    Snippet: query + " appears in snippet " + index + " from the shared upstream fixture.",
  }));
}
const timings = new Map();
const providerRequests = [];

async function respond(request, response) {
  const entered = performance.now();
  const url = new URL(request.url, "http://127.0.0.1");
  const query = url.searchParams.get("q");
  if (providerRequests.length < 10) providerRequests.push(request.url);

  if (url.pathname !== "/json/" || !query || (!probePagination && url.searchParams.get("p") !== "1")) {
    response.writeHead(400).end();
    return;
  }
  if (query.startsWith("delay-")) await delay(80);
  const body = JSON.stringify(providerRows(query));
  const samples = timings.get(query) ?? [];
  samples.push({ entered, sent: performance.now(), page: url.searchParams.get("p"),
    ...(probeIdle && { socket: request.socket }) });
  timings.set(query, samples);
  response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

const folder = await mkdtemp(join(tmpdir(), "rustxng-matched-provider-"));
const yml = join(folder, "searxng.yml");
const toml = join(folder, "rustxng.toml");
const certificate = join(folder, "fixture.crt");
const privateKey = join(folder, "fixture.key");
const rootCA = join(folder, "ca.crt");
const rootKey = join(folder, "ca.key");
const csr = join(folder, "fixture.csr");
const extensions = join(folder, "fixture.ext");
const services = [];
let fixture;
try {
  const openssl = (args) => execFileSync("openssl", args, { windowsHide: true, stdio: "ignore" });
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=RustXNG benchmark CA",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    "-keyout", rootKey, "-out", rootCA]);
  openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1",
    "-keyout", privateKey, "-out", csr]);
  await writeFile(extensions, "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n");
  openssl(["x509", "-req", "-days", "1", "-in", csr, "-CA", rootCA, "-CAkey", rootKey,
    "-set_serial", "1", "-extfile", extensions, "-out", certificate]);
  fixture = createHttpsServer({ key: await readFile(privateKey), cert: await readFile(certificate) }, respond);
  if (probeIdle) fixture.keepAliveTimeout = 60_000;
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const provider = "https://127.0.0.1:" + fixture.address().port + "/json/?q={query}&p=" + (probePagination ? "{pageno}" : "1");
  await writeFile(yml, [
    "use_default_settings:", "  engines:", "    keep_only: [wiby]",
    "server:", '  secret_key: "test-fixture-loopback"', "  limiter: false", "  public_instance: false",
    "search:", "  formats: [json]", "valkey:", "  url: false",
    "outgoing:", "  verify: " + JSON.stringify(rootCA),
    "engines:", "  - name: wiby", "    disabled: false", '    search_url: "' + provider + '"', "",
  ].join("\n"));
  await writeFile(toml, [
    "[outgoing]", "ca_bundle = " + JSON.stringify(rootCA),
    ...(probeIdle ? ["keepalive_expiry = " + rustKeepalive + ".0"] : []),
    "[[engines]]", 'name = "wiby"', 'engine = "json_engine"', 'shortcut = "wib"',
    'categories = ["general"]', "paging = true", 'search_url = "' + provider + '"',
    'url_query = "URL"', 'title_query = "Title"', 'content_query = "Snippet"', "",
  ].join("\n"));
  const target = process.platform === "win32" ? "searxng_windows:app" : "searx.webapp:app";
  services.push(["searxng", await launchLoopback(python, (port) => ["-m", "granian", "--interface", "wsgi", "--host",
    "127.0.0.1", "--port", String(port), "--workers", "1", target], {
    cwd: resolve(searxngCheckout),
    env: { ...env, PYTHONDONTWRITEBYTECODE: "1", SEARXNG_SETTINGS_PATH: yml, PYTHONPATH: [resolve("bench"), env.PYTHONPATH].filter(Boolean).join(delimiter) },
  })]);
  services.push(["rustxng", await launchLoopback(rustxng, (port) => ["--profile", "standard", "--config", toml,
    "--bind", "127.0.0.1", "--port", String(port)], { env })]);

  if (probePagination) {
    for (const page of [1, 2, 3]) {
      for (const [profile, service] of services) {
        const source = "pagination control";
        const query = new URL("/search", service.base);
        query.search = new URLSearchParams({
          q: source, format: "json", engines: "wiby", language: "en", pageno: String(page),
        });
        if (profile === "rustxng") query.searchParams.set("strict_engines", "1");
        const count = timings.get(source)?.length ?? 0;
        const response = await fetch(query, { signal: AbortSignal.timeout(7000) });
        assert.equal(response.status, 200);
        const payload = await response.json();
        const calls = timings.get(source);
        assert.equal(calls?.length, count + 1, JSON.stringify({profile, page, received: providerRequests, failures: payload.unresponsive_engines}));
        console.log(JSON.stringify({ profile, requestedPage: page, forwardedPage: calls.at(-1).page,
          results: payload.results.length }));
      }
    }
  }

  const firstSocket = new Map();
  const modes = probePagination ? [] : probeIdle ? [["idle", 2]] : [["local", 60], ["delay", 30]];
  for (const [mode, total] of modes) {
    for (let sample = probeIdle ? 0 : -5; sample < total; sample++) {
      if (probeIdle && sample === 1) await delay(8000);
      const query = mode + "-fixture-" + sample;
      const order = sample % 2 ? [...services].reverse() : services;
      for (const [profile, service] of order) {
        const url = new URL("/search", service.base);
        url.search = new URLSearchParams({ q: query, format: "json", engines: "wiby", language: "en" });
        url.searchParams.set("pageno", "1");
        if (profile === "rustxng") url.searchParams.set("strict_engines", "1");
        const count = timings.get(query)?.length ?? 0;
        const start = performance.now();
        const response = await fetch(url, { signal: AbortSignal.timeout(7000) });
        assert.equal(response.status, 200);
        const payload = await response.json();
        const ended = performance.now();
        const normalized = payload.results.map((entry) => [entry.url, entry.title, entry.content]).sort();
        const expected = providerRows(query).map(({ URL, Title, Snippet }) => [URL, Title, Snippet]).sort();
        assert.ok(normalized.length > 0, JSON.stringify({
          profile, query, providerCalls: timings.get(query)?.length ?? 0,
          failures: payload.unresponsive_engines, received: providerRequests,
        }));
        assert.deepEqual(normalized, expected);
        const calls = timings.get(query);
        assert.equal(calls?.length, count + 1, "expected one provider call per search");
        const { entered, sent, socket } = calls.at(-1);
        if (probeIdle && sample === 0) firstSocket.set(profile, socket);
        if (sample >= 0) {
          const ms = (value) => +value.toFixed(3);
          console.log(JSON.stringify({
            mode, sample: sample + 1, profile, count: normalized.length,
            totalMs: ms(ended - start), toProviderMs: ms(entered - start),
            providerMs: ms(sent - entered), afterProviderMs: ms(ended - sent),
            ...(probeIdle && { rustKeepaliveSeconds: rustKeepalive,
              reusedProviderSocket: sample === 1 ? socket === firstSocket.get(profile) : null }),
          }));
        }
      }
    }
  }
} finally {
  for (const [, service] of services) await service.close();
  fixture?.closeAllConnections();
  if (fixture?.listening) await new Promise((resolve) => fixture.close(resolve));
  await Promise.allSettled([yml, toml, certificate, privateKey, rootCA, rootKey, csr, extensions].map((file) => unlink(file)));
  await rmdir(folder);
}
