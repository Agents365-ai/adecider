/**
 * Request budgeting for batched judgments.
 *
 * The problem this exists to solve, measured on 2026-09-21: a nine-candidate routing request
 * serialized to 4608 tokens, and the Laya `english` checkpoint reads 512. The server truncated the
 * request instead of rejecting it, so the answers came back confidently wrong for the candidates that
 * fell past the window. The same request measured 1762 tokens with candidate descriptions omitted
 * from the state, still 3.4x over.
 *
 * Calibration from the same session, all against a 512-token window:
 *
 * | request                                   | input tokens |
 * |-------------------------------------------|--------------|
 * | nearly empty state, one trivial question   | 32           |
 * | one question with a 50-character detail    | 69           |
 * | one question with a 700-character detail   | 201          |
 * | five questions, state held at 20 characters | 175          |
 *
 * Serialized JSON tokenizes badly: quotes, braces, and colons are each their own token, so the token
 * count tracks the character count of the JSON rather than the prose. `estimateTokens` therefore
 * over-estimates deliberately, and the budget leaves headroom.
 */

export interface BudgetedQuestion {
  id: string;
  instructions: string;
}

export interface BudgetResult<T> {
  kept: T[];
  dropped: T[];
  estimatedTokens: number;
  budgetTokens: number;
}

/**
 * Conservative token estimate for a serialized payload.
 *
 * Calibrated against the measurements in the header: a question with a 160-character description
 * serializes to about 270 characters and costs about 80 tokens in practice, while this formula
 * predicts 20 + 0.35 * 270 = 115. It over-estimates by roughly 1.4x, which is the direction that
 * keeps a request inside the window rather than truncating it.
 */
export function estimateTokens(text: string): number {
  return 20 + Math.ceil(text.length * 0.35);
}

/** Shorten a candidate description so one question cannot consume the window by itself. */
export function clip(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars - 1).trimEnd()}\u2026`;
}

/**
 * Keep as many candidates as fit, in the order given.
 *
 * Order matters and is the caller's job: pass candidates already ranked by relevance, because whatever
 * does not fit is dropped rather than truncated. `budgetTokens` should be a fraction of the backend's
 * context so the state and the answer framing still fit.
 */
export function budgetQuestions<T>(
  candidates: T[],
  build: (candidate: T) => BudgetedQuestion,
  budgetTokens: number
): BudgetResult<T> {
  const kept: T[] = [];
  const dropped: T[] = [];
  let used = 0;

  for (const candidate of candidates) {
    const question = build(candidate);
    const cost = estimateTokens(JSON.stringify(question));
    if (kept.length > 0 && used + cost > budgetTokens) {
      dropped.push(candidate);
      continue;
    }
    // The first candidate is always kept, even alone over budget: refusing to judge anything at all
    // would be a worse failure than one oversized question.
    kept.push(candidate);
    used += cost;
  }

  return { kept, dropped, estimatedTokens: used, budgetTokens };
}

/** The fraction of a backend's window this adapter is willing to fill with questions. */
export const BUDGET_FRACTION = 0.75;
