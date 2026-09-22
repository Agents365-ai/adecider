/**
 * Laya over HTTP.
 *
 * Both local deployments speak the same dialect: `GET /health`, `POST /decide`, `POST /route`.
 * `laya-mlx` (MLX, launchd) runs on 8317 and the PyTorch/MPS reference service on 8318, with
 * identical payloads. The server holds a global lock because the accelerator is shared, so
 * concurrent calls queue instead of failing; the measured `elapsed_ms` therefore includes queueing.
 */

import type { SystemOneRequest, SystemOneResponse } from "../types.ts";
import { SystemOneError } from "../errors.ts";
import { normalizeFamilyResponse } from "../normalize.ts";
import {
  DEFAULT_TIMEOUT_MS,
  requestSignal,
  statusErrorCode,
  type Backend,
  type BackendSpec,
  type Health,
} from "./types.ts";

interface LayaPayload {
  state?: unknown;
  questions?: unknown;
  model?: string;
  preset?: string;
}

export function createLayaBackend(spec: BackendSpec): Backend {
  const name = spec.name;
  const baseUrl = (spec.baseUrl ?? "http://127.0.0.1:8317").replace(/\/+$/, "");
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name,
    kind: "laya",
    // Trained against a strictly proper scoring rule, so reported probabilities are usable as
    // thresholds.
    calibration: "absolute",
    endpoint: `${baseUrl}/decide`,
    cloud: false,
    // The English checkpoint reads 512 tokens and the multilingual one 1024. An over-long request is
    // truncated by the server, not rejected, so the smaller default is the safe assumption.
    contextTokens: spec.contextTokens ?? (spec.model === "multilingual" ? 1024 : 512),

    contextTokensFor(model?: string): number {
      if (spec.contextTokens) return spec.contextTokens;
      return model === "multilingual" ? 1024 : 512;
    },

    async health(signal?: AbortSignal): Promise<Health> {
      const url = `${baseUrl}/health`;
      try {
        const response = await fetch(url, { signal: requestSignal(signal, 5_000) });
        const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
        if (!response.ok) {
          return { ok: false, detail: `HTTP ${response.status} from ${url}` };
        }
        if (!payload || payload["status"] !== "ok") {
          return { ok: false, detail: `unexpected health payload from ${url}` };
        }
        const runtime = typeof payload["runtime"] === "string" ? payload["runtime"] : "laya";
        const device = typeof payload["device"] === "string" ? payload["device"] : "unknown device";
        const loaded = Array.isArray(payload["loaded"]) ? payload["loaded"].join(", ") : "none";
        const checkpoints = Array.isArray(payload["checkpoints"])
          ? payload["checkpoints"].filter((name): name is string => typeof name === "string")
          : [];
        return {
          ok: true,
          detail: `${runtime} on ${device}; loaded ${loaded}`,
          models: checkpoints.length > 0 ? checkpoints : ["english"],
        };
      } catch (error) {
        return {
          ok: false,
          detail: `not reachable at ${url} (${error instanceof Error ? error.message : String(error)})`,
        };
      }
    },

    async decide(request: SystemOneRequest, signal?: AbortSignal): Promise<SystemOneResponse> {
      const payload: LayaPayload = { state: request.state, questions: request.questions };
      if (request.model) payload.model = request.model;
      if (request.preset) payload.preset = request.preset;

      const started = performance.now();
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/decide`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: requestSignal(signal, timeoutMs),
        });
      } catch (error) {
        throw new SystemOneError(
          error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable",
          `${name} call failed: ${error instanceof Error ? error.message : String(error)}`,
          name
        );
      }
      const elapsedMs = performance.now() - started;

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new SystemOneError("bad_response", `${name} returned a non-JSON body`, name);
      }
      if (!response.ok) {
        const detail = body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${response.status}`;
        throw new SystemOneError(statusErrorCode(response.status), `${name} rejected the request: ${detail}`, name);
      }

      return normalizeFamilyResponse(name, body, Math.round(elapsedMs * 10) / 10);
    },
  };
}
