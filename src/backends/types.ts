import type { BackendKind, Calibration, SystemOneRequest, SystemOneResponse } from "../types.ts";
import { SystemOneError } from "../errors.ts";
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
/**
 * Why a fetch failed, with the cause when Node reports one.
 *
 * `fetch` collapses every transport failure into "fetch failed" and puts the useful part on `cause`:
 * ECONNREFUSED for a closed port, UND_ERR_CONNECT_TIMEOUT for a connection that never established,
 * a certificate error for a broken chain. Measured 2026-09-24: a machine whose egress route dropped
 * Node's connection while curl and node's own https module both reached the same host appeared as a
 * bare "fetch failed" until the cause was read, which is the difference between a wrong URL and a
 * blocked route.
 */
export function describeFetchFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : undefined;
  if (code) return `${message} (${code})`;
  if (typeof cause?.message === "string" && cause.message !== message) return `${message} (${cause.message})`;
  return message;
}

/**
 * Check the endpoint a backend will call, once, when the backend is built.
 *
 * Hosts are deliberately not allowlisted: the endpoint is the operator's own declaration in their
 * config file, and pointing this tool at a server nobody here knows about is the point of the
 * openai backend. What is checked is that the string is an http(s) URL at all, so a typo like
 * `htp://` or an unusable scheme fails where it can be explained instead of surfacing later as an
 * opaque transport failure.
 */
export function assertHttpEndpoint(raw: string, backend: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SystemOneError(
      "unconfigured",
      `backend ${JSON.stringify(backend)} has an endpoint that is not a URL: ${JSON.stringify(raw)}`,
      backend
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SystemOneError(
      "unconfigured",
      `backend ${JSON.stringify(backend)} endpoint must be http or https, found ${JSON.stringify(url.protocol)}`,
      backend
    );
  }
}

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
