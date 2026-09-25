/**
 * The three tools the pi adapter registers.
 *
 * Named `adecider_*` for a straight one-to-one mapping onto pi-jev's `jev_find_tools`,
 * `jev_find_skill`, and `jev_evaluate`, so a migration can be checked surface by surface. pi has no
 * per-server tool prefix, unlike MCP, so the prefix also keeps these names clear of pi-lens and
 * other extensions.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackendChain } from "../../backends/index.ts";
import { describeError } from "../../errors.ts";
import { judge } from "../../judge.ts";
import { findSkills } from "./skills.ts";
import { routeTools } from "./router.ts";

export const PI_TOOL_NAMES = ["adecider_find_tools", "adecider_find_skill", "adecider_evaluate"] as const;

export function isAdapterTool(name: string): boolean {
  return (PI_TOOL_NAMES as readonly string[]).includes(name);
}

const QUESTION_MAP = Type.Record(
  Type.String(),
  Type.Object({
    type: Type.Union([Type.Literal("choice"), Type.Literal("noul"), Type.Literal("score")]),
    instructions: Type.String({ description: "The judgment to make, stated as a claim for noul" }),
    criteria: Type.Optional(
      Type.Any({
        description:
          "Required for choice (an object mapping option keys to descriptions) and for score (an array of " +
          "rubric levels ordered lowest first); optional for noul, where it is a clarification string",
      })
    ),
  })
);

const EVALUATE_DESCRIPTION =
  "Ask typed System One questions (choice, noul, score) about a piece of state and get one calibrated answer " +
  "per question id from a single call. Use it for structured judgments and classifications instead of prose. " +
  `The questions argument is an object mapping each stable id to one question, as in ` +
  `{"q1": {"type": "noul", "instructions": "the claim to test"}}: instructions is required and must not be empty, ` +
  "noul takes the claim in instructions, choice takes a criteria object that maps option keys to descriptions, " +
  "and score takes a criteria array of rubric levels ordered lowest first.";

export function registerAdapterTools(pi: ExtensionAPI, chain: () => BackendChain | null): void {
  pi.registerTool({
    name: "adecider_find_tools",
    label: "Adecider Find Tools",
    description:
      "Search the tools registered in this session that are not active yet and activate the ones this task needs. " +
      "Backed by a System One decision model, so the selection carries probabilities rather than guesses.",
    promptSnippet: "Find and activate inactive tools that this task needs",
    promptGuidelines: [
      "Use adecider_find_tools when a task needs a capability that is not currently available, before asking the user to install anything.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "What the task needs to accomplish, in the user's own words." }),
      threshold: Type.Optional(
        Type.Number({ description: "Override the activation cutoff (default 0.65). Applied to calibrated backends." })
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: "Judging which tools this task needs..." }], details: {} });
      const outcome = await routeTools(pi, chain(), params.query, {
        exclude: PI_TOOL_NAMES,
        ...(params.threshold !== undefined ? { threshold: params.threshold } : {}),
        signal,
      });

      if (outcome.skipped === "no-candidates") {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Nothing to route: no inactive tool shares a term with this request, or every tool is already active. " +
                "No backend request was spent.",
            },
          ],
          details: outcome,
        };
      }
      if (outcome.skipped === "error") {
        return {
          content: [{ type: "text" as const, text: `Tool routing could not run: ${outcome.error}` }],
          details: outcome,
        };
      }

      const lines = [
        outcome.activated.length > 0
          ? `Activated ${outcome.activated.length} tool(s): ${outcome.activated.join(", ")}`
          : "No inactive tool cleared the cutoff for this task.",
        `Judged ${outcome.judged} of ${outcome.candidates.length} candidate(s) in ${outcome.elapsedMs} ms via ${outcome.backend}${outcome.ranked ? " (ranked: this backend is not calibrated)" : ""}.`,
        outcome.dropped > 0
          ? `${outcome.dropped} candidate(s) were not judged: the request would have exceeded the ${outcome.contextTokens}-token window.`
          : "",
        Object.entries(outcome.probabilities)
          .sort((a, b) => b[1] - a[1])
          .map(([name, probability]) => `  ${name}: ${probability.toFixed(3)}`)
          .join("\n"),
      ].filter(Boolean);

      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: outcome };
    },
  });

  pi.registerTool({
    name: "adecider_find_skill",
    label: "Adecider Find Skill",
    description:
      "Match this task against the skills loaded in this session and suggest the relevant ones. " +
      "A suggestion, not a context optimization: pi already lists every skill in the system prompt.",
    promptSnippet: "Suggest loaded skills that match this task",
    promptGuidelines: [
      "Use adecider_find_skill when a task might have a specialized skill available and you are unsure which one fits.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The task to match against the loaded skills." }),
      threshold: Type.Optional(
        Type.Number({ description: "Override the suggestion cutoff (default 0.65). Applied to calibrated backends." })
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: "Judging which skills fit this task..." }], details: {} });
      const outcome = await findSkills(pi, chain(), params.query, {
        ...(params.threshold !== undefined ? { threshold: params.threshold } : {}),
        signal,
      });

      if (outcome.skipped === "no-skills") {
        return {
          content: [{ type: "text" as const, text: "No skills are loaded in this session." }],
          details: outcome,
        };
      }
      if (outcome.skipped === "error") {
        return {
          content: [{ type: "text" as const, text: `Skill matching could not run: ${outcome.error}` }],
          details: outcome,
        };
      }

      const lines =
        outcome.recommended.length > 0
          ? [
              "Matching skills. Load the SKILL.md before proceeding:",
              ...outcome.recommended.map((skill) => `  /skill:${skill.id} (P=${skill.probability.toFixed(2)})`),
              `Judged ${outcome.judged} of ${outcome.candidates.length} candidate(s) in ${outcome.elapsedMs} ms via ${outcome.backend}${outcome.ranked ? " (ranked: this backend is not calibrated)" : ""}.`,
            ]
          : [
              "No loaded skill matched this task.",
              `Judged ${outcome.judged} of ${outcome.candidates.length} candidate(s) in ${outcome.elapsedMs} ms.`,
            ];

      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: outcome };
    },
  });

  pi.registerTool({
    name: "adecider_evaluate",
    label: "Adecider Evaluate",
    description: EVALUATE_DESCRIPTION,
    promptSnippet: "Perform fast calibrated structured decisions and classifications over state",
    promptGuidelines: [
      "Use adecider_evaluate when you need a probability, a categorical choice, or a rubric score rather than generated text.",
      "Ask every question you need in one adecider_evaluate call: many questions over one state cost one round trip.",
    ],
    parameters: Type.Object({
      state: Type.Any({ description: "The material to judge: text, a diff, a log, or structured JSON." }),
      questions: QUESTION_MAP,
      backend: Type.Optional(Type.String({ description: "Force a backend by name. Never falls back." })),
      model: Type.Optional(Type.String({ description: "Checkpoint or model id, for example english or jev-latest." })),
      threshold: Type.Optional(Type.Number({ description: "Add pass/fail verdicts against this score." })),
      top_k: Type.Optional(Type.Integer({ description: "Rank the top K instead of thresholding." })),
      min_confidence: Type.Optional(Type.Number({ description: "Second gate on the confidence axis." })),
      allow_uncalibrated: Type.Optional(
        Type.Boolean({ description: "Permit thresholding an uncalibrated backend, marking every verdict as such." })
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const backend = chain();
      try {
        onUpdate?.({ content: [{ type: "text", text: "Querying the System One backend..." }], details: {} });
        const output = await judge(
          {
            state: params.state,
            questions: params.questions as Record<string, unknown>,
            ...(params.backend ? { backend: params.backend } : {}),
            ...(params.model ? { model: params.model } : {}),
            ...(params.threshold !== undefined ? { threshold: params.threshold } : {}),
            ...(params.top_k !== undefined ? { topK: params.top_k } : {}),
            ...(params.min_confidence !== undefined ? { minConfidence: params.min_confidence } : {}),
            ...(params.allow_uncalibrated ? { allowUncalibrated: true } : {}),
          },
          { ...(backend ? { chain: backend } : {}), signal }
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          details: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Evaluation failed: ${describeError(error)}` }],
          isError: true,
          details: { error: describeError(error) },
        };
      }
    },
  });
}
