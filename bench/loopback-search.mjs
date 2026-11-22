import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const directEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(?:(?:https?|all)_proxy$|searxng_|rustxng_)/i.test(name)));

async function ephemeralPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

export async function launchLoopback(binary, argsForPort, options) {
  const port = await ephemeralPort();
  const args = argsForPort(port);
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
