/**
 * Agent orchestration: pick a workflow topology for a task and hand the workflow script to a
 * subagent runner.
 *
 * The topology is a `choice` question, which is exactly the shape a System One model answers well:
 * four named options, one state, one answer. When no backend is available the local regex classifier
 * decides instead, and says so.
 *
 * If no subagent runner is installed, dispatch reports that. It does not fall back to running the
 * workflow itself, because a workflow script executed by the wrong process is worse than an error.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BackendChain } from "../../backends/index.ts";
import { judge } from "../../judge.ts";
import { rpcCall, ASYNC_COMPLETE } from "./rpc.ts";

export type OrchestrationTopology = "implementation" | "research" | "review" | "general";

export interface OrchestrationResult {
  accepted: boolean;
  topology?: OrchestrationTopology;
  runId?: string;
  decidedBy?: "model" | "local";
  error?: string;
}

/** Local fallback classifier, unchanged from pi-jev. */
export function classifyTopologyFallback(task: string): OrchestrationTopology {
  if (/\b(review|audit|security|check|verify|spec)\b/i.test(task)) return "review";
  if (/\b(research|investigate|explore|how does|find|analyze|architecture)\b/i.test(task)) return "research";
  if (/\b(fix|bug|implement|refactor|add|build|create|migrate|update|delete)\b/i.test(task)) {
    return "implementation";
  }
  return "general";
}

export async function determineTopology(
  task: string,
  chain: BackendChain | null,
  signal?: AbortSignal
): Promise<{ topology: OrchestrationTopology; decidedBy: "model" | "local" }> {
  if (chain) {
    try {
      const output = await judge(
        {
          state: task,
          questions: {
            topology: {
              type: "choice",
              instructions: "What type of workflow is best suited for this task?",
              criteria: {
                implementation:
                  "A code change, bugfix, refactoring, feature implementation, or file modification",
                research:
                  "Investigating the codebase, external research, architectural analysis, or exploration",
                review: "Code review, security audit, compliance checking, or reviewing a pull request",
                general: "A general question or task that needs no multi-stage workflow",
              },
            },
          },
        },
        { chain, signal }
      );

      const value = output.answers["topology"]?.value;
      if (
        value === "implementation" ||
        value === "research" ||
        value === "review" ||
        value === "general"
      ) {
        return { topology: value, decidedBy: "model" };
      }
    } catch {
      // Fall through to the local classifier.
    }
  }
  return { topology: classifyTopologyFallback(task), decidedBy: "local" };
}

/** The workflow scripts, unchanged from pi-jev: they are a contract with the runner, not our logic. */
export function buildWorkflowScript(task: string, topology: OrchestrationTopology): string {
  const goal = JSON.stringify(task);

  if (topology === "implementation") {
    return `
const scout = await runs.run("scout", {
  agent: "scout",
  label: "Scout codebase context",
  task: "Find all relevant files, functions, and architecture context needed for: " + ${goal}
});

const worker = await runs.run("worker", {
  agent: "worker",
  label: "Implement changes",
  task: "Implement the requested task using scout findings.\\n\\nScout findings:\\n" + scout.output + "\\n\\nTask:\\n" + ${goal}
});

const reviewer = await runs.run("reviewer", {
  agent: "reviewer",
  label: "Review implementation",
  task: "Review the implementation for bugs, standards, and requirements.\\n\\nTask:\\n" + ${goal} + "\\n\\nWorker output:\\n" + worker.output
});

return { scout: scout.output, worker: worker.output, reviewer: reviewer.output };
`.trim();
  }

  if (topology === "research") {
    return `
const [scout, researcher] = await runs.all([
  {
    key: "scout",
    agent: "scout",
    label: "Scout repository evidence",
    task: "Inspect repository files, structure, and code relevant to: " + ${goal}
  },
  {
    key: "researcher",
    agent: "researcher",
    label: "Research external and technical context",
    task: "Research the technical domain, best practices, and documentation for: " + ${goal}
  }
]);

const synthesizer = await runs.run("synthesizer", {
  agent: "worker",
  label: "Synthesize research report",
  task: "Synthesize local repository findings and external research into an actionable report.\\n\\nRepository findings:\\n" + scout.output + "\\n\\nExternal research:\\n" + researcher.output + "\\n\\nTask:\\n" + ${goal}
});

return { scout: scout.output, researcher: researcher.output, synthesis: synthesizer.output };
`.trim();
  }

  if (topology === "review") {
    return `
const [reviewer, auditor] = await runs.all([
  {
    key: "reviewer",
    agent: "reviewer",
    label: "Code review standards",
    task: "Perform a code review for quality, bugs, and specifications: " + ${goal}
  },
  {
    key: "auditor",
    agent: "evidence-auditor",
    label: "Security and evidence audit",
    task: "Audit security risks, verification evidence, and edge cases for: " + ${goal}
  }
]);

return { reviewer: reviewer.output, auditor: auditor.output };
`.trim();
  }

  return `
const worker = await runs.run("worker", {
  agent: "worker",
  label: "Execute task",
  task: ${goal}
});

const reviewer = await runs.run("reviewer", {
  agent: "reviewer",
  label: "Verify output",
  task: "Verify that the work meets the requirements.\\n\\nTask:\\n" + ${goal} + "\\n\\nWorker output:\\n" + worker.output
});

return { worker: worker.output, reviewer: reviewer.output };
`.trim();
}

export class Orchestrator {
  enabled: boolean;
  private running = false;

  private pi: ExtensionAPI;
  private chain: () => BackendChain | null;

  constructor(pi: ExtensionAPI, chain: () => BackendChain | null, enabled = false) {
    this.pi = pi;
    this.chain = chain;
    this.enabled = enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Report completions from a runner that emits them on the async-complete event. */
  installCompletionNotice(): void {
    this.pi.events.on(ASYNC_COMPLETE, (event: unknown) => {
      const runId = (event as { runId?: string })?.runId;
      if (!runId) return;
      this.pi.sendMessage({
        customType: "adecider-agents",
        display: true,
        content: `Agent orchestration completed: ${runId}`,
      });
    });
  }

  async dispatch(
    task: string,
    ctx: ExtensionContext,
    automatic = false
  ): Promise<OrchestrationResult> {
    if (!this.enabled && automatic) return { accepted: false, error: "disabled" };
    if (this.running) return { accepted: false, error: "busy" };
    if (!task.trim()) return { accepted: false, error: "empty task" };

    this.running = true;
    try {
      const { topology, decidedBy } = await determineTopology(task, this.chain(), ctx.signal);
      const reply = await rpcCall(
        this.pi,
        "spawn",
        { async: true, workflowScript: buildWorkflowScript(task, topology) },
        "adecider"
      );

      if (!reply.success) {
        return {
          accepted: false,
          topology,
          decidedBy,
          error: reply.error?.message ?? "no subagent runner is installed",
        };
      }

      const runId = reply.data?.runId ?? reply.data?.id;
      ctx.ui.notify(
        `Orchestration started (${topology} topology, chosen by ${decidedBy})${runId ? ` [${runId}]` : ""}.`,
        "info"
      );
      return { accepted: true, topology, decidedBy, ...(runId ? { runId } : {}) };
    } catch (error) {
      return { accepted: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.running = false;
    }
  }
}
