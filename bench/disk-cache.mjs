import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mcp } from "./mcp.mjs";

const [binary] = process.argv.slice(2);
if (!binary) throw Error("Usage: node bench/disk-cache.mjs <wrapper executable>");
const requested = { query: "Tokio documentation", language: "en", limit: 5 };
const payload = { results: [{ title: "Tokio", url: "https://tokio.rs/", content: "Documentation" }] };
let online = true;
let requests = 0;
const http = createServer((_, response) => {
  requests++;
  response.writeHead(online ? 200 : 503, { "Content-Type": "application/json" });
  response.end(online ? JSON.stringify(payload) : "{}");
});
const directory = await mkdtemp(join(tmpdir(), "rustxng-disk-bench-"));
const dbPath = join(directory, "results.sqlite3");
try {
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const env = {
    ...process.env,
    RUSTXNG_URL: "http://127.0.0.1:" + http.address().port,
    RUSTXNG_DISK_CACHE_PATH: dbPath,
    RUSTXNG_DISK_CACHE_TTL_SECONDS: "600",
  };
  const seed = await mcp(resolve(binary), env);
  try {
    assert.deepEqual((await seed.call("rustxng_search", requested)).structuredContent, payload);
  } finally {
    await seed.close();
  }
  assert.equal(requests, 1);

  online = false;
  for (let sample = 1; sample <= 20; sample++) {
    const restarted = await mcp(resolve(binary), env);
    try {
      const start = performance.now();
      const reply = await restarted.call("rustxng_search", requested);
      const ms = +(performance.now() - start).toFixed(3);
      assert.deepEqual(reply.structuredContent, payload);
      assert.equal(requests, 1);
      console.log(JSON.stringify({ sample, ms, upstreamRequests: requests - 1 }));
    } finally {
      await restarted.close();
    }
  }

  const client = await mcp(resolve(binary), env);
  try {
    await assert.rejects(client.call("rustxng_search", { ...requested, language: "ru" }));
    assert.equal(requests, 2);
  } finally {
    await client.close();
  }
} finally {
  http.closeAllConnections();
  if (http.listening) await new Promise((resolve) => http.close(resolve));
  await unlink(dbPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await rmdir(directory);
}
