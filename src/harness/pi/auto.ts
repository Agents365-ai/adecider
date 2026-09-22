/**
 * Automatic mode: on every prompt, route tools and suggest skills before the agent starts.
 *
 * Off by default, exactly as in pi-jev, because this is the one feature that spends a backend
 * request on every single prompt whether or not it changes anything. When a backend is local that
 * cost is milliseconds; when it is a cloud model it is a bill.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BackendChain } from "../../backends/index.ts";
import { findSkills, type SkillMatch } from "./skills.ts";
import { routeTools } from "./router.ts";
import { PI_TOOL_NAMES } from "./tools.ts";

export type AutoSkipReason = "disabled" | "busy" | "empty-prompt" | "no-backend";

export interface AutoOutcome {
  ran: boolean;
  reason?: AutoSkipReason;
  activated: string[];
  activatedBy?: string;
  skills: SkillMatch[];
  ranked: boolean;
  elapsedMs: number;
}

export class AutoRouter {
  enabled: boolean;
  private running = false;

  private chain: () => BackendChain | null;

  constructor(chain: () => BackendChain | null, enabled = false) {
    this.chain = chain;
    this.enabled = enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Never throws: automatic routing must not be able to break an agent turn. */
  async run(
    prompt: string,
    _ctx: ExtensionContext,
    signal?: AbortSignal,
    pi?: Parameters<typeof routeTools>[0]
  ): Promise<AutoOutcome> {
    const started = Date.now();
    const stop = (reason: AutoSkipReason): AutoOutcome => ({
      ran: false,
      reason,
      activated: [],
      skills: [],
      ranked: false,
      elapsedMs: Date.now() - started,
    });

    if (!this.enabled) return stop("disabled");
    if (this.running) return stop("busy");
    if (!prompt.trim() || prompt.trim().startsWith("/")) return stop("empty-prompt");
    if (!pi) return stop("no-backend");

    const chain = this.chain();
    if (!chain) return stop("no-backend");

    this.running = true;
    try {
      const [tools, skills] = await Promise.all([
        routeTools(pi, chain, prompt, { exclude: PI_TOOL_NAMES, signal }),
        findSkills(pi, chain, prompt, { ...(signal ? { signal } : {}) }),
      ]);

      return {
        ran: true,
        activated: tools.activated,
        ...(tools.backend ? { activatedBy: tools.backend } : {}),
        skills: skills.recommended,
        ranked: tools.ranked || skills.ranked,
        elapsedMs: Date.now() - started,
      };
    } catch {
      return stop("no-backend");
    } finally {
      this.running = false;
    }
  }
}
