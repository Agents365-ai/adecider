/**
 * The one entry point every adapter shares: validate, select a backend, normalize, optionally decide.
 *
 * Both the MCP tool and the CLI go through here, so the tool surface and the terminal cannot drift.
 */

import type { Answer, Question, QuestionType, SystemOneResponse } from "./types.ts";
import { SystemOneError } from "./errors.ts";
import { decide, scoreOf, type Decision } from "./policy.ts";
import { BackendChain, type Backend } from "./backends/index.ts";
import { loadConfig } from "./config.ts";
import { resolveModel } from "./models.ts";

export interface JudgeInput {
  state: unknown;
  questions: Record<string, unknown>;
  backend?: string;
  model?: string;
  preset?: string;
  /** Compare the score against this. Omit it and no pass/fail verdict is produced. */
  threshold?: number;
  /** Second gate on the confidence axis, applied only when the caller sets it. */
  minConfidence?: number;
  /** Ranking mode: take the top K by score instead of thresholding. */
  topK?: number;
  /** Permit thresholding a ranking backend, marking each verdict uncalibrated. */
  allowUncalibrated?: boolean;
}

/** An answer plus the number a decision rule would compare. */
export interface ScoredAnswer {
  type: QuestionType;
  value: string | number;
  score: number;
  confidence?: number;
  actProbability?: number;
  distribution?: Record<string, number>;
  legend?: Record<string, string>;
}

