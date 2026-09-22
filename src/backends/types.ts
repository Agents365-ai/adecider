import type { BackendKind, Calibration, SystemOneRequest, SystemOneResponse } from "../types.ts";
import type { SystemOneErrorCode } from "../errors.ts";

export interface Health {
  ok: boolean;
  /** What the probe learned: device, loaded checkpoints, or the reason it failed. */
  detail: string;
  /**
   * Model ids this backend can answer with, as it reports them itself.
   *
   * Laya lists its resident checkpoints (`english`, `multilingual`), an OpenAI-compatible server
   * lists its served model ids, and Jev reports its default. Read at probe time rather than
   * hard-coded, so a backend that loads a different checkpoint is described correctly.
   */
  models?: string[];
}

export interface Backend {
  readonly name: string;
  readonly kind: BackendKind;
  readonly calibration: Calibration;
  readonly endpoint: string;
  /** True when using this backend sends data off this machine. */
  readonly cloud: boolean;
  /**
   * Input tokens this backend can read in one request.
   *
   * Load-bearing, not informational. A batched judgment over N candidates is one request, and an
   * over-long request is silently truncated rather than rejected: measured on 2026-09-21, a
   * nine-candidate routing request serialized to 4608 tokens against the Laya `english` checkpoint's
   * 512-token window, and the answers were computed on the surviving prefix. Callers must budget.
   */
  readonly contextTokens: number;
  /**
   * The window for a specific checkpoint, when the backend serves more than one.
   *
   * Laya's English checkpoint reads 512 tokens and its multilingual one 1024, so a budget computed
   * from the smaller number would waste half the window. Backends that do not vary may ignore the
   * argument.
   */
  contextTokensFor(model?: string): number;
  health(signal?: AbortSignal): Promise<Health>;
  decide(request: SystemOneRequest, signal?: AbortSignal): Promise<SystemOneResponse>;
}

export interface BackendSpec {
  name: string;
  kind: BackendKind;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  contextTokens?: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Map an HTTP status onto an error code, so a transient condition is not reported as the caller's
 * mistake.
 *
 * Measured need: TypeSafe answered 529 (overloaded) on a live call, and reporting that as
 * `bad_request` tells a caller its request was wrong when the request was fine. 429 and 5xx are
 * retryable, 401 and 403 mean a key problem, and only 400-class validation failures are the caller's.
 */
export function statusErrorCode(status: number): SystemOneErrorCode {
  if (status === 401 || status === 403) return "unconfigured";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429 || status === 503 || status === 529) return "busy";
  if (status >= 500) return "busy";
  return "bad_request";
}

/** True for a status worth one bounded retry. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 529 || status >= 500;
}

/** True for an error code worth one bounded retry. */
export function isRetryableCode(code: SystemOneErrorCode): boolean {
  return code === "busy" || code === "unreachable" || code === "timeout";
}

export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** Combine the caller's signal with a timeout so neither can be ignored. */
export function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
