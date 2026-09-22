/**
 * Any OpenAI-compatible chat endpoint, which is the escape hatch for models that are not System One
 * models at all. Local llama.cpp servers managed by prism-ml speak this dialect on 8090 and 8091.
 *
 * This backend cannot report calibrated probabilities: nothing trained it against a scoring rule, so
 * its numbers are self-reports. It is declared `ranking` and a threshold request against it fails
 * unless the caller explicitly accepts an uncalibrated comparison.
 *
 * All questions go in one call. A per-question loop would turn a single System One request into as
 * many model calls as there are questions.
 */

import type { Answer, Question, QuestionType, SystemOneRequest, SystemOneResponse } from "../types.ts";
import { SystemOneError } from "../errors.ts";
import {
  DEFAULT_TIMEOUT_MS,
  isLocalUrl,
  requestSignal,
  statusErrorCode,
  type Backend,
  type BackendSpec,
  type Health,
} from "./types.ts";

interface CompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildPrompt(state: unknown, questions: Record<string, Question>): string {
  const lines: string[] = [
    "You are answering typed decision questions about the state below.",
    "Return one JSON object and nothing else, in exactly this shape:",
    '{"answers": {"<question id>": {"value": <answer>, "probability": <number 0..1>, "probabilities": {"<option>": <number 0..1>}}}}',
    "",
    "Rules per question type:",
    '- choice: "value" is exactly one of the criteria keys. "probabilities" maps every criteria key to a number in [0,1].',
    '- score: "value" is the numeric level chosen, counting from 0 for the first criterion, lowest first. "probabilities" maps each level index as a string to a number in [0,1].',
    '- noul: "value" is a number in [0,1], the probability that the statement is true.',
    '"probability" is your own confidence in the answer you gave, in [0,1]. Include one entry in "answers" for every question id.',
    "",
    "Questions:",
    JSON.stringify(questions, null, 1),
    "",
    "State:",
    typeof state === "string" ? state : JSON.stringify(state, null, 1),
  ];
  return lines.join("\n");
}

