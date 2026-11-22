import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

export async function mcp(executable, env) {
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
