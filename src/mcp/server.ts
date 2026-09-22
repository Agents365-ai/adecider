/**
 * Minimal MCP server over stdio.
 *
 * Hand-rolled on purpose. The official SDK pulls sixteen transitive dependencies (express, hono,
 * jose, cors, ajv, ...) for a stdio server that needs four JSON-RPC methods, and this server gets
 * installed into every harness on the machine. Stdio framing is newline-delimited JSON-RPC, so the
 * transport is a line splitter and a writer.
 *
 * Results carry the judgment as pretty-printed JSON text and nothing else: no outputSchema, no
 * structuredContent, because a client that validates those strictly is a compatibility risk and the
 * agent reads the text anyway.
 */

import { describeError, isSystemOneError } from "../errors.ts";
import { judge, type JudgeInput } from "../judge.ts";
import { BackendChain } from "../backends/index.ts";
import { loadConfig } from "../config.ts";

const SERVER_NAME = "adecider";
const SERVER_VERSION = "0.1.0";

/** Protocol revisions this server implements. The client's choice is echoed when it is one of them. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const TOOL_NAME = "decide";

const TOOL_DESCRIPTION = [
  "Answer typed decision questions about a piece of state and return one calibrated answer per",
  "question id, in a single call. Three question types: noul (yes/no probability), choice (pick one",
  "of a named set), score (pick a level from an ordered rubric). Use it instead of asking a model to",
  "judge: one call answers many questions, the answers carry probabilities rather than prose, and",
  "nothing has to be parsed out of generated text. Backed by a local calibrated decision model when",
  "one is running, so repeated calls are cheap.",
].join(" ");

const TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    state: {
      description:
        "The material to judge: text, a diff, a log, or a JSON object. Keep it to what the questions need.",
    },
    questions: {
      type: "object",
      description:
        "Map of stable ids to questions. Every id comes back with its own answer. Ask several at once; one call answers them all.",
      additionalProperties: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["choice", "noul", "score"],
            description:
              "noul: probability that a statement is true. choice: exactly one option from criteria. score: one level from an ordered rubric.",
          },
          instructions: {
            type: "string",
            description: "The judgment to make, phrased as a single clear question.",
          },
          criteria: {
            description:
              "choice: an object mapping option keys to descriptions. score: an array of rubric levels, lowest first. noul: optional short clarification.",
          },
        },
        required: ["type", "instructions"],
      },
    },
    backend: {
      type: "string",
      description:
        "Force a backend by name instead of using the configured chain. A forced backend never falls back.",
    },
    model: {
      type: "string",
      description: "Checkpoint or model id for the backend: english, multilingual, or jev-latest.",
    },
    threshold: {
      type: "number",
      description:
        "Add pass/fail verdicts: an answer passes when its score clears this. Calibrated backends only, so a threshold against an uncalibrated backend is refused unless allow_uncalibrated is set.",
    },
    top_k: {
      type: "integer",
      description:
        "Ranking mode instead of thresholding: mark the top K answers by score as passing. Use this for uncalibrated backends, where only the ordering is meaningful.",
    },
    min_confidence: {
      type: "number",
      description:
        "Optional second gate: an answer whose confidence is below this fails, even when its score clears the threshold.",
    },
    allow_uncalibrated: {
      type: "boolean",
      description:
        "Permit thresholding an uncalibrated backend, marking every verdict uncalibrated in the result.",
    },
  },
  required: ["state", "questions"],
};

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

const chain = BackendChain.fromConfig(loadConfig());

/** Requests being answered right now, so a closed stdin does not cut a reply short. */
const inFlight = new Set<Promise<void>>();

function write(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id: string | number | null | undefined, result: unknown): void {
  write({ jsonrpc: "2.0", id: id ?? null, result });
}

function respondError(id: string | number | null | undefined, code: number, message: string): void {
  write({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function callTool(params: unknown): Promise<Record<string, unknown>> {
  const args = asRecord(asRecord(params)["arguments"]);
  const input: JudgeInput = {
    state: args["state"],
    questions: asRecord(args["questions"]),
  };
  if (typeof args["backend"] === "string") input.backend = args["backend"];
  if (typeof args["model"] === "string") input.model = args["model"];
  if (typeof args["preset"] === "string") input.preset = args["preset"];
  if (typeof args["threshold"] === "number") input.threshold = args["threshold"];
  if (typeof args["min_confidence"] === "number") input.minConfidence = args["min_confidence"];
  if (typeof args["top_k"] === "number") input.topK = args["top_k"];
  if (args["allow_uncalibrated"] === true) input.allowUncalibrated = true;

  try {
    const result = await judge(input, { chain });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    // A failed judgment belongs in the result with isError, not in a JSON-RPC error: the call was
    // well formed, the verdict just could not be produced.
    const text = describeError(error);
    return {
      content: [{ type: "text", text }],
      isError: true,
    };
  }
}

async function handle(request: JsonRpcRequest): Promise<void> {
  const method = request.method ?? "";
  const id = request.id;

  if (method === "initialize") {
    const requested = asRecord(request.params)["protocolVersion"];
    const protocolVersion =
      typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : DEFAULT_PROTOCOL_VERSION;
    respond(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }

  // Notifications carry no id and take no reply.
  if (method.startsWith("notifications/")) return;

  if (method === "ping") {
    respond(id, {});
    return;
  }

  if (method === "tools/list") {
    respond(id, {
      tools: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: TOOL_INPUT_SCHEMA }],
    });
    return;
  }

  if (method === "tools/call") {
    const name = asRecord(request.params)["name"];
    if (name !== TOOL_NAME) {
      respondError(id, -32602, `unknown tool ${JSON.stringify(name)}; this server exposes ${TOOL_NAME}`);
      return;
    }
    respond(id, await callTool(request.params));
    return;
  }

  if (id === undefined || id === null) return;
  respondError(id, -32601, `method not found: ${method}`);
}

function dispatch(line: string): void {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch (error) {
    respondError(null, -32700, `parse error: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const pending = handle(request).catch((error: unknown) => {
    if (request.id === undefined || request.id === null) return;
    const detail = isSystemOneError(error) ? describeError(error) : String(error);
    respondError(request.id, -32603, `internal error: ${detail}`);
  });
  inFlight.add(pending);
  void pending.finally(() => inFlight.delete(pending));
}

function main(): void {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 0) dispatch(trimmed);
    }
  });
  // A closed stdin ends the session, but a judgment already in flight still gets to answer: a
  // caller that pipes one request in and closes the pipe would otherwise read nothing back.
  process.stdin.on("end", () => {
    void (async () => {
      while (inFlight.size > 0) {
        await Promise.all([...inFlight]);
      }
      process.exit(0);
    })();
  });
}

main();
