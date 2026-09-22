/**
 * One HTTP endpoint over every model.
 *
 * This is the "unified format" half of the design: a caller sends `{model, state, questions}` and
 * does not care whether the answer comes from a local MLX checkpoint, a PyTorch reference service on
 * another port, or a hosted API reached with a key. The request shape, the response shape, and the
 * error codes are identical across all of them, and `model` selects which one answers.
 *
 * The route and payload names follow the Laya services already running on this machine
 * (`GET /health`, `POST /decide`, `POST /route`), so this endpoint is a drop-in replacement for a
 * single-model service rather than a fourth dialect.
 *
 * Binds to loopback by default. Nothing here authenticates, so binding beyond loopback is the
 * operator's decision and is reported as such on startup.
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { describeError, isSystemOneError } from "../errors.ts";
import { BackendChain } from "../backends/index.ts";
import { loadConfig } from "../config.ts";
import { judge, type JudgeInput } from "../judge.ts";
import { modelCatalogue, resolveModel } from "../models.ts";

export const SERVICE = "adecider/0.1.0";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("request body must be a JSON object");
  return parsed;
}

/** Build the judge input from a request body, ignoring unknown fields rather than failing on them. */
function toJudgeInput(body: Record<string, unknown>): JudgeInput {
  const input: JudgeInput = {
    state: body["state"],
    questions: isRecord(body["questions"]) ? body["questions"] : {},
  };
  if (typeof body["model"] === "string") input.model = body["model"];
  if (typeof body["backend"] === "string") input.backend = body["backend"];
  if (typeof body["preset"] === "string") input.preset = body["preset"];
  if (typeof body["threshold"] === "number") input.threshold = body["threshold"];
  if (typeof body["top_k"] === "number") input.topK = body["top_k"];
  if (typeof body["min_confidence"] === "number") input.minConfidence = body["min_confidence"];
  if (body["allow_uncalibrated"] === true) input.allowUncalibrated = true;
  return input;
}

export interface ServeOptions {
  host?: string;
  port?: number;
  /** Print each request, for observing another agent's traffic. */
  verbose?: boolean;
  /** Injected chain, so a test can serve a fake backend instead of the configured one. */
  chain?: BackendChain;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

export async function serve(options: ServeOptions = {}): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8319;
  const chain = options.chain ?? BackendChain.fromConfig(loadConfig());

  const server = http.createServer((request, response) => {
    void (async () => {
      const path = (request.url ?? "").split("?")[0] ?? "";
      const send = (status: number, payload: unknown): void => {
        const body = JSON.stringify(payload, null, 2);
        response.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(body),
        });
        response.end(body);
        if (options.verbose) process.stderr.write(`[adecider] ${request.method} ${path} -> ${status}\n`);
      };

      try {
        if (request.method === "GET" && path === "/health") {
          const probed = await chain.healthAll();
          send(200, {
            status: "ok",
            service: SERVICE,
            automatic_chain: chain.names(),
            skipped: chain.skipped,
            backends: probed.map(({ backend, inChain, health }) => ({
              name: backend.name,
              kind: backend.kind,
              calibration: backend.calibration,
              cloud: backend.cloud,
              automatic: inChain,
              ok: health.ok,
              detail: health.detail,
              models: health.models ?? [],
            })),
          });
          return;
        }

        if (request.method === "GET" && path === "/models") {
          send(200, { models: await modelCatalogue(chain) });
          return;
        }

        if (request.method === "POST" && path === "/route") {
          // Which model would answer, without spending a request on an answer.
          const body = await readBody(request);
          const selector = typeof body["model"] === "string" ? body["model"] : undefined;
          const resolved = selector ? await resolveModel(chain, selector) : null;
          const backend = resolved?.backend ?? (await chain.select(undefined));
          // A qualified selector skips the catalogue, so its name is the selector itself rather than
          // a catalogue id.
          const modelId = resolved
            ? resolved.entry?.id ?? (resolved.checkpoint ? `${backend.name}:${resolved.checkpoint}` : backend.name)
            : backend.name;
          send(200, {
            model: modelId,
            backend: backend.name,
            checkpoint: resolved?.checkpoint ?? null,
            kind: backend.kind,
            calibration: backend.calibration,
            cloud: backend.cloud,
            automatic: chain.inChain(backend.name),
            context_tokens: backend.contextTokensFor(resolved?.checkpoint),
          });
          return;
        }

        if (request.method === "POST" && path === "/decide") {
          const body = await readBody(request);
          const output = await judge(toJudgeInput(body), { chain });
          send(200, output);
          return;
        }

        send(404, {
          error: `unknown route ${request.method} ${path}`,
          routes: ["GET /health", "GET /models", "POST /route", "POST /decide"],
        });
      } catch (error) {
        const code = isSystemOneError(error) ? error.code : "bad_request";
        const status =
          code === "bad_request" || code === "calibration" ? 400 : code === "unconfigured" ? 401 : code === "busy" ? 503 : 502;
        send(status, { error: describeError(error), code });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://${host}:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}
