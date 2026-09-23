/**
 * The pi adapter: adecider's non-portable half.
 *
 * Everything here needs to run inside the pi process, because it reacts to events pi emits and calls
 * into pi's own state (active tools, session model, compaction). The portable half stays at `src/` top
 * level with `src/backends`, `src/mcp`, `src/server`, and `src/cli`: backends, normalization, decision
 * rules, and the MCP server. Both halves call the same `judge()`, so a judgment cannot differ
 * depending on how it was reached.
 *
 * Feature defaults match pi-jev: everything automatic is off, unless this machine opts in through the
 * `harness` section of its config file. `/adecider status` reports what is on.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BackendChain } from "../../backends/index.ts";
import { loadConfig } from "../../config.ts";
import { AutoRouter } from "./auto.ts";
import { AutoModelRouter } from "./model-router.ts";
import { Compactor } from "./compact.ts";
import { Orchestrator } from "./orchestrator.ts";
import { SubagentHandler } from "./agent.ts";
import { ToolGuard } from "./tool-guard.ts";
import { registerAdapterCommand, type CommandDeps } from "./commands.ts";
import { registerAdapterTools, PI_TOOL_NAMES } from "./tools.ts";

function envEnabled(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Whether a harness feature is on when the command line says nothing.
 *
 * The config file is the durable opt-in (it survives however pi was launched) and the environment
 * variable is the shell-level one. The command line still has the last word in both directions: pi
 * hands an explicit flag value through, and that value is what the feature reads.
 */
export function harnessDefault(envName: string, configured: boolean | undefined): boolean {
  return envEnabled(envName) || configured === true;
}

export default function (pi: ExtensionAPI) {
  // Read once at session start: the config file decides which features are on by default here, and a
  // feature that is off costs nothing to leave off.
  const harness = loadConfig().harness ?? {};

  // Built once per session. The chain caches health probes for a few seconds internally, so a
  // backend that goes down mid-session is noticed without re-probing on every call.
  let chain: BackendChain | null = null;
  const getChain = (): BackendChain | null => chain;
  const resolveChain = (): BackendChain => {
    if (!chain) chain = BackendChain.fromConfig(loadConfig());
    return chain;
  };

  const flags = {
    auto: "adecider-auto",
    autoModel: "adecider-auto-model",
    toolGuard: "adecider-tool-guard",
    compact: "adecider-compact",
    agents: "adecider-agents",
  } as const;

  pi.registerFlag(flags.auto, {
    description: "Route tools and suggest skills with a System One backend on every prompt",
    type: "boolean",
    default: harnessDefault("ADECIDER_AUTO", harness.auto),
  });
  pi.registerFlag(flags.autoModel, {
    description: "Choose a model per prompt from local heuristics (no backend request, no decision model)",
    type: "boolean",
    default: harnessDefault("ADECIDER_AUTO_MODEL", harness.autoModel),
  });
  pi.registerFlag(flags.toolGuard, {
    description: "Judge tool calls before execution and label failures after (one backend request per call)",
    type: "boolean",
    default: harnessDefault("ADECIDER_TOOL_GUARD", harness.toolGuard),
  });
  pi.registerFlag(flags.compact, {
    description: "Let a decision model choose which history entries survive /compact",
    type: "boolean",
    default: harnessDefault("ADECIDER_COMPACT", harness.compact),
  });
  pi.registerFlag(flags.agents, {
    description: "Dispatch orchestration workflows to a subagent runner",
    type: "boolean",
    default: harnessDefault("ADECIDER_AGENTS", harness.agents),
  });

  const auto = new AutoRouter(getChain, Boolean(pi.getFlag(flags.auto)));
  const autoModel = new AutoModelRouter(pi, Boolean(pi.getFlag(flags.autoModel)));
  const compactor = new Compactor(getChain, Boolean(pi.getFlag(flags.compact)));
  const orchestrator = new Orchestrator(pi, getChain, Boolean(pi.getFlag(flags.agents)));
  const guard = new ToolGuard(pi, getChain, Boolean(pi.getFlag(flags.toolGuard)));
  const subagent = new SubagentHandler(pi, getChain);

  registerAdapterTools(pi, getChain);
  registerAdapterCommand(pi, {
    chain: getChain,
    auto,
    autoModel,
    compactor,
    agents: orchestrator,
    guard,
  } satisfies CommandDeps);

  guard.install();
  compactor.install(pi);
  orchestrator.installCompletionNotice();
  subagent.install();

  pi.on("session_start", async (_event, ctx) => {
    const resolved = resolveChain();
    const probed = await resolved.healthAll(ctx.signal);
    const up = probed.filter((entry) => entry.health.ok);

    if (up.length === 0) {
      ctx.ui.setStatus("adecider", "adecider: no backend");
      return;
    }
    const first = up[0];
    const calibration = first?.backend.calibration ?? "absolute";
    ctx.ui.setStatus(
      "adecider",
      auto.enabled
        ? `adecider: auto via ${first?.backend.name}`
        : `adecider: ready (${first?.backend.name}, ${calibration})`
    );
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!auto.enabled) return;

    // Orchestration is offered automatically only for a task that reads like a multi-stage job,
    // because dispatch hands the work to another process and that should not be a surprise.
    if (
      orchestrator.enabled &&
      /\b(architecture|refactor|security review|entire repo|parallel|multiple agents|complex migration)\b/i.test(
        event.prompt
      )
    ) {
      const result = await orchestrator.dispatch(event.prompt, ctx, true);
      if (result.accepted) {
        ctx.ui.setStatus("adecider", `adecider: dispatched ${result.topology} workflow`);
      }
    }

    const modelResult = await autoModel.route(event.prompt, ctx, {
      hasImages: Boolean(event.images?.length),
    });
    if (modelResult.changed) {
      ctx.ui.setStatus("adecider", `adecider: ${modelResult.profile} to ${modelResult.model?.id ?? "model"}`);
    }

    const outcome = await auto.run(event.prompt, ctx, ctx.signal, pi);
    if (!outcome.ran) return;

    if (outcome.activated.length > 0) {
      ctx.ui.setStatus("adecider", `adecider: +${outcome.activated.length} tool(s)`);
    }
    if (outcome.skills.length === 0) return;

    return {
      message: {
        customType: "adecider-auto",
        display: true,
        content:
          "adecider matched skill(s) for this task. Load the matching SKILL.md before proceeding:\n" +
          outcome.skills.map((skill) => `  /skill:${skill.id} (P=${skill.probability.toFixed(2)})`).join("\n"),
      },
    };
  });

  pi.on("after_provider_response", (event, ctx) => {
    const kind = autoModel.recordProviderResponse(event.status, ctx.model);
    if (kind) ctx.ui.setStatus("adecider", `adecider: ${kind}, switching away next prompt`);
  });

  // Keeping the catalog in a closure here documents the full surface in one place.
  void PI_TOOL_NAMES;
}
