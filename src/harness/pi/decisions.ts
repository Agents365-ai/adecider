/**
 * Backend calls made by the pi adapter, and the rule that turns their scores into a selection.
 *
 * Every adapter feature that pi-jev drove from a threshold needs one rule, and the rule depends on
 * what the answering backend's numbers are worth. This is the one place that decision is made, so
 * the calibration discipline cannot drift feature by feature.
 */

import type { Calibration } from "../../types.ts";
import { SystemOneError } from "../../errors.ts";
import type { BackendChain } from "../../backends/index.ts";
import { judge } from "../../judge.ts";

export interface ScoreRequest {
  state: unknown;
  /** Candidate id to the yes/no question asked about it. */
  questions: Record<string, { instructions: string }>;
}

export interface ScoreResult {
  scores: Record<string, number>;
  backend: string;
  calibration: Calibration;
  elapsedMs: number;
}

/** Ask one yes/no question per candidate, in a single backend call. */
export async function scoreNoul(
  chain: BackendChain,
  request: ScoreRequest,
  signal?: AbortSignal,
  backend?: string
): Promise<ScoreResult> {
  const questions: Record<string, { type: "noul"; instructions: string }> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    questions[id] = { type: "noul", instructions: question.instructions };
  }

  const output = await judge(
    { state: request.state, questions, ...(backend ? { backend } : {}) },
    { chain, signal }
  );

  const scores: Record<string, number> = {};
  for (const [id, answer] of Object.entries(output.answers)) {
    scores[id] = answer.score;
  }

  return {
    scores,
    backend: output.backend,
    calibration: output.calibration as Calibration,
    elapsedMs: output.elapsedMs,
  };
}

export interface Selection {
  selected: string[];
  /** True when the selection came from ranking rather than a threshold. */
  ranked: boolean;
  backend: string;
  elapsedMs: number;
}

export interface SelectionRule {
  /** Applies to calibrated backends: a candidate is selected when its score clears this. */
  threshold: number;
  /** Applies to uncalibrated backends: take this many highest-scoring candidates instead. */
  maxSelections: number;
}

/**
 * Apply a feature's rule to a set of scores.
 *
 * A calibrated backend is thresholded: the probability means something, so the cutoff does too. An
 * uncalibrated backend is ranked instead, because its self-reported numbers cluster near the top and
 * a threshold would select nearly everything. Both cases are bounded by `maxSelections`, so a
 * permissive backend cannot flood the active tool set.
 */
export function selectCandidates(scores: Record<string, number>, result: ScoreResult, rule: SelectionRule): Selection {
  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);

  if (result.calibration === "absolute") {
    return {
      selected: entries
        .filter(([, score]) => score >= rule.threshold)
        .slice(0, rule.maxSelections)
        .map(([id]) => id),
      ranked: false,
      backend: result.backend,
      elapsedMs: result.elapsedMs,
    };
  }

  return {
    selected: entries.slice(0, rule.maxSelections).map(([id]) => id),
    ranked: true,
    backend: result.backend,
    elapsedMs: result.elapsedMs,
  };
}

/**
 * A calibrated yes/no verdict, for features that block or keep rather than select.
 *
 * An uncalibrated backend cannot ground a blocking decision: the number it reports is a self-report,
 * so acting on it risks blocking correct work on the strength of a number that was never trained to
 * mean anything. Callers get `uncalibrated: true` and decide for themselves whether that is
 * acceptable; the guard refuses and the compactor defers to pi.
 */
export interface Verdict {
  probability: number;
  blocked: boolean;
  uncalibrated: boolean;
  backend: string;
  elapsedMs: number;
}

export function verdictFrom(
  scores: Record<string, number>,
  id: string,
  result: ScoreResult,
  threshold: number
): Verdict {
  const probability = scores[id];
  if (typeof probability !== "number") {
    throw new SystemOneError("bad_response", `backend ${result.backend} did not answer ${JSON.stringify(id)}`);
  }
  const uncalibrated = result.calibration !== "absolute";
  return {
    probability,
    blocked: !uncalibrated && probability >= threshold,
    uncalibrated,
    backend: result.backend,
    elapsedMs: result.elapsedMs,
  };
}
