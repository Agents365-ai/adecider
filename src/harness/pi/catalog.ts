/**
 * Catalogs the router and the skill finder both work from, and the shared lexical shortlist.
 *
 * pi-jev carried two copies of this scoring, one in `router.ts` and one in `skills.ts`. One copy
 * here means the candidate pool rules stay identical: a candidate that can never be activated is
 * never offered to the judge either, so no backend request is spent on it.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface CatalogEntry {
  id: string;
  description: string;
  /** Extra text used for lexical matching only, never shown to the judge. */
  keywords?: string;
}

export interface ToolEntry extends CatalogEntry {
  promptSnippet?: string;
  promptGuidelines?: string[];
}

export interface SkillEntry extends CatalogEntry {
  location?: string;
}

/**
 * Terms too common to discriminate. Without this filter the ranking is close to random: a query like
 * "find code definitions and references across the repository" matched every long description on
 * `and`, `the`, and `across`, so the top candidates were the ones with the wordiest descriptions.
 * Measured 2026-09-21: the unfiltered ranking put `ast_grep_replace` and `powershell` ahead of
 * `lsp_navigation`, `grep`, and `ast_grep_search` for that query.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how",
  "in", "into", "is", "it", "its", "of", "on", "or", "that", "the", "then", "there", "these",
  "this", "to", "up", "use", "used", "using", "was", "what", "when", "which", "with", "you",
  "your", "across", "all", "any", "about", "over", "not",
]);

/** Query terms that can discriminate, which excludes short words and common ones. */
export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3 && !STOPWORDS.has(term));
}

/**
 * Score entries by how many discriminating query terms appear in their text, and keep only the ones
 * that match at least one.
 *
 * The floor matters more than the ranking. Measured 2026-09-21: for "draw an architecture diagram",
 * no candidate in the pool shared a single discriminating term, so the shortlist fell back to
 * arbitrary tools and the model then scored `powershell` 0.893 and `grep` 0.799, both above the
 * activation cutoff. The noul question invites agreement, so sending an irrelevant candidate is not a
 * neutral act: it is asking a leading question. With nothing to match, this returns nothing and the
 * caller reports that it did not run instead of spending a request on a guess.
 *
 * This is a recall filter, not a decision: its only job is to keep the set of questions sent to a
 * backend small enough to batch in one call. Term counts are never surfaced as probabilities, because
 * a term count is not a probability.
 */
export function shortlist<T extends CatalogEntry>(entries: T[], query: string, limit: number): T[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  const scored = entries.map((entry) => {
    const text = (entry.keywords ?? `${entry.id} ${entry.description}`).toLowerCase();
    let score = 0;
    for (const term of terms) if (text.includes(term)) score += 1;
    return { entry, score };
  });

  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.entry);
}

/**
 * Tools that are registered but not active.
 *
 * Only these can be routed, because only these cost nothing today: pi renders no prompt snippet and
 * no schema for an inactive tool, so activating one adds context while leaving the rest at zero.
 * A tool that is already active is not a routing question, it is already available.
 */
export function inactiveTools(pi: ExtensionAPI, exclude: readonly string[]): ToolEntry[] {
  const active = new Set(pi.getActiveTools());
  const skip = new Set(exclude);
  return pi
    .getAllTools()
    .filter((tool) => !active.has(tool.name) && !skip.has(tool.name))
    .map((tool) => ({
      id: tool.name,
      description: tool.description ?? "",
      keywords: `${tool.name} ${tool.description ?? ""} ${tool.promptGuidelines?.join(" ") ?? ""}`,
      ...(tool.promptGuidelines ? { promptGuidelines: tool.promptGuidelines } : {}),
    }));
}

/**
 * Skills, from the two places pi exposes them.
 *
 * `getSystemPromptOptions()` is the authoritative list and carries locations, but only command
 * contexts expose it. `getCommands()` is available everywhere and lists skills as commands, so it is
 * the fallback. Same two sources pi-jev used, but the returned entries already carry descriptions,
 * which is what the judge needs.
 */
export function skillCatalog(
  pi: ExtensionAPI,
  ctx?: ExtensionContext | ExtensionCommandContext
): SkillEntry[] {
  const found = new Map<string, SkillEntry>();

  if (ctx && "getSystemPromptOptions" in ctx) {
    try {
      const options = (ctx as ExtensionCommandContext).getSystemPromptOptions();
      const skills = options.skills;
      if (Array.isArray(skills)) {
        for (const skill of skills as ReadonlyArray<{
          name?: unknown;
          description?: unknown;
          location?: unknown;
        }>) {
          const name = skill.name;
          const description = skill.description;
          if (typeof name === "string" && typeof description === "string") {
            found.set(name, {
              id: name,
              description,
              ...(typeof skill.location === "string" ? { location: skill.location } : {}),
            });
          }
        }
      }
    } catch {
      // Fall through to the command list.
    }
  }

  for (const command of pi.getCommands()) {
    if (command.source !== "skill" || found.has(command.name)) continue;
    found.set(command.name, {
      id: command.name,
      description: command.description ?? `Skill ${command.name}`,
      ...(command.sourceInfo?.path ? { location: command.sourceInfo.path } : {}),
    });
  }

  return Array.from(found.values());
}
