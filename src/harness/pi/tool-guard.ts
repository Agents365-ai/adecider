/**
 * Tool call guard: judge a call before it runs, and label a failure after it happens.
 *
 * This is pi-jev's feature ported onto a pluggable backend, with one behavioural change that the
 * calibration rule forces. pi-jev blocked a call whenever its single backend reported 0.85 or more.
 * That is only sound for a backend whose numbers were trained to mean something, so here:
 *
 * - a calibrated backend blocks as before;
 * - an uncalibrated backend never blocks, because a self-reported number is not grounds for
 *   stopping correct work. It reports that it declined instead of failing silently.
 *
 * The cost is one backend request per tool call, so this stays off by default.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BackendChain } from "../../backends/index.ts";
import { judge } from "../../judge.ts";
import { isAdapterTool } from "./tools.ts";
import { scoreNoul, verdictFrom } from "./decisions.ts";

/** pi-jev's blocking cutoff, kept so a migration does not change when a call is stopped. */
export const GUARD_THRESHOLD = 0.85;

export interface GuardCheck {
  blocked: boolean;
  probability: number;
  reason?: string;
  uncalibrated: boolean;
  elapsedMs: number;
}

export class ToolGuard {
  enabled: boolean;
  /** Set once, so a declined block is reported once instead of on every call. */
  private reportedUncalibrated = false;

  private pi: ExtensionAPI;
  private chain: () => BackendChain | null;

  constructor(pi: ExtensionAPI, chain: () => BackendChain | null, enabled = false) {
    this.pi = pi;
    this.chain = chain;
    this.enabled = enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.reportedUncalibrated = false;
  }

  install(): void {
    this.pi.on("tool_call", async (event, ctx) => {
      if (!this.enabled) return;
      if (isAdapterTool(event.toolName)) return;

      const check = await this.check(event.toolName, event.input, ctx);
      if (!check) return;

      if (check.uncalibrated && !this.reportedUncalibrated) {
        this.reportedUncalibrated = true;
        ctx.ui.setStatus("adecider", `adecider: guard cannot block (${check.probability.toFixed(2)}, uncalibrated backend)`);
      }
      if (!check.blocked) return;

      ctx.ui.setStatus("adecider", `adecider: blocked ${event.toolName}`);
      return {
        block: true,
        reason:
          `Blocked by the adecider tool guard: the arguments look fabricated (P=${check.probability.toFixed(2)}). ` +
          `Verify the actual environment before retrying.`,
      };
    });

    this.pi.on("tool_result", async (event, ctx) => {
      if (!this.enabled) return;
      if (isAdapterTool(event.toolName)) return;
      if (!event.isError) return;

      const guidance = await this.explainFailure(event.toolName, event.input, event.content, ctx);
      if (!guidance) return;
      return {
        content: [
          ...event.content,
          { type: "text" as const, text: `\n[adecider guidance]: ${guidance}` },
        ],
      };
    });
  }

  private getChain(): BackendChain | null {
    return this.chain();
  }

  async check(
    toolName: string,
    input: unknown,
    _ctx?: ExtensionContext,
    signal?: AbortSignal
  ): Promise<GuardCheck | null> {
    if (!this.enabled || isAdapterTool(toolName)) return null;
    const chain = this.getChain();
    if (!chain) return null;

    try {
      const result = await scoreNoul(
        chain,
        {
          state: { tool: toolName, parameters: input },
          questions: {
            is_hallucinated: {
              instructions: `Does this tool call to '${toolName}' contain hallucinated, fabricated, or nonsensical parameters or paths?`,
            },
          },
        },
        signal
      );
      const verdict = verdictFrom(result.scores, "is_hallucinated", result, GUARD_THRESHOLD);
      const check: GuardCheck = {
        blocked: verdict.blocked,
        probability: verdict.probability,
        uncalibrated: verdict.uncalibrated,
        elapsedMs: verdict.elapsedMs,
      };
      if (verdict.blocked) {
        check.reason = `P=${verdict.probability.toFixed(2)} from ${verdict.backend}`;
      }
      return check;
    } catch {
      // Fail open on an outage: the guard protects against fabricated arguments, and refusing to
      // run every tool because a local service is down is a worse failure than the one it prevents.
      return null;
    }
  }

  /** Classify why a tool failed and, for a fabricated path, say so before the model retries. */
  async explainFailure(
    toolName: string,
    input: unknown,
    content: unknown[],
    _ctx?: ExtensionContext,
    signal?: AbortSignal
  ): Promise<string | null> {
    if (!this.enabled) return null;
    const chain = this.getChain();
    if (!chain) return null;

    try {
      const output = await judge(
        {
          state: { tool: toolName, input, error: JSON.stringify(content).slice(0, 4000) },
          questions: {
            error_category: {
              type: "choice",
              instructions: "What is the primary root cause of this tool execution failure?",
              criteria: {
                missing_file: "File or directory path does not exist, which suggests a hallucinated path",
                syntax_flag: "Invalid command syntax, unknown flags, or a malformed parameter",
                permission_env: "Permission denied, or a missing environment dependency",
                runtime_other: "An expected runtime or test failure",
              },
            },
          },
        },
        { chain, signal }
      );

      const cause = output.answers["error_category"]?.value;
      if (cause === "missing_file") {
        return "Path not found. Check the actual workspace with ls or find before guessing paths again.";
      }
      if (cause === "syntax_flag") {
        return "Invalid syntax or flag. Check the command specification before retrying.";
      }
      return null;
    } catch {
      return null;
    }
  }
}
