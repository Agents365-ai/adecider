/**
 * A stand-in for a local Laya service, so the whole stack is testable without a live model and
 * without any network. The canned payload is the one measured from `laya-mlx` on 2026-09-21,
 * including the two fields Jev does not return: `action.act_probability` and top-level `routing`.
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";

export const CANNED_PAYLOAD = {
  model: "laya-rl-agent",
  answers: {
    department: {
      type: "choice",
      confidence: 0.5846,
      action: { act_probability: 1.0 },
      choice: "billing",
      probabilities: { billing: 0.8773, support: 0.0693, sales: 0.0534 },
    },
    urgency: {
      type: "score",
      confidence: 0.3516,
      action: { act_probability: 1.0 },
      score: 1.6661,
      legend: { "0": "not urgent", "1": "soon", "2": "critical deadline" },
      probabilities: { "0": 0.0302, "1": 0.2734, "2": 0.6964 },
    },
    churn_risk: {
      type: "noul",
      confidence: 0.7848,
      action: { act_probability: 1.0 },
      noul: 0.7848,
    },
  },
  usage: { input_tokens: 154, output_tokens: 0 },
  routing: {
    model: "english",
    repo: "/tmp/fake",
    reason: "English Latin text",
    detection: { script: "latin", language: "en", is_english: true },
    workflow: null,
  },
  elapsed_ms: 45.4,
};

export interface FakeLaya {
  url: string;
  /** Requests seen by /decide, so a test can assert what the adapter sent. */
  decideRequests: Array<Record<string, unknown>>;
  /** Requests seen by the OpenAI-compatible route, with the headers, for the same reason. */
  chatRequests: Array<{ headers: Record<string, unknown>; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** One answer in the shape both backends use, for an arbitrary question. */
function echoAnswer(question: Record<string, unknown>, probability: number): Record<string, unknown> {
  const type = question["type"];
  if (type === "noul") {
    return { type: "noul", noul: probability, confidence: probability, action: { act_probability: 1.0 } };
  }
  if (type === "choice") {
    const criteria = question["criteria"];
    const keys = criteria && typeof criteria === "object" ? Object.keys(criteria as object) : ["yes", "no"];
    const first = keys[0] ?? "yes";
    const rest = keys.slice(1);
    const probabilities: Record<string, number> = { [first]: probability };
    const share = rest.length > 0 ? (1 - probability) / rest.length : 0;
    for (const key of rest) probabilities[key] = share;
    return { type: "choice", choice: first, confidence: probability, probabilities, action: { act_probability: 1.0 } };
  }
  const criteria = question["criteria"];
  const levels = Array.isArray(criteria) ? criteria : ["low", "high"];
  const last = Math.max(0, levels.length - 1);
  const probabilities: Record<string, number> = {};
  for (let index = 0; index <= last; index += 1) probabilities[String(index)] = index === last ? probability : (1 - probability) / last;
  return {
    type: "score",
    score: last,
    confidence: probability,
    probabilities,
    legend: Object.fromEntries(levels.map((text, index) => [String(index), String(text)])),
    action: { act_probability: 1.0 },
  };
}

/** Build a payload that answers whatever questions the request asked, at a chosen probability. */
export function echoPayload(
  body: Record<string, unknown>,
  probability: number,
  usage?: { input_tokens: number; output_tokens: number }
): Record<string, unknown> {
  const questions = (body["questions"] ?? {}) as Record<string, Record<string, unknown>>;
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) answers[id] = echoAnswer(question, probability);
  return {
    model: "laya-rl-agent",
    answers,
    usage: usage ?? { input_tokens: 42, output_tokens: 0 },
    routing: { model: "english", reason: "echo fixture", detection: { script: "latin", language: "en" } },
    elapsed_ms: 1.5,
  };
}