/** Pull the first JSON object out of a reply that may contain fences or prose. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("no JSON object in the reply");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function numberMap(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeCompletionAnswers(
  backend: string,
  rawAnswers: unknown,
  questions: Record<string, Question>
): Record<string, Answer> {
  if (!isRecord(rawAnswers)) {
    throw new SystemOneError("bad_response", `${backend} reply has no answers object`, backend);
  }
  const answers: Record<string, Answer> = {};

  for (const [id, question] of Object.entries(questions)) {
    const raw = rawAnswers[id];
    if (!isRecord(raw)) {
      throw new SystemOneError(
        "bad_response",
        `${backend} answered no question ${JSON.stringify(id)}`,
        backend
      );
    }
    const type = question.type;
    const answer: Answer = { id, type, value: "" };

    if (type === "noul") {
      const probability = raw["value"] ?? raw["probability"];
      if (typeof probability !== "number" || probability < 0 || probability > 1) {
        throw new SystemOneError(
          "bad_response",
          `${backend} noul answer ${JSON.stringify(id)} is ${JSON.stringify(probability)}; expected a number in [0,1]`,
          backend
        );
      }
      answer.value = probability;
    } else if (type === "choice") {
      const value = raw["value"];
      if (typeof value !== "string") {
        throw new SystemOneError(
          "bad_response",
          `${backend} choice answer ${JSON.stringify(id)} is not a string`,
          backend
        );
      }
      const options = Object.keys(question.criteria);
      if (!options.includes(value)) {
        throw new SystemOneError(
          "bad_response",
          `${backend} choice answer ${JSON.stringify(id)} is ${JSON.stringify(value)}, which is not one of ${options.join(", ")}`,
          backend
        );
      }
      answer.value = value;
    } else {
      const value = raw["value"];
      const level = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(level) || level < 0 || level > question.criteria.length - 1) {
        throw new SystemOneError(
          "bad_response",
          `${backend} score answer ${JSON.stringify(id)} is ${JSON.stringify(value)}; expected a level from 0 to ${question.criteria.length - 1}`,
          backend
        );
      }
      answer.value = level;
      answer.legend = Object.fromEntries(question.criteria.map((text, index) => [String(index), text]));
    }

    const distribution = numberMap(raw["probabilities"]);
    if (distribution) answer.distribution = distribution;
    if (typeof raw["probability"] === "number") answer.confidence = raw["probability"];
    answer.raw = raw;
    answers[id] = answer;
  }

  return answers;
}

export function createOpenAiBackend(spec: BackendSpec): Backend {
  const name = spec.name;
  const baseUrl = (spec.baseUrl ?? "http://127.0.0.1:8090/v1").replace(/\/+$/, "");
  // A chat model generates the JSON, so it is orders of magnitude slower than a decision model:
  // 26 s measured for a 2-question judgment on a local 27B. The shared 30 s default is too tight.
  const timeoutMs = spec.timeoutMs ?? 120_000;
  const endpoint = `${baseUrl}/chat/completions`;

  async function call(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined
  ): Promise<Response> {
    try {
      return await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(spec.apiKey ? { authorization: `Bearer ${spec.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: requestSignal(signal, timeoutMs),
      });
    } catch (error) {
      throw new SystemOneError(
        error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable",
        `${name} call failed: ${error instanceof Error ? error.message : String(error)}`,
        name
      );
    }
  }

  return {
    name,
    kind: "openai",
    calibration: "ranking",
    endpoint,
    // A remote base URL means the state leaves this machine even though the dialect is the local one.
    cloud: !isLocalUrl(baseUrl),
    contextTokens: spec.contextTokens ?? 4096,

    contextTokensFor(): number {
      return spec.contextTokens ?? 4096;
    },

    async health(signal?: AbortSignal): Promise<Health> {
      const url = `${baseUrl}/models`;
      try {
        const response = await fetch(url, { signal: requestSignal(signal, 5_000) });
        if (!response.ok) return { ok: false, detail: `HTTP ${response.status} from ${url}` };
        const payload = await response.json() as { data?: Array<{ id?: string }> };
        const ids = (payload.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
        return {
          ok: ids.length > 0,
          detail: ids.length > 0 ? `serves ${ids.join(", ")}` : `no models listed at ${url}`,
          models: ids.length > 0 ? ids : spec.model ? [spec.model] : undefined,
        };
      } catch (error) {
        return {
          ok: false,
          detail: `not reachable at ${url} (${error instanceof Error ? error.message : String(error)})`,
        };
      }
    },

    async decide(request: SystemOneRequest, signal?: AbortSignal): Promise<SystemOneResponse> {
      if (!request.model && !spec.model) {
        throw new SystemOneError(
          "bad_request",
          `backend ${name} needs a model id; pass model in the request or set it in the backend config`,
          name
        );
      }
      const model = request.model ?? (spec.model as string);
      const base: Record<string, unknown> = {
        model,
        temperature: 0,
        stream: false,
        max_tokens: 2048,
        messages: [
          { role: "system", content: "You answer typed decision questions and reply with JSON only." },
          { role: "user", content: buildPrompt(request.state, request.questions) },
        ],
      };

      const started = performance.now();
      let response = await call({ ...base, response_format: { type: "json_object" } }, signal);
      let retriedWithoutFormat = false;
      if (response.status === 400) {
        // Many local servers reject response_format. Ask again without it and rely on extraction.
        response = await call(base, signal);
        retriedWithoutFormat = true;
      }
      const elapsedMs = performance.now() - started;

      let payload: CompletionResponse;
      try {
        payload = await response.json() as CompletionResponse;
      } catch {
        throw new SystemOneError("bad_response", `${name} returned a non-JSON body`, name);
      }
      if (!response.ok) {
        const detail = JSON.stringify(payload).slice(0, 400);
        throw new SystemOneError(
          statusErrorCode(response.status),
          `${name} rejected the request: ${detail}${retriedWithoutFormat ? " (also without response_format)" : ""}`,
          name
        );
      }

      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new SystemOneError("bad_response", `${name} returned an empty completion`, name);
      }

      let parsed: unknown;
      try {
        parsed = extractJson(content);
      } catch (error) {
        throw new SystemOneError(
          "bad_response",
          `${name} reply was not JSON: ${error instanceof Error ? error.message : String(error)}; first 200 characters: ${content.slice(0, 200)}`,
          name
        );
      }
      if (!isRecord(parsed)) {
        throw new SystemOneError("bad_response", `${name} reply JSON is not an object`, name);
      }

      const outcome: SystemOneResponse = {
        answers: normalizeCompletionAnswers(name, parsed["answers"], request.questions),
        backend: name,
        usage: {
          ...(typeof payload.usage?.prompt_tokens === "number"
            ? { inputTokens: payload.usage.prompt_tokens }
            : {}),
          ...(typeof payload.usage?.completion_tokens === "number"
            ? { outputTokens: payload.usage.completion_tokens }
            : {}),
        },
        elapsedMs: Math.round(elapsedMs * 10) / 10,
      };
      if (typeof payload.model === "string") outcome.label = payload.model;
      else outcome.label = model;
      return outcome;
    },
  };
}
