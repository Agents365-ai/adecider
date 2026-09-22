/**
 * Tool routing: judge which registered-but-inactive tools a prompt needs, then activate them.
 *
 * This is the one capability that cannot leave pi. An MCP server cannot activate another server's
 * tools, so routing lives in this adapter while everything portable lives in the core.
 *
 * Activation is additive and one-way, exactly as in pi-jev: nothing is ever deactivated, so routing
 * can only widen what is available and can never take a working tool away from a running turn.
 *
 * Two corrections over the original design, both forced by measurement (see budget.ts):
 *
 * 1. The request is budgeted against the answering backend's context window. A nine-candidate request
 *    measured 4608 tokens against Laya's 512-token window, and the truncated answers were wrong.
 * 2. Candidate descriptions are sent once, inside the question that judges them, instead of twice.
 *    Duplicating them in the state doubled the payload for no information gain.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackendChain } from "../../backends/index.ts";
import { inactiveTools, shortlist, type ToolEntry } from "./catalog.ts";
import { scoreNoul, selectCandidates, type SelectionRule } from "./decisions.ts";
import { estimateTokens } from "../../backends/types.ts";
import { BUDGET_FRACTION, budgetQuestions, clip } from "./budget.ts";

/** pi-jev's routing cutoff, kept so a migration does not silently change which tools activate. */
export const ROUTING_THRESHOLD = 0.65;

/** At most this many tools are activated from one prompt, whatever the backend reports. */
export const ROUTING_MAX = 3;

/** Candidate descriptions are clipped to this before being embedded in a question. */
export const DESCRIPTION_CHARS = 160;

/** Shortlist size before budgeting. The budget decides how many are actually judged. */
const CANDIDATE_LIMIT = 10;

export interface RouteOutcome {
  candidates: string[];
  /** Candidates that fit the request budget and were judged. */
  judged: number;
  /** Candidates dropped because the request would not have fit. */
  dropped: number;
  activated: string[];
  probabilities: Record<string, number>;
  backend?: string;
  contextTokens?: number;
  elapsedMs: number;
  /** True when selection came from ranking an uncalibrated backend. */
  ranked: boolean;
  skipped?: "no-candidates" | "no-backend" | "error";
  error?: string;
}

export interface RouteOptions {
  /** Tool names this extension owns; never offered as candidates. */
  exclude?: readonly string[];
  /** Override the default cutoff for calibrated backends. */
  threshold?: number;
  maxSelections?: number;
  signal?: AbortSignal;
}

export async function routeTools(
  pi: ExtensionAPI,
  chain: BackendChain | null,
  prompt: string,
  options?: RouteOptions
): Promise<RouteOutcome> {
  const started = Date.now();
  const rule: SelectionRule = {
    threshold: options?.threshold ?? ROUTING_THRESHOLD,
    maxSelections: options?.maxSelections ?? ROUTING_MAX,
  };
  const empty = {
    candidates: [] as string[],
    judged: 0,
    dropped: 0,
    activated: [] as string[],
    probabilities: {} as Record<string, number>,
    elapsedMs: 0,
    ranked: false,
  };

  const pool = inactiveTools(pi, options?.exclude ?? []);
  if (pool.length === 0) {
    // Nothing is inactive, so there is nothing to activate. Reported as such rather than as a
    // failed judgment.
    return { ...empty, skipped: "no-candidates" };
  }

  const candidates: ToolEntry[] = shortlist(pool, prompt, CANDIDATE_LIMIT);
  const candidateNames = candidates.map((candidate) => candidate.id);

  if (!chain) {
    return { ...empty, candidates: candidateNames, skipped: "no-backend" };
  }

  try {
    // Select first so the request can be budgeted against the window of whoever will answer.
    const backend = await chain.select(undefined, options?.signal);
    // The prompt is the state, so its cost comes out of the question budget first: the window is
    // shared, and an un-budgeted long prompt leaves the request over the window even when the
    // questions fit their own slice.
    const budgetTokens = Math.max(
      0,
      Math.floor(backend.contextTokensFor() * BUDGET_FRACTION) - estimateTokens(prompt)
    );

    const pairs = candidates.map((candidate) => ({
      candidate,
      question: {
        id: candidate.id,
        instructions:
          `Does the tool '${candidate.id}' (${clip(candidate.description, DESCRIPTION_CHARS) || "no description"}) ` +
          `directly help accomplish this task: "${prompt}"?`,
      },
    }));
    const budget = budgetQuestions(pairs, (pair) => pair.question, budgetTokens);

    if (budget.kept.length === 0) {
      return { ...empty, candidates: candidateNames, skipped: "no-candidates" };
    }

    const questions: Record<string, { instructions: string }> = {};
    for (const pair of budget.kept) {
      questions[pair.candidate.id] = { instructions: pair.question.instructions };
    }

    const result = await scoreNoul(
      chain,
      { state: prompt, questions },
      options?.signal,
      backend.name
    );
    const selection = selectCandidates(result.scores, result, rule);

    if (selection.selected.length > 0) {
      const active = pi.getActiveTools();
      pi.setActiveTools(Array.from(new Set([...active, ...selection.selected])));
    }

    return {
      candidates: candidateNames,
      judged: budget.kept.length,
      dropped: budget.dropped.length,
      activated: selection.selected,
      probabilities: result.scores,
      backend: result.backend,
      contextTokens: backend.contextTokens,
      elapsedMs: selection.elapsedMs,
      ranked: selection.ranked,
    };
  } catch (error) {
    // A failed judgment activates nothing. Falling back to "activate the keyword matches" would be
    // an unjudged decision wearing the label of a judged one.
    return {
      ...empty,
      candidates: candidateNames,
      elapsedMs: Date.now() - started,
      skipped: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
