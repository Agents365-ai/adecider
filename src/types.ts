/**
 * Public types for the adecider layer.
 *
 * The request shape follows the System One convention shared by Jev and Laya: send state plus a
 * map of typed questions under stable ids, receive one answer per id. Both backends use the same
 * three primitives, so this layer needs no per-backend request dialect.
 */

export type QuestionType = "choice" | "noul" | "score";

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: string;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export interface SystemOneRequest {
  state: unknown;
  questions: Record<string, Question>;
  /** Backend name from the configured chain. Overrides selection. */
  backend?: string;
  /** Checkpoint or model id: english, multilingual, jev-latest, a local model name. */
  model?: string;
  /** Backend-native preset bundle, currently only Laya ships presets. */
  preset?: string;
  timeoutMs?: number;
}

/**
 * One answer. `value` is the answer itself. `confidence` is a separate axis: both backends derive
 * it from how the distribution is spread, so it is not the answer probability and it is not
 * comparable to `value` for a noul question.
 */
export interface Answer {
  id: string;
  type: QuestionType;
  value: string | number;
  confidence?: number;
  /** Act/abstain head. Present on Laya, absent on Jev. */
  actProbability?: number;
  /** Full distribution over choice options or score levels, when the backend returns one. */
  distribution?: Record<string, number>;
  /** Score level labels keyed by level index. */
  legend?: Record<string, string>;
  raw?: unknown;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface RoutingInfo {
  checkpoint?: string;
  reason?: string;
  language?: string;
  script?: string;
}

export interface SystemOneResponse {
  answers: Record<string, Answer>;
  /** Backend that answered, e.g. laya-mlx. */
  backend: string;
  /** Checkpoint that answered the request: english, multilingual, jev-latest. */
  model?: string;
  /** The backend's own model label, e.g. jev-1.13.0 or laya-rl-agent. */
  label?: string;
  routing?: RoutingInfo;
  usage: Usage;
  elapsedMs: number;
}

/**
 * How a backend's numbers may be used.
 *
 * absolute: probabilities come from training against a strictly proper scoring rule, so a fixed
 * threshold is meaningful. ranking: the score is a self-report, so only the ordering of candidates
 * carries information.
 */
export type Calibration = "absolute" | "ranking";

export type BackendKind = "laya" | "jev" | "openai";
