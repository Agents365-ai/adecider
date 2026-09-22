/**
 * The `/adecider` command.
 *
 * Mirrors pi-jev's `/jev` surface one subcommand at a time, minus the two that no longer mean
 * anything here: there is no single API key to enable, and tools are always registered, so `/adecider
 * enable` and `/adecider disable` toggle the automatic features instead of the tool set.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describeError } from "../../errors.ts";
import type { BackendChain } from "../../backends/index.ts";
import { judge } from "../../judge.ts";
import type { AutoRouter } from "./auto.ts";
import type { AutoModelRouter } from "./model-router.ts";
import type { Compactor } from "./compact.ts";
import type { Orchestrator } from "./orchestrator.ts";
import type { ToolGuard } from "./tool-guard.ts";
import { designEvaluation } from "./designer.ts";
import { findSkills } from "./skills.ts";

const USAGE = [
  "Available subcommands:",
  "  /adecider status                 backends, health, calibration, and which features are on",
  "  /adecider skills [query]         suggest skills for a query",
  "  /adecider test [prompt]          let this session's model design a question set, then evaluate it",
  "  /adecider agents <task>          dispatch an orchestration workflow",
  "  /adecider auto [on|off]          route tools and skills on every prompt",
  "  /adecider auto-model [on|off]    pick a model per prompt (local heuristics, no backend request)",
  "  /adecider tool-guard [on|off]    judge tool calls before and after execution",
  "  /adecider compact [on|off]       let a decision model choose what survives compaction",
  "  /adecider enable | disable       turn every automatic feature on or off",
].join("\n");

export interface CommandDeps {
  chain: () => BackendChain | null;
  auto: AutoRouter;
  autoModel: AutoModelRouter;
  compactor: Compactor;
  agents: Orchestrator;
  guard: ToolGuard;
}

function parseToggle(rest: string, current: boolean): { value?: boolean; error?: string } {
  if (rest === "on") return { value: true };
  if (rest === "off") return { value: false };
  if (rest === "") return { value: !current };
  return { error: `expected on or off, got ${JSON.stringify(rest)}` };
}

export function registerAdapterCommand(pi: ExtensionAPI, deps: CommandDeps): void {
  pi.registerCommand("adecider", {
    description: "System One decisions: status, skills, evaluation design, orchestration, and feature toggles",
    async handler(rest: string, ctx: ExtensionCommandContext) {
      const trimmed = rest.trim();
      const [sub = "", ...tail] = trimmed.split(/\s+/);
      const argument = tail.join(" ");

      if (sub === "help" || sub === "?") {
        ctx.ui.notify(USAGE, "info");
        return;
      }

      if (sub === "" || sub === "status") {
        const chain = deps.chain();
        const lines: string[] = [];
        if (!chain) {
          lines.push("No backend is reachable. Check ~/.pi/agent/adecider.json and run `adecider status`.");
        } else {
          for (const { backend, health } of await chain.healthAll(ctx.signal)) {
            lines.push(
              `${health.ok ? "ok  " : "down"}  ${backend.name} (${backend.kind}, ${backend.calibration}, ` +
                `${backend.cloud ? "cloud" : "local"}) ${health.detail}`
            );
          }
          for (const skip of chain.skipped) lines.push(`skip  ${skip.name}: ${skip.reason}`);
        }
        lines.push(
          "",
          `auto: ${deps.auto.enabled ? "on" : "off"}   auto-model: ${deps.autoModel.enabled ? "on" : "off"}   ` +
            `tool-guard: ${deps.guard.enabled ? "on" : "off"}   compact: ${deps.compactor.enabled ? "on" : "off"}   ` +
            `agents: ${deps.agents.enabled ? "on" : "off"}`
        );
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "skills") {
        if (!argument) {
          ctx.ui.notify("usage: /adecider skills <query>", "warning");
          return;
        }
        const chain = deps.chain();
        if (!chain) {
          ctx.ui.notify("No backend is reachable.", "error");
          return;
        }
        const outcome = await findSkills(pi, chain, argument, { ctx, signal: ctx.signal });
        if (outcome.recommended.length === 0) {
          ctx.ui.notify(
            outcome.skipped === "no-skills"
              ? "No skills are loaded in this session."
              : `No skill matched among ${outcome.candidates.length} candidate(s).`,
            "info"
          );
          return;
        }
        ctx.ui.notify(
          outcome.recommended
            .map((skill) => `/skill:${skill.id} (P=${skill.probability.toFixed(2)})`)
            .join("\n"),
          "info"
        );
        return;
      }

      if (sub === "test" || sub === "eval" || sub === "evaluate") {
        const chain = deps.chain();
        if (!chain) {
          ctx.ui.notify("No backend is reachable.", "error");
          return;
        }
        try {
          if (!argument) {
            const designed: Record<string, unknown> = {
              urgency: { type: "noul", instructions: "Does this state express urgency?" },
              sentiment: {
                type: "choice",
                instructions: "What is the overall tone?",
                criteria: { positive: "favorable", neutral: "factual", negative: "unfavorable" },
              },
            };
            const output = await judge(
              { state: "Smoke test: this state exists to prove the backend answers at all.", questions: designed },
              { chain, signal: ctx.signal }
            );
            ctx.ui.notify(JSON.stringify(output, null, 2), "info");
            return;
          }
          const designed = await designEvaluation(ctx, argument, ctx.signal);
          ctx.ui.notify(`Designed by ${ctx.model?.id ?? "the session model"}: ${Object.keys(designed.questions).join(", ")}`, "info");
          const output = await judge(
            { state: designed.state, questions: designed.questions },
            { chain, signal: ctx.signal }
          );
          ctx.ui.notify(JSON.stringify(output, null, 2), "info");
        } catch (error) {
          ctx.ui.notify(`Evaluation failed: ${describeError(error)}`, "error");
        }
        return;
      }

      if (sub === "agents" || sub === "orchestrate") {
        if (!argument) {
          ctx.ui.notify("usage: /adecider agents <task>", "warning");
          return;
        }
        const result = await deps.agents.dispatch(argument, ctx);
        if (!result.accepted) {
          ctx.ui.notify(`Orchestration not started: ${result.error}`, "error");
        }
        return;
      }

      const toggles: Array<{ names: string[]; label: string; get: () => boolean; set: (value: boolean) => void }> = [
        { names: ["auto"], label: "Automatic routing", get: () => deps.auto.enabled, set: (v) => deps.auto.setEnabled(v) },
        { names: ["auto-model", "automodel"], label: "Automatic model selection", get: () => deps.autoModel.enabled, set: (v) => deps.autoModel.setEnabled(v) },
        { names: ["tool-guard", "toolguard", "guard"], label: "Tool guard", get: () => deps.guard.enabled, set: (v) => deps.guard.setEnabled(v) },
        { names: ["compact"], label: "Model-guided compaction", get: () => deps.compactor.enabled, set: (v) => deps.compactor.setEnabled(v) },
        { names: ["agents", "auto-agents"], label: "Agent orchestration", get: () => deps.agents.enabled, set: (v) => deps.agents.setEnabled(v) },
      ];

      const toggle = toggles.find((entry) => entry.names.includes(sub));
      if (toggle) {
        const parsed = parseToggle(argument, toggle.get());
        if (parsed.error) {
          ctx.ui.notify(parsed.error, "warning");
          return;
        }
        toggle.set(Boolean(parsed.value));
        ctx.ui.notify(`${toggle.label}: ${toggle.get() ? "on" : "off"}`, "info");
        return;
      }

      if (sub === "enable" || sub === "disable") {
        const value = sub === "enable";
        for (const entry of toggles) entry.set(value);
        ctx.ui.notify(`Every automatic feature is now ${value ? "on" : "off"}.`, "info");
        return;
      }

      ctx.ui.notify(`Unknown subcommand ${JSON.stringify(sub)}.\n\n${USAGE}`, "warning");
    },
  });
}