export async function startFakeLaya(options?: {
  payload?: unknown;
  status?: number;
  health?: unknown;
  healthStatus?: number;
  /** Model id this fake advertises over the OpenAI-compatible routes. */
  openaiModel?: string;
  /**
   * Raw answers for the OpenAI-compatible route, keyed by question id, so a chat dialect can carry
   * the same numbers as a family payload. Defaults to `{value: echo, probability: echo}` per id.
   */
  chatAnswers?: Record<string, unknown>;
  /** Message content for the OpenAI-compatible route, verbatim. Defaults to the answers as JSON. */
  chatContent?: string;
  /** Response body for the OpenAI-compatible route, verbatim and not JSON. */
  chatRaw?: string;
  /** Status for the OpenAI-compatible route, or one per call in order, so a retry is testable. */
  chatStatus?: number | number[];
  /** Response body for /decide, verbatim and not JSON. */
  decideRaw?: string;
  /** Answer every question the request asks, at this probability, instead of a fixed payload. */
  echo?: number;
  onDecide?: (body: Record<string, unknown>) => unknown | undefined;
}): Promise<FakeLaya> {
  const decideRequests: Array<Record<string, unknown>> = [];
  const chatRequests: Array<{ headers: Record<string, unknown>; body: Record<string, unknown> }> = [];

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const path = (request.url ?? "").split("?")[0];

      if (path === "/health") {
        const status = options?.healthStatus ?? 200;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            options?.health ?? { status: "ok", runtime: "mlx", device: "gpu", loaded: ["english"] }
          )
        );
        return;
      }

      // The OpenAI-compatible dialect, so the openai backend is testable without a live llama.cpp.
      if (path === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: options?.openaiModel ?? "fake-chat-model" }] }));
        return;
      }

      if (path === "/v1/chat/completions") {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "bad body" } }));
          return;
        }
        decideRequests.push(parsed);
        chatRequests.push({ headers: request.headers as Record<string, unknown>, body: parsed });
        // Recover the question ids from the prompt the adapter built, and answer each of them.
        const messages = Array.isArray(parsed["messages"]) ? (parsed["messages"] as Array<{ content?: string }>) : [];
        const prompt = messages.map((message) => message.content ?? "").join("\n");
        const ids = [...prompt.matchAll(/"([A-Za-z0-9_]+)":\s*\{\s*"type"/g)].map((match) => match[1] as string);
        const answers: Record<string, unknown> = {};
        for (const id of ids) {
          const provided = options?.chatAnswers?.[id];
          if (provided !== undefined) {
            answers[id] = provided;
            continue;
          }
          // With an explicit answer map, an id that is missing was skipped by the model, which is a
          // case worth being able to replay. Without one, every id is echoed.
          if (options?.chatAnswers !== undefined) continue;
          answers[id] = { value: options?.echo ?? 0.9, probability: options?.echo ?? 0.9 };
        }

        const status = Array.isArray(options?.chatStatus)
          ? options.chatStatus[chatRequests.length - 1] ?? 200
          : options?.chatStatus ?? 200;
        if (options?.chatRaw !== undefined) {
          response.writeHead(status, { "content-type": "text/plain" });
          response.end(options.chatRaw);
          return;
        }
        const content = options?.chatContent !== undefined ? options.chatContent : JSON.stringify({ answers });
        response.writeHead(status, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            model: options?.openaiModel ?? "fake-chat-model",
            choices: [{ message: { content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          })
        );
        return;
      }

      if (path === "/decide") {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "empty request body; expected a JSON object" }));
          return;
        }
        decideRequests.push(parsed);

        const override = options?.onDecide?.(parsed);
        if (override !== undefined) {
          response.writeHead(options?.status ?? 200, { "content-type": "application/json" });
          response.end(JSON.stringify(override));
          return;
        }

        if (options?.decideRaw !== undefined) {
          response.writeHead(options?.status ?? 200, { "content-type": "text/plain" });
          response.end(options.decideRaw);
          return;
        }

        if (!("state" in parsed)) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "request is missing 'state'" }));
          return;
        }

        response.writeHead(options?.status ?? 200, { "content-type": "application/json" });
        const reply =
          options?.echo !== undefined
            ? echoPayload(parsed, options.echo)
            : options?.payload ?? CANNED_PAYLOAD;
        response.end(JSON.stringify(reply));
        return;
      }

      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: `unknown path '${path}'` }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    decideRequests,
    chatRequests,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}

export const THREE_QUESTIONS = {
  department: {
    type: "choice",
    instructions: "Which team should handle this?",
    criteria: { billing: "invoice issues", support: "how-to", sales: "pricing" },
  },
  urgency: {
    type: "score",
    instructions: "How urgent is this?",
    criteria: ["not urgent", "soon", "critical deadline"],
  },
  churn_risk: {
    type: "noul",
    instructions: "Does the customer threaten to cancel?",
  },
};
