/**
 * Decision rules over a normalized response.
 *
 * The two axes are kept separate on purpose. `value` is the answer, `score` is what a threshold
 * compares against, and `confidence` is an independent gate. For a noul question the score and the
 * value are the same probability. For choice and score questions the score is the peak of the
 * distribution, which is not the reported confidence: on a live Laya request the chosen option held
 * 0.8773 probability while confidence was 0.5846.
 */

import type { Answer, Calibration, QuestionType, SystemOneResponse } from "./types.ts";
import { SystemOneError } from "./errors.ts";

export interface Decision {
  id: string;
  type: QuestionType;
  value: string | number;
  /** The number a threshold compares against. */
  score: number;
  confidence?: number;
  actProbability?: number;
  passed: boolean;
  /** True when this decision came from a ranking backend forced to threshold anyway. */
  uncalibrated?: boolean;
}

export interface DecideOptions {
  /** Compare `score` against this. Ignored when topK is set. */
  threshold?: number;
  /** Second gate: reject a decision whose confidence is below this. Not applied when undefined. */
  minConfidence?: number;
  /** Ranking mode: take the top K by score instead of thresholding. */
  topK?: number;
  /** Calibration of the backend that produced the response. */
  calibration: Calibration;
  /** Permit thresholding a ranking backend, marking every decision uncalibrated. */
  allowUncalibrated?: boolean;
}

/**
 * The number a threshold compares against.
 *
 * For noul this is the probability itself, which is the calibrated quantity the model was trained
 * to produce. For choice and score it is the peak of the returned distribution, falling back to
 * confidence for a backend that returns no distribution.
 */
export function scoreOf(answer: Answer): number {
  if (answer.type === "noul") {
    return typeof answer.value === "number" ? answer.value : Number(answer.value);
  }
  if (answer.distribution) {
    const values = Object.values(answer.distribution);
    if (values.length > 0) return Math.max(...values);
  }
  if (typeof answer.confidence === "number") return answer.confidence;
  throw new SystemOneError(
    "bad_response",
    `answer ${JSON.stringify(answer.id)} has neither a distribution nor a confidence, so no score can be derived`
  );
}

export function decide(response: SystemOneResponse, options: DecideOptions): Decision[] {
  const ranking = typeof options.topK === "number";
  if (!ranking && typeof options.threshold !== "number") {
    throw new SystemOneError("bad_request", "decide needs either `threshold` or `topK`");
  }

  let uncalibrated = false;
  if (!ranking && options.calibration === "ranking") {
    if (!options.allowUncalibrated) {
      throw new SystemOneError(
        "calibration",
        `backend ${JSON.stringify(response.backend)} declares ranking calibration, so a fixed threshold has no ` +
          `meaning on its scores. Use topK for a ranking decision, choose a calibrated backend (Jev or Laya), ` +
          `or pass allowUncalibrated to threshold anyway and accept unmarked confidence as a probability.`,
        response.backend
      );
    }
    uncalibrated = true;
  }

  const decisions: Decision[] = Object.values(response.answers).map((answer) => {
    const score = scoreOf(answer);
    const decision: Decision = {
      id: answer.id,
      type: answer.type,
      value: answer.value,
      score,
      passed: false,
    };
    if (typeof answer.confidence === "number") decision.confidence = answer.confidence;
    if (typeof answer.actProbability === "number") decision.actProbability = answer.actProbability;
    if (uncalibrated) decision.uncalibrated = true;
    return decision;
  });

  if (ranking) {
    const topK = Math.max(1, options.topK as number);
    const ranked = [...decisions].sort((a, b) => b.score - a.score).slice(0, topK);
    const passedIds = new Set(ranked.map((d) => d.id));
    for (const decision of decisions) {
      decision.passed =
        passedIds.has(decision.id) && meetsConfidence(decision, options.minConfidence);
    }
    return decisions.sort((a, b) => b.score - a.score);
  }

  const threshold = options.threshold as number;
  for (const decision of decisions) {
    decision.passed = decision.score >= threshold && meetsConfidence(decision, options.minConfidence);
  }
  return decisions;
}

function meetsConfidence(decision: Decision, minConfidence: number | undefined): boolean {
  if (typeof minConfidence !== "number") return true;
  // A backend that reports no confidence cannot fail a confidence gate; the gate is documented as
  // applying only where the number exists.
  if (typeof decision.confidence !== "number") return true;
  return decision.confidence >= minConfidence;
}

/** Convenience for single-question callers: the one decision, or an error naming what is missing. */
export function soleDecision(decisions: Decision[], id: string): Decision {
  const found = decisions.find((d) => d.id === id);
  if (!found) {
    throw new SystemOneError(
      "bad_request",
      `no answer for question ${JSON.stringify(id)}; answered ids were ${decisions.map((d) => d.id).join(", ")}`
    );
  }
  return found;
}