export interface JudgeOutput {
  backend: string;
  model?: string;
  label?: string;
  calibration: string;
  elapsedMs: number;
  usage: { inputTokens?: number; outputTokens?: number };
  routing?: SystemOneResponse["routing"];
  answers: Record<string, ScoredAnswer>;
  /** Present only when a threshold or topK was supplied. */
  decisions?: Decision[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateQuestions(raw: unknown): Record<string, Question> {
  if (!isRecord(raw)) {
    throw new SystemOneError("bad_request", "questions must be an object mapping ids to questions");
  }
  const ids = Object.keys(raw);
  if (ids.length === 0) {
    throw new SystemOneError("bad_request", "questions is empty; send at least one question");
  }

  const questions: Record<string, Question> = {};
  for (const id of ids) {
    const value = raw[id];
    if (!isRecord(value)) {
      throw new SystemOneError("bad_request", `question ${JSON.stringify(id)} is not an object`);
    }
    const type = value["type"];
    const instructions = value["instructions"];
    if (type !== "choice" && type !== "noul" && type !== "score") {
      throw new SystemOneError(
        "bad_request",
        `question ${JSON.stringify(id)} has type ${JSON.stringify(type)}; expected choice, noul, or score`
      );
    }
    if (typeof instructions !== "string" || instructions.trim().length === 0) {
      throw new SystemOneError(
        "bad_request",
        `question ${JSON.stringify(id)} needs non-empty instructions`
      );
    }

    if (type === "noul") {
      const criteria = value["criteria"];
      questions[id] = {
        type: "noul",
        instructions,
        ...(typeof criteria === "string" && criteria.length > 0 ? { criteria } : {}),
      };
      continue;
    }

    const criteria = value["criteria"];
    if (type === "choice") {
      if (!isRecord(criteria) || Object.keys(criteria).length === 0) {
        throw new SystemOneError(
          "bad_request",
          `choice question ${JSON.stringify(id)} needs a non-empty criteria object mapping option keys to descriptions`
        );
      }
      const options: Record<string, string | null> = {};
      for (const [key, description] of Object.entries(criteria)) {
        if (description !== null && typeof description !== "string") {
          throw new SystemOneError(
            "bad_request",
            `choice question ${JSON.stringify(id)} option ${JSON.stringify(key)} must be a string or null`
          );
        }
        options[key] = description;
      }
      questions[id] = { type: "choice", instructions, criteria: options };
      continue;
    }

    if (!Array.isArray(criteria) || criteria.length === 0) {
      throw new SystemOneError(
        "bad_request",
        `score question ${JSON.stringify(id)} needs a non-empty criteria array of rubric levels, lowest first`
      );
    }
    const levels = criteria.map((level, index) => {
      if (typeof level !== "string") {
        throw new SystemOneError(
          "bad_request",
          `score question ${JSON.stringify(id)} level ${index} must be a string`
        );
      }
      return level;
    });
    questions[id] = { type: "score", instructions, criteria: levels };
  }

  return questions;
}

function scoreAnswer(answer: Answer): ScoredAnswer {
  const scored: ScoredAnswer = {
    type: answer.type,
    value: answer.value,
    score: scoreOf(answer),
  };
  if (typeof answer.confidence === "number") scored.confidence = answer.confidence;
  if (typeof answer.actProbability === "number") scored.actProbability = answer.actProbability;
  if (answer.distribution) scored.distribution = answer.distribution;
  if (answer.legend) scored.legend = answer.legend;
  return scored;
}

export async function judge(
  input: JudgeInput,
  deps?: { chain?: BackendChain; signal?: AbortSignal }
): Promise<JudgeOutput> {
  const chain = deps?.chain ?? BackendChain.fromConfig(loadConfig());
  const questions = validateQuestions(input.questions);

  if (input.state === undefined || input.state === null) {
    throw new SystemOneError("bad_request", "state is required");
  }
  if (input.threshold !== undefined && input.topK !== undefined) {
    throw new SystemOneError("bad_request", "pass either threshold or topK, not both");
  }

  // A model selector resolves to a transport, so a caller names a model instead of a service. When
  // it names nothing this machine can enumerate, it is passed through to the chain's choice, because
  // a hosted provider may accept an id that enumerating would cost a request to discover.
  let backend: Backend;
  let checkpoint = input.model;
  if (input.backend) {
    backend = await chain.select(input.backend, deps?.signal);
  } else if (input.model) {
    const resolved = await resolveModel(chain, input.model, deps?.signal);
    if (resolved) {
      backend = resolved.backend;
      checkpoint = resolved.checkpoint || undefined;
    } else {
      backend = await chain.select(undefined, deps?.signal);
    }
  } else {
    backend = await chain.select(undefined, deps?.signal);
  }

  const wantsVerdict = input.threshold !== undefined || input.topK !== undefined;

  // Refuse a threshold against an uncalibrated backend before spending the call, not after. Doing it
  // afterwards costs a request that was never going to be usable, which on a hosted backend is money.
  if (input.threshold !== undefined && backend.calibration !== "absolute" && !input.allowUncalibrated) {
    throw new SystemOneError(
      "calibration",
      `backend ${JSON.stringify(backend.name)} declares ranking calibration, so a fixed threshold has no ` +
        `meaning on its scores. Use topK for a ranking decision, choose a calibrated model (Jev or Laya), ` +
        `or pass allowUncalibrated to threshold anyway.`,
      backend.name
    );
  }

  const response = await backend.decide(
    {
      state: input.state,
      questions,
      ...(checkpoint ? { model: checkpoint } : {}),
      ...(input.preset ? { preset: input.preset } : {}),
    },
    deps?.signal
  );

  const answers: Record<string, ScoredAnswer> = {};
  for (const [id, answer] of Object.entries(response.answers)) {
    answers[id] = scoreAnswer(answer);
  }

  const output: JudgeOutput = {
    backend: response.backend,
    calibration: backend.calibration,
    elapsedMs: response.elapsedMs,
    usage: response.usage,
    answers,
  };
  if (response.model) output.model = response.model;
  if (response.label) output.label = response.label;
  if (response.routing) output.routing = response.routing;

  if (wantsVerdict) {
    output.decisions = decide(response, {
      calibration: backend.calibration,
      ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
      ...(input.topK !== undefined ? { topK: input.topK } : {}),
      ...(input.minConfidence !== undefined ? { minConfidence: input.minConfidence } : {}),
      ...(input.allowUncalibrated ? { allowUncalibrated: true } : {}),
    });
  }

  return output;
}
