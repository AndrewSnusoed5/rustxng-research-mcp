import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [rustxng, python, searxngCheckout] = process.argv.slice(2);
const probePagination = process.argv.includes("--pagination");
if (!searxngCheckout) throw Error("Usage: node bench/matched-provider.mjs <RustXNG> <SearXNG Python> <checkout>");
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(?:(?:https?|all)_proxy$|searxng_|rustxng_)/i.test(name)));
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
  samples.push({ entered, sent: performance.now(), page: url.searchParams.get("p") });
  timings.set(query, samples);
  response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

async function ephemeralPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function launch(binary, args, options, port) {
  const worker = spawn(resolve(binary), args, {
    ...options, windowsHide: true, shell: false, detached: false, stdio: process.env.BENCH_VERBOSE ? ["ignore", "ignore", "inherit"] : "ignore",
  });
  let failure;
  worker.on("error", (error) => { failure = error; });
  const closed = new Promise((resolve) => worker.once("close", resolve));
  const base = "http://127.0.0.1:" + port;
  const close = async () => {
    if (!failure && worker.exitCode === null) {
      if (process.platform === "win32") {
        try {
          execFileSync("taskkill.exe", ["/pid", String(worker.pid), "/t", "/f"], {
            windowsHide: true, stdio: "ignore",
          });
        } catch {
          worker.kill();
        }
      } else {
        worker.kill();
      }
    }
    await closed;
  };
  try {
    for (let attempt = 0; attempt < 70; attempt++) {
      if (failure || worker.exitCode !== null) throw failure ?? Error("Service exited before readiness");
      const response = await fetch(base + "/healthz", { signal: AbortSignal.timeout(300) }).catch(() => null);
      if (response?.ok) return { base, close };
      await delay(100);
    }
    throw Error("Service did not become ready");
  } catch (error) {
    await close();
    throw error;
  }
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
    "[[engines]]", 'name = "wiby"', 'engine = "json_engine"', 'shortcut = "wib"',
    'categories = ["general"]', "paging = true", 'search_url = "' + provider + '"',
    'url_query = "URL"', 'title_query = "Title"', 'content_query = "Snippet"', "",
  ].join("\n"));
  const pythonPort = await ephemeralPort();
  const target = process.platform === "win32" ? "searxng_windows:app" : "searx.webapp:app";
  services.push(["searxng", await launch(python, ["-m", "granian", "--interface", "wsgi", "--host",
    "127.0.0.1", "--port", String(pythonPort), "--workers", "1", target], {
    cwd: resolve(searxngCheckout),
    env: { ...env, PYTHONDONTWRITEBYTECODE: "1", SEARXNG_SETTINGS_PATH: yml, PYTHONPATH: [resolve("bench"), env.PYTHONPATH].filter(Boolean).join(delimiter) },
  }, pythonPort)]);
  const rustPort = await ephemeralPort();
  services.push(["rustxng", await launch(rustxng, ["--profile", "standard", "--config", toml,
    "--bind", "127.0.0.1", "--port", String(rustPort)], { env }, rustPort)]);

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

  for (const [mode, total] of probePagination ? [] : [["local", 60], ["delay", 30]]) {
    for (let sample = -5; sample < total; sample++) {
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
        const { entered, sent } = calls.at(-1);
        if (sample >= 0) {
          const ms = (value) => +value.toFixed(3);
          console.log(JSON.stringify({
            mode, sample: sample + 1, profile, count: normalized.length,
            totalMs: ms(ended - start), toProviderMs: ms(entered - start),
            providerMs: ms(sent - entered), afterProviderMs: ms(ended - sent),
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
