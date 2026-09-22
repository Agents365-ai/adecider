/**
 * `/adecider test <prompt>`: the session's active model designs a question set for a free-form
 * prompt, then a System One backend answers it.
 *
 * The design step uses the host model through `ctx.modelRegistry.complete`, so it costs whatever the
 * session's model costs and spends no backend request of its own. The schema it returns is validated
 * before use: a model-authored schema is untrusted input, and a malformed one must fail loudly rather
 * than be coerced into a judgment.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Question } from "../../types.ts";

const DESIGN_SYSTEM_PROMPT = [
  "You design System One evaluations.",
  'Return one JSON object and nothing else, in exactly this shape: {"state": <string or object>,',
  '"questions": {"<snake_case_id>": {"type": "noul"|"choice"|"score", "instructions": <string>, "criteria": <see below>}}}',
  "Rules:",
  '- "noul" is a yes/no probability question and must not include "criteria".',
  '- "choice" requires "criteria" as an object mapping option keys to descriptions.',
  '- "score" requires "criteria" as an array of rubric levels, lowest first.',
  "- Use 1 to 5 questions. Give every question a distinct snake_case id.",
  "- The state must be the material to judge, not a restatement of the questions.",
].join("\n");

/** Pull the first JSON object out of model text that may include fences or prose. */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("the model returned no JSON object");
  return JSON.parse(candidate.slice(start, end + 1));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface DesignedEvaluation {
  state: unknown;
  questions: Record<string, Question>;
}

/** Validate untrusted model output into a usable evaluation. Returns null when unusable. */
export function validateDesign(value: unknown): DesignedEvaluation | null {
  if (!isRecord(value)) return null;
  const rawQuestions = value["questions"];
  if (!isRecord(rawQuestions)) return null;
  if (!("state" in value)) return null;

  const questions: Record<string, Question> = {};
  for (const [id, raw] of Object.entries(rawQuestions)) {
    if (!isRecord(raw)) return null;
    const type = raw["type"];
    const instructions = raw["instructions"];
    if (typeof instructions !== "string" || instructions.trim().length === 0) return null;

    if (type === "noul") {
      questions[id] = {
        type: "noul",
        instructions,
        ...(typeof raw["criteria"] === "string" ? { criteria: raw["criteria"] } : {}),
      };
      continue;
    }
    const criteria = raw["criteria"];
    if (type === "choice") {
      if (!isRecord(criteria) || Object.keys(criteria).length === 0) return null;
      const options: Record<string, string | null> = {};
      for (const [key, description] of Object.entries(criteria)) {
        if (description !== null && typeof description !== "string") return null;
        options[key] = description;
      }
      questions[id] = { type: "choice", instructions, criteria: options };
      continue;
    }
    if (type === "score") {
      if (!Array.isArray(criteria) || criteria.length === 0) return null;
      if (!criteria.every((level) => typeof level === "string")) return null;
      questions[id] = { type: "score", instructions, criteria: criteria as string[] };
      continue;
    }
    return null;
  }

  if (Object.keys(questions).length === 0) return null;
  return { state: value["state"], questions };
}

export async function designEvaluation(
  ctx: ExtensionCommandContext,
  prompt: string,
  signal?: AbortSignal
): Promise<DesignedEvaluation> {
  const model = ctx.model;
  if (!model) throw new Error("no active model is available to design the evaluation");
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`no authentication is configured for ${model.provider}/${model.id}`);
  }

  const response = await ctx.modelRegistry.complete(
    model,
    {
      systemPrompt: DESIGN_SYSTEM_PROMPT,
      messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() },
      ],
    },
    { signal, cacheRetention: "none" }
  );

  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  const designed = validateDesign(extractJson(text));
  if (!designed) {
    throw new Error("the model did not return a usable question schema; try rephrasing the prompt");
  }
  return designed;
}
