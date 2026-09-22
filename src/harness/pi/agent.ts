/**
 * A typed subagent: answer a subagent runner's judgment request without an LLM in the loop.
 *
 * pi-jev registers this as agent `jev`. Here it answers to `adecider`, and also to `jev` and
 * `typesafe-jev` when the backend is Jev, so an existing workflow script that names that agent keeps
 * working after the migration.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackendChain } from "../../backends/index.ts";
import { describeError } from "../../errors.ts";
import { judge } from "../../judge.ts";
import { RPC_REQUEST, RPC_REPLY_PREFIX } from "./rpc.ts";

const AGENT_NAMES = ["adecider", "jev", "typesafe-jev"];

interface RpcRequest {
  version?: number;
  requestId?: string;
  params?: Record<string, unknown>;
}

function field(params: Record<string, unknown>, key: string): unknown {
  const direct = params[key];
  if (direct !== undefined) return direct;
  const args = params["args"];
  return args && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
}

export class SubagentHandler {
  private pi: ExtensionAPI;
  private chain: () => BackendChain | null;

  constructor(pi: ExtensionAPI, chain: () => BackendChain | null) {
    this.pi = pi;
    this.chain = chain;
  }

  install(): void {
    this.pi.events.on(RPC_REQUEST, (request: unknown) => {
      const req = request as RpcRequest;
      if (!req || req.version !== 1) return;

      const params = req.params ?? {};
      const target = params["agent"] ?? params["agentType"];
      if (typeof target !== "string" || !AGENT_NAMES.includes(target)) return;
      if (typeof req.requestId !== "string") return;

      void this.answer(req.requestId, params);
    });
  }

  private async answer(requestId: string, params: Record<string, unknown>): Promise<void> {
    const replyEvent = `${RPC_REPLY_PREFIX}${requestId}`;
    const chain = this.chain();
    if (!chain) {
      this.pi.events.emit(replyEvent, {
        success: false,
        error: { message: "no backend configured for adecider" },
      });
      return;
    }

    const state = field(params, "state") ?? field(params, "task") ?? "No state provided";
    const questions = field(params, "questions");
    const type = field(params, "type");
    const instructions = field(params, "instructions");
    const criteria = field(params, "criteria");
    const model = field(params, "model");

    try {
      const ask: Record<string, unknown> =
        questions && typeof questions === "object" && Object.keys(questions as object).length > 0
          ? (questions as Record<string, unknown>)
          : {
              result: {
                type: typeof type === "string" ? type : "choice",
                instructions:
                  typeof instructions === "string"
                    ? instructions
                    : "What is the outcome of this task?",
                ...(criteria !== undefined ? { criteria } : {}),
              },
            };

      const output = await judge({
        state,
        questions: ask,
        ...(typeof model === "string" ? { model } : {}),
      });

      const first = Object.values(output.answers)[0];
      this.pi.events.emit(replyEvent, {
        success: true,
        data: {
          id: `adecider-${Date.now()}`,
          output: JSON.stringify(output, null, 2),
          result: {
            backend: output.backend,
            calibration: output.calibration,
            elapsedMs: output.elapsedMs,
            usage: output.usage,
            answers: output.answers,
            ...(first ? { primaryValue: first.value } : {}),
          },
        },
      });
    } catch (error) {
      this.pi.events.emit(replyEvent, { success: false, error: { message: describeError(error) } });
    }
  }
}
