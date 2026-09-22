/**
 * End-to-end over the real MCP surface: spawn the server, speak newline-delimited JSON-RPC to it,
 * and check what a client would see. The backend is the fake Laya service, so nothing here needs a
 * model.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeLaya, THREE_QUESTIONS, type FakeLaya } from "./helpers/fake-laya.ts";

const SERVER = path.resolve(fileURLToPath(import.meta.url), "../../src/mcp/server.ts");

interface JsonRpcMessage {
  id?: number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private waiting = new Map<number, (message: JsonRpcMessage) => void>();
  private nullIdQueue: JsonRpcMessage[] = [];
  private nullIdWaiter: ((message: JsonRpcMessage) => void) | null = null;
  readonly stderr: string[] = [];
  readonly dir: string;

  constructor(baseUrl: string) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "adecider-mcp-"));
    const configPath = path.join(this.dir, "adecider.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        chain: ["fake"],
        backends: { fake: { kind: "laya", baseUrl } },
      })
    );

    this.child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, ADECIDER_CONFIG: configPath },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const message = JSON.parse(trimmed) as JsonRpcMessage;
      const id = message.id;
      if (typeof id === "number") {
        const resolve = this.waiting.get(id);
        if (resolve) {
          this.waiting.delete(id);
          resolve(message);
        }
        continue;
      }
      // A message with no id is a failure the server could not attribute to a request.
      if (this.nullIdWaiter) {
        const waiter = this.nullIdWaiter;
        this.nullIdWaiter = null;
        waiter(message);
      } else {
        this.nullIdQueue.push(message);
      }
    }
  }

  /** Write a raw line, for framing and parse-error tests. */
  writeRaw(line: string): void {
    this.child.stdin.write(line);
  }

  /** The next message the server could not attach to a request id, such as a parse error. */
  nextNullIdMessage(): Promise<JsonRpcMessage> {
    const queued = this.nullIdQueue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.nullIdWaiter = null;
        reject(new Error(`timed out waiting for a null-id message; stderr: ${this.stderr.join("")}`));
      }, 10_000);
      this.nullIdWaiter = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
    });
  }

  request(method: string, params?: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`timed out waiting for ${method}; stderr: ${this.stderr.join("")}`));
      }, 10_000);
      this.waiting.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

async function withServer(run: (client: McpClient, fake: FakeLaya) => Promise<void>): Promise<void> {
  const fake = await startFakeLaya();
  const client = new McpClient(fake.url);
  try {
    await run(client, fake);
  } finally {
    await client.close();
    await fake.close();
  }
}

test("initialize negotiates a protocol version and advertises tools", async () => {
  await withServer(async (client) => {
    const response = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test", version: "0" },
    });
    const result = response.result as {
      protocolVersion: string;
      capabilities: Record<string, unknown>;
      serverInfo: { name: string };
    };
    assert.equal(result.protocolVersion, "2025-06-18");
    assert.deepEqual(result.capabilities, { tools: {} });
    assert.equal(result.serverInfo.name, "adecider");

    client.notify("notifications/initialized");
    const pong = await client.request("ping");
    assert.deepEqual(pong.result, {});
  });
});

test("negotiates down to an older revision a client asks for", async () => {
  await withServer(async (client) => {
    const response = await client.request("initialize", { protocolVersion: "2024-11-05" });
    assert.equal((response.result as { protocolVersion: string }).protocolVersion, "2024-11-05");
  });
});

test("the tool surface is exactly one tool", async () => {
  await withServer(async (client) => {
    const response = await client.request("tools/list");
    const tools = (response.result as { tools: Array<Record<string, unknown>> }).tools;
    assert.equal(tools.length, 1, "every exposed tool is a permanent context tax on every request");
    assert.equal(tools[0]?.["name"], "decide");
    const schema = tools[0]?.["inputSchema"] as { required: string[] };
    assert.deepEqual(schema.required, ["state", "questions"]);
    assert.ok((tools[0]?.["description"] as string).length > 100, "the description carries the routing signal");
  });
});

test("a tool call returns one answer per question id", async () => {
  await withServer(async (client, fake) => {
    const response = await client.request("tools/call", {
      name: "decide",
      arguments: { state: "a duplicate charge", questions: THREE_QUESTIONS, threshold: 0.7 },
    });
    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    assert.notEqual(result.isError, true);

    const payload = JSON.parse(result.content[0]?.text as string) as {
      backend: string;
      answers: Record<string, { value: unknown; score: number }>;
      decisions: Array<{ id: string; passed: boolean }>;
    };
    assert.equal(payload.backend, "fake");
    assert.equal(payload.answers["department"]?.value, "billing");
    assert.equal(payload.answers["churn_risk"]?.score, 0.7848);
    assert.equal(payload.decisions.length, 3);
    assert.equal(fake.decideRequests.length, 1);
  });
});

test("a failed judgment is a tool error, and the server keeps serving", async () => {
  await withServer(async (client) => {
    const bad = await client.request("tools/call", {
      name: "decide",
      arguments: { state: "x", questions: { a: { type: "nonsense", instructions: "y" } } },
    });
    const result = bad.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text as string, /bad_request/);
    assert.equal(bad.error, undefined, "a well-formed call does not produce a JSON-RPC error");

    const good = await client.request("tools/call", {
      name: "decide",
      arguments: { state: "x", questions: THREE_QUESTIONS },
    });
    assert.notEqual((good.result as { isError?: boolean }).isError, true, "the process still works");
  });
});

test("protocol misuse is answered with JSON-RPC errors", async () => {
  await withServer(async (client) => {
    const unknownTool = await client.request("tools/call", { name: "nope", arguments: {} });
    assert.equal(unknownTool.error?.code, -32602);

    const unknownMethod = await client.request("tools/nonexistent");
    assert.equal(unknownMethod.error?.code, -32601);

    client.writeRaw("not json\n");
    const malformed = await client.nextNullIdMessage();
    assert.equal(malformed.error?.code, -32700);
  });
});
