/**
 * Skill discovery: match a prompt against the skills pi has loaded and return the relevant ones.
 *
 * What this can and cannot do is worth stating plainly. pi already injects every skill's name and
 * description into the system prompt (measured on this machine: 46 skills, about 5400 tokens on every
 * request), so this feature does not save any of that. It only ranks, and the ranking is offered to
 * the agent as a message. It is a suggestion, not a context optimization.
 *
 * Like tool routing, the request is budgeted against the answering backend's window, because a
 * dozen skill descriptions is far past the 512 tokens the Laya English checkpoint can read.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BackendChain } from "../../backends/index.ts";
import { shortlist, skillCatalog, type SkillEntry } from "./catalog.ts";
import { scoreNoul, selectCandidates, type SelectionRule } from "./decisions.ts";
import { BUDGET_FRACTION, budgetQuestions, clip } from "./budget.ts";

/** Same cutoff as tool routing: one threshold for "this is relevant", wherever it is applied. */
export const SKILL_THRESHOLD = 0.65;

/** Suggestions are capped lower than tools: a message naming five skills is noise. */
export const SKILL_MAX = 2;

/** Skill descriptions run long, so they are clipped harder than tool descriptions. */
export const SKILL_DESCRIPTION_CHARS = 120;

const CANDIDATE_LIMIT = 12;

export interface SkillMatch {
  id: string;
  description: string;
  location?: string;
  probability: number;
}

export interface SkillOutcome {
  candidates: string[];
  judged: number;
  dropped: number;
  recommended: SkillMatch[];
  backend?: string;
  elapsedMs: number;
  ranked: boolean;
  skipped?: "no-skills" | "no-candidates" | "no-backend" | "error";
  error?: string;
}

export interface SkillOptions {
  ctx?: ExtensionContext | ExtensionCommandContext;
  /** Override the default cutoff for calibrated backends. */
  threshold?: number;
  maxSuggestions?: number;
  signal?: AbortSignal;
}

export async function findSkills(
  pi: ExtensionAPI,
  chain: BackendChain | null,
  prompt: string,
  options?: SkillOptions
): Promise<SkillOutcome> {
  const started = Date.now();
  const rule: SelectionRule = {
    threshold: options?.threshold ?? SKILL_THRESHOLD,
    maxSelections: options?.maxSuggestions ?? SKILL_MAX,
  };
  const empty = {
    candidates: [] as string[],
    judged: 0,
    dropped: 0,
    recommended: [] as SkillMatch[],
    elapsedMs: 0,
    ranked: false,
  };

  const catalog = skillCatalog(pi, options?.ctx);
  if (catalog.length === 0) return { ...empty, skipped: "no-skills" };

  const candidates: SkillEntry[] = shortlist(catalog, prompt, CANDIDATE_LIMIT);
  if (candidates.length === 0) return { ...empty, skipped: "no-candidates" };
  const candidateNames = candidates.map((candidate) => candidate.id);

  if (!chain) return { ...empty, candidates: candidateNames, skipped: "no-backend" };

  try {
    const backend = await chain.select(undefined, options?.signal);
    const budgetTokens = Math.floor(backend.contextTokensFor() * BUDGET_FRACTION);

    const pairs = candidates.map((candidate) => ({
      candidate,
      question: {
        id: candidate.id,
        instructions:
          `Does the skill '${candidate.id}' (${clip(candidate.description, SKILL_DESCRIPTION_CHARS)}) ` +
          `provide direct guidance or specialized domain steps for this task: "${prompt}"?`,
      },
    }));
    const budget = budgetQuestions(pairs, (pair) => pair.question, budgetTokens);
    if (budget.kept.length === 0) return { ...empty, candidates: candidateNames, skipped: "no-candidates" };

    const questions: Record<string, { instructions: string }> = {};
    for (const pair of budget.kept) questions[pair.candidate.id] = { instructions: pair.question.instructions };

    const result = await scoreNoul(
      chain,
      { state: prompt, questions },
      options?.signal,
      backend.name
    );
    const selection = selectCandidates(result.scores, result, rule);
    const chosen = new Set(selection.selected);

    const recommended: SkillMatch[] = budget.kept
      .map((pair) => pair.candidate)
      .filter((candidate) => chosen.has(candidate.id))
      .map((candidate) => ({
        id: candidate.id,
        description: candidate.description,
        probability: result.scores[candidate.id] ?? 0,
        ...(candidate.location ? { location: candidate.location } : {}),
      }))
      .sort((a, b) => b.probability - a.probability);

    return {
      candidates: candidateNames,
      judged: budget.kept.length,
      dropped: budget.dropped.length,
      recommended,
      backend: result.backend,
      elapsedMs: selection.elapsedMs,
      ranked: selection.ranked,
    };
  } catch (error) {
    // A failed judgment suggests nothing. Keyword matches are not promoted to recommendations,
    // because a term match is not a probability and must not be shown as one.
    return {
      ...empty,
      candidates: candidateNames,
      elapsedMs: Date.now() - started,
      skipped: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
