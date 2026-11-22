import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isReference, topics } from "./topics.mjs";

const [binary] = process.argv.slice(2);
if (!binary) throw Error("Usage: node bench/first-pass.mjs <RustXNG executable>");
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(?:(?:https?|all)_proxy$|searxng_|rustxng_)/i.test(name)));
const strategies = [
  { name: "parallel", engines: "wikipedia,wiby", strategy: "parallel" },
  { name: "staged", engines: "wikipedia,wiby", strategy: "staged" },
  { name: "deadline-450", engines: "wikipedia,wiby", strategy: "parallel", deadline: "0.45" },
  { name: "wikipedia-only", engines: "wikipedia", strategy: "parallel" },
];

async function launch(config) {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((accept, reject) => listener.close((error) => error ? reject(error) : accept()));
  const base = "http://127.0.0.1:" + port;
  const child = spawn(resolve(binary), [
    "--profile", "standard", "--config", config, "--bind", "127.0.0.1", "--port", String(port),
  ], { windowsHide: true, detached: false, shell: false, stdio: "ignore", env });
  let failure;
  child.on("error", (error) => { failure = error; });
  const closed = new Promise((accept) => child.once("close", accept));
  async function close() {
    if (child.exitCode === null && !failure) child.kill();
    await closed;
  }
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (failure || child.exitCode !== null) throw failure ?? Error("RustXNG exited");
      const response = await fetch(base + "/healthz", { signal: AbortSignal.timeout(300) }).catch(() => null);
      if (response?.ok) return { base, close };
      await delay(100);
    }
    throw Error("RustXNG did not become ready");
  } catch (error) {
    await close();
    throw error;
  }
}

async function request(base, mode, query, language) {
  const uri = new URL("/search", base);
  uri.search = new URLSearchParams({
    q: query, language, format: "json", engines: mode.engines, strict_engines: "1", full: "1",
  });
  if (mode.deadline) uri.searchParams.set("timeout_limit", mode.deadline);
  const start = performance.now();
  const response = await fetch(uri, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw Error("Search HTTP " + response.status);
  const payload = await response.json();
  if (!Array.isArray(payload.results)) throw Error("Missing results array");
  const ms = +(performance.now() - start).toFixed(2);
  const sources = new Set(payload.results.flatMap((row) => row.engines ?? [row.engine]).filter(Boolean));
  return { ms, payload, sources };
}

const directory = await mkdtemp(join(tmpdir(), "rustxng-first-pass-"));
try {
  for (const mode of strategies) {
    mode.config = join(directory, mode.name + ".toml");
    await writeFile(mode.config, [
      "[search]", 'strategy = "' + mode.strategy + '"', "staged_tier = 1", "staged_min_results = 8", "",
    ].join("\n"));
  }
  for (let trial = 1; trial <= 2; trial++) {
    const servers = [];
    try {
      for (const mode of strategies) servers.push(await launch(mode.config));
      for (const [index, [topic, query, language, article]] of topics.entries()) {
        const shift = (index + (trial - 1) * 2) % strategies.length;
        for (let turn = 0; turn < strategies.length; turn++) {
          const current = (shift + turn) % strategies.length;
          const mode = strategies[current];
          const { ms, payload, sources } = await request(servers[current].base, mode, query, language);
          const rank = payload.results.slice(0, 5)
            .findIndex((row) => isReference(row.url, language, article)) + 1;
          console.log(JSON.stringify({
            kind: "new-query", trial, mode: mode.name, topic, ms, rank,
            results: payload.results.length, wiby: sources.has("wiby"),
            engineFailures: payload.unresponsive_engines?.length ?? 0,
          }));
          await delay(220);
        }
      }
    } finally {
      for (const server of servers) await server.close();
    }
  }

  // Unrelated warm-up warms the connection pool; the exact query warms the result cache.
  const parallel = strategies[0];
  for (const [index, [topic, query, language, article]] of topics.slice(0, 6).entries()) {
    for (const treatment of index % 2 ? ["unrelated", "cold"] : ["cold", "unrelated"]) {
      const server = await launch(parallel.config);
      try {
        if (treatment === "unrelated") {
          await request(server.base, parallel, language === "ru" ? "Фазовый переход" : "Radio telescope", language);
        }
        for (const stage of [treatment, "same-query"]) {
          const { ms, payload } = await request(server.base, parallel, query, language);
          const rank = payload.results.slice(0, 5)
            .findIndex((row) => isReference(row.url, language, article)) + 1;
          console.log(JSON.stringify({ kind: "startup", treatment, stage, topic, ms, rank,
            results: payload.results.length, engineFailures: payload.unresponsive_engines?.length ?? 0 }));
        }
      } finally {
        await server.close();
      }
      await delay(250);
    }
  }
} finally {
  await Promise.allSettled(strategies.filter((mode) => mode.config).map((mode) => unlink(mode.config)));
  await rmdir(directory);
}
