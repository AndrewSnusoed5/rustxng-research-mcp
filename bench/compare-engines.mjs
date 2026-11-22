import { topics, isReference } from "./topics.mjs";
import { setTimeout as delay } from "node:timers/promises";

const [searxng, rustxng] = process.argv.slice(2);
if (!searxng || !rustxng) {
  throw Error("Usage: node bench/compare-engines.mjs <SearXNG base URL> <RustXNG base URL>");
}
const trials = Number(process.env.BENCH_ENGINE_TRIALS ?? 2);
if (!Number.isSafeInteger(trials) || trials < 1) throw Error("BENCH_ENGINE_TRIALS must be a positive integer");
const engineSets = (process.env.BENCH_ENGINE_SETS ?? "wikipedia;wikipedia,wiby").split(";");

const profiles = [["searxng", searxng], ["rustxng", rustxng]];

async function sample([profile, base], trial, engines, [topic, query, language, article]) {
  const url = new URL("search", base.replace(/\/?$/, "/"));
  url.search = new URLSearchParams({ format: "json", q: query, language, engines, safesearch: "0" });
  if (profile === "rustxng") url.searchParams.set("strict_engines", "1");
  const start = performance.now();
  const row = { profile, trial, engines, topic };
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw Error("HTTP " + response.status);
    const payload = await response.json();
    if (!Array.isArray(payload.results)) throw Error("Missing results array");
    const ms = +(performance.now() - start).toFixed(2);
    const returned = payload.results.slice(0, 5);
    const used = new Set(returned.flatMap((result) => result.engines ?? [result.engine]).filter(Boolean));
    const allowed = new Set(engines.split(","));
    if ([...used].some((engine) => !allowed.has(engine))) throw Error("Unexpected engine in top-five results");
    const rank = returned.findIndex((result) => isReference(result.url, language, article)) + 1;
    return {
      ...row, ms, results: payload.results.length, top5: returned.length, rank,
      engineFailures: payload.unresponsive_engines?.length ?? 0,
    };
  } catch (error) {
    return { ...row, error: error.message };
  }
}

for (const engines of engineSets) {
  for (let trial = 1; trial <= trials; trial++) {
    for (const [index, topic] of topics.entries()) {
      const order = (trial + index) % 2 === 0 ? profiles : [...profiles].reverse();
      for (const profile of order) {
        console.log(JSON.stringify(await sample(profile, trial, engines, topic)));
        await delay(200);
      }
    }
  }
}
