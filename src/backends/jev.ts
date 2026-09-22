/**
 * Jev (TypeSafe) over HTTPS.
 *
 * The API is one endpoint, and its response family is the same one Laya speaks, so normalization is
 * shared. `POST https://api.typesafe.ai/v1/systemone` with a bearer key. Requests are billed, and
 * unlike the local backends the payload leaves this machine, so this backend is opt-in.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SystemOneRequest, SystemOneResponse } from "../types.ts";
import { SystemOneError } from "../errors.ts";
import { normalizeFamilyResponse } from "../normalize.ts";
import {
  DEFAULT_TIMEOUT_MS,
  isRetryableStatus,
  requestSignal,
  statusErrorCode,
  type Backend,
  type BackendSpec,
  type Health,
} from "./types.ts";

export const DEFAULT_JEV_MODEL = "jev-latest";
const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1/systemone";

export function resolveJevApiKey(explicit?: string): { key: string; origin: string } | null {
  const fromSpec = explicit?.trim();
  if (fromSpec) return { key: fromSpec, origin: "configured" };

  const fromEnv = process.env["TYPESAFE_API_KEY"]?.trim();
  if (fromEnv) return { key: fromEnv, origin: "$TYPESAFE_API_KEY" };

  const secretPath = path.join(os.homedir(), ".pi", "agent", "secrets", "typesafe_api_key");
  try {
    const content = fs.readFileSync(secretPath, "utf8").trim();
    if (content) return { key: content, origin: "~/.pi/agent/secrets/typesafe_api_key" };
  } catch {
    // No secret file: fall through to unconfigured.
  }
  return null;
}

export function createJevBackend(spec: BackendSpec): Backend {
  const name = spec.name;
  const url = spec.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function send(
    target: string,
    key: string,
    payload: unknown,
    timeout: number,
    abort?: AbortSignal
  ): Promise<Response> {
    return fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: requestSignal(abort, timeout),
    });
  }

  return {
    name,
    kind: "jev",
    calibration: "absolute",
    endpoint: url,
    cloud: true,
    // Measured: a three-question request used 391 input tokens and answered correctly. Jev's published
    // limit is not stated, so this is a conservative floor rather than a claim about the maximum.
    contextTokens: spec.contextTokens ?? 8192,

    contextTokensFor(): number {
      return spec.contextTokens ?? 8192;
    },

    async health(): Promise<Health> {
      const resolved = resolveJevApiKey(spec.apiKey);
      if (!resolved) {
        return {
          ok: false,
          detail:
            "no API key; set TYPESAFE_API_KEY or write ~/.pi/agent/secrets/typesafe_api_key",
        };
      }
      // A live probe would spend a billed request on every status call, so health here reports
      // configuration only. A rejected key surfaces on the first real call as bad_request.
      const configured = process.env["TYPESAFE_DEFAULT_MODEL"]?.trim();
      return {
        ok: true,
        detail: `key from ${resolved.origin}; cloud, billed per request`,
        models: [configured || spec.model || DEFAULT_JEV_MODEL],
      };
    },

    async decide(request: SystemOneRequest, signal?: AbortSignal): Promise<SystemOneResponse> {
      const resolved = resolveJevApiKey(spec.apiKey);
      if (!resolved) {
        throw new SystemOneError(
          "unconfigured",
          "no TypeSafe API key; set TYPESAFE_API_KEY, write ~/.pi/agent/secrets/typesafe_api_key, " +
            "or add an apiKey for this backend in ~/.pi/agent/adecider.json",
          name
        );
      }

      const body = {
        state: request.state,
        model: request.model ?? spec.model ?? DEFAULT_JEV_MODEL,
        questions: request.questions,
      };

      const started = performance.now();
      let response: Response;
      try {
        response = await send(url, resolved.key, body, timeoutMs, signal);
        // A hosted API rate limits and sheds load. One bounded retry turns a transient 529 into a
        // slightly slower success instead of a failure the caller has to interpret.
        if (isRetryableStatus(response.status)) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          response = await send(url, resolved.key, body, timeoutMs, signal);
        }
      } catch (error) {
        throw new SystemOneError(
          error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable",
          `${name} call failed: ${error instanceof Error ? error.message : String(error)}`,
          name
        );
      }
      const elapsedMs = performance.now() - started;

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new SystemOneError("bad_response", `${name} returned a non-JSON body`, name);
      }
      if (!response.ok) {
        // Never echo the request headers; the key lives there.
        const detail =
          payload && typeof payload === "object" && "error" in payload
            ? JSON.stringify((payload as { error: unknown }).error).slice(0, 400)
            : `HTTP ${response.status} ${response.statusText}`;
        const code = statusErrorCode(response.status);
        throw new SystemOneError(
          code,
          `${name} returned HTTP ${response.status} (${code}): ${detail}` +
            (code === "busy" ? "; this is transient, retry shortly" : ""),
          name
        );
      }

      return normalizeFamilyResponse(name, payload, Math.round(elapsedMs * 10) / 10);
    },
  };
}
