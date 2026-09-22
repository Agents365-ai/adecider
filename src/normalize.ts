/**
 * Normalization for the payload family shared by Jev and Laya.
 *
 * Verified 2026-09-21 against the live services and the TypeSafe docs: both return the same
 * structure, one entry in `answers` per question id, with the answer under a key named after its
 * primitive. The only additions on the Laya side are `action.act_probability` per answer and
 * top-level `routing` and `elapsed_ms`.
 */

import type { Answer, QuestionType, RoutingInfo, SystemOneResponse, Usage } from "./types.ts";
import { SystemOneError } from "./errors.ts";

const PRIMITIVES: readonly QuestionType[] = ["choice", "noul", "score"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberMap(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "number") return undefined;
    out[key] = raw;
  }
  return out;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") return undefined;
    out[key] = raw;
  }
  return out;
}

function normalizeAnswer(backend: string, id: string, raw: unknown): Answer {
  if (!isRecord(raw)) {
    throw new SystemOneError("bad_response", `answer ${JSON.stringify(id)} is not an object`, backend);
  }

  const type = raw["type"];
  if (typeof type !== "string" || !PRIMITIVES.includes(type as QuestionType)) {
    throw new SystemOneError(
      "bad_response",
      `answer ${JSON.stringify(id)} has type ${JSON.stringify(type)}; expected one of ${PRIMITIVES.join(", ")}`,
      backend
    );
  }
  const primitive = type as QuestionType;

  // Both backends key the answer by its primitive. `value` is accepted as well so a normalized
  // payload from another adapter can round-trip.
  const value = raw[primitive] ?? raw["value"];
  if (typeof value !== "string" && typeof value !== "number") {
    throw new SystemOneError(
      "bad_response",
      `answer ${JSON.stringify(id)} has no readable ${primitive} value`,
      backend
    );
  }
  if (primitive === "noul" && typeof value !== "number") {
    throw new SystemOneError(
      "bad_response",
      `noul answer ${JSON.stringify(id)} is ${JSON.stringify(value)}; a noul value must be a probability`,
      backend
    );
  }

  const answer: Answer = { id, type: primitive, value };

  if (typeof raw["confidence"] === "number") answer.confidence = raw["confidence"];

  const action = raw["action"];
  if (isRecord(action) && typeof action["act_probability"] === "number") {
    answer.actProbability = action["act_probability"];
  }

  const distribution = numberMap(raw["probabilities"]);
  if (distribution) answer.distribution = distribution;

  const legend = stringMap(raw["legend"]);
  if (legend) answer.legend = legend;

  answer.raw = raw;
  return answer;
}

export function normalizeAnswers(backend: string, rawAnswers: unknown): Record<string, Answer> {
  if (!isRecord(rawAnswers)) {
    throw new SystemOneError("bad_response", "payload has no `answers` object", backend);
  }
  const answers: Record<string, Answer> = {};
  for (const [id, raw] of Object.entries(rawAnswers)) {
    answers[id] = normalizeAnswer(backend, id, raw);
  }
  if (Object.keys(answers).length === 0) {
    throw new SystemOneError("bad_response", "payload `answers` object is empty", backend);
  }
  return answers;
}

function normalizeUsage(raw: unknown): Usage {
  if (!isRecord(raw)) return {};
  const usage: Usage = {};
  if (typeof raw["input_tokens"] === "number") usage.inputTokens = raw["input_tokens"];
  if (typeof raw["output_tokens"] === "number") usage.outputTokens = raw["output_tokens"];
  return usage;
}

function normalizeRouting(raw: unknown): RoutingInfo | undefined {
  if (!isRecord(raw)) return undefined;
  const routing: RoutingInfo = {};
  if (typeof raw["model"] === "string") routing.checkpoint = raw["model"];
  if (typeof raw["reason"] === "string") routing.reason = raw["reason"];
  const detection = raw["detection"];
  if (isRecord(detection)) {
    if (typeof detection["language"] === "string") routing.language = detection["language"];
    if (typeof detection["script"] === "string") routing.script = detection["script"];
  }
  return Object.keys(routing).length > 0 ? routing : undefined;
}

/** Read a Jev or Laya payload into the normalized response. Throws `bad_response` when unusable. */
export function normalizeFamilyResponse(
  backend: string,
  payload: unknown,
  elapsedMs: number
): SystemOneResponse {
  if (!isRecord(payload)) {
    throw new SystemOneError("bad_response", "payload is not a JSON object", backend);
  }
  const error = payload["error"];
  if (typeof error === "string") {
    throw new SystemOneError("bad_request", error, backend);
  }

  const response: SystemOneResponse = {
    answers: normalizeAnswers(backend, payload["answers"]),
    backend,
    usage: normalizeUsage(payload["usage"]),
    elapsedMs,
  };

  if (typeof payload["model"] === "string") response.label = payload["model"];
  const routing = normalizeRouting(payload["routing"]);
  if (routing) {
    response.routing = routing;
    if (routing.checkpoint) response.model = routing.checkpoint;
  }
  if (typeof payload["elapsed_ms"] === "number") response.elapsedMs = payload["elapsed_ms"];
  return response;
}
