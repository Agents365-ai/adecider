/**
 * Typed failures. Every path that cannot produce a verdict returns one of these instead of a
 * default answer, so a caller never mistakes an outage for a judgment.
 */

export type SystemOneErrorCode =
  | "unreachable" // transport failure
  | "unconfigured" // backend needs a key or an explicit opt-in that is not present
  | "bad_request" // caller-supplied request is invalid
  | "bad_response" // backend answered with a payload this layer cannot read
  | "timeout"
  | "busy" // backend is up but overloaded or rate limiting; retrying later may work
  | "calibration" // caller asked for a threshold the backend cannot honor
  | "unsupported";

export class SystemOneError extends Error {
  readonly code: SystemOneErrorCode;
  readonly backend: string | undefined;

  constructor(code: SystemOneErrorCode, message: string, backend?: string) {
    super(message);
    this.name = "SystemOneError";
    this.code = code;
    this.backend = backend;
  }
}

export function isSystemOneError(value: unknown): value is SystemOneError {
  return value instanceof SystemOneError;
}

/** Shape a failure for a tool result or a CLI stderr line. Never includes credential material. */
export function describeError(error: unknown): string {
  if (isSystemOneError(error)) {
    const where = error.backend ? ` (backend ${error.backend})` : "";
    return `${error.code}${where}: ${error.message}`;
  }
  return error instanceof Error ? `${error.message}` : String(error);
}
