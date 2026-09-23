/**
 * Compaction: keep the history entries a System One model judges necessary.
 *
 * The rule is one yes/no question per candidate entry, all in a single call, which is why this is
 * affordable at all: pi-jev asked up to 24 questions per compaction and got all 24 answers back in
 * one round trip.
 *
 * When the backend is uncalibrated this declines and lets pi compact normally. The alternative is
 * dropping a constraint on the strength of a self-reported number, and a lost constraint is silent.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { BackendChain } from "../../backends/index.ts";
import { SystemOneError } from "../../errors.ts";
import { judge } from "../../judge.ts";
import { BUDGET_FRACTION, budgetQuestions, clip, type BudgetedQuestion } from "./budget.ts";

/** pi-jev's keep cutoff, kept so a migration does not change what survives a compaction. */
export const COMPACT_KEEP_THRESHOLD = 0.55;

/** Entries considered per compaction. Bounds both the question set and the prompt size. */
export const COMPACT_MAX_ENTRIES = 24;

/** Request-side cap on one entry's text, so a single tool result cannot consume the window by itself. */
const ENTRY_CHARS = 300;

/**
 * Custom entry type for the transcript marker.
 *
 * pi renders its own compaction card as `[compaction]` whoever supplied the summary, and that label
 * comes from a component this API cannot replace. A custom entry is the documented way for an
 * extension to say what it did, and a custom entry is stored without being sent to the model, so the
 * marker costs no context.
 */
export const COMPACT_MARKER_TYPE = "adecider-compact";

interface CompactMarker {
  kept: number;
  considered: number;
  judged: number;
  budgeted: number;
  backend: string;
}

export interface CompactOutcome {
  summary: string;
  kept: number;
  considered: number;
  /** Candidates actually judged; the rest were kept because the request budget was full. */
  judged?: number;
  /** Candidates never judged because they were over the request budget. */
  budgeted?: number;
  skipped?: "disabled" | "no-backend" | "empty" | "uncalibrated" | "error";
  error?: string;
}

interface Entry {
  index: number;
  text: string;
  /** Tool traffic, which is judged. */
  candidate: boolean;
  /** Conversation, which is preserved verbatim. */
  conversational: boolean;
}

/** The message object of a conversation entry, or a synthesized one for a bare string. */
function messageOf(entry: unknown): Record<string, unknown> | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const message = (entry as Record<string, unknown>)["message"];
  if (typeof message === "string") return { role: "user", content: message };
  return message && typeof message === "object" ? (message as Record<string, unknown>) : undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as Record<string, unknown>)["text"] === "string"
        ? String((part as Record<string, unknown>)["text"])
        : ""
    )
    .join(" ")
    .trim();
}

function textOf(entry: unknown): string {
  if (typeof entry === "string") return entry;
  const message = messageOf(entry);
  if (!message) return "";
  const body = contentText(message["content"]);
  // An empty body returns empty rather than JSON-dumping the entry. A system message has an empty
  // `content` and carries its real text under `sections`, and stringifying it put the entire system
  // prompt into a compaction summary, where pi regenerates it anyway.
  if (!body) return "";
  const toolName = typeof message["toolName"] === "string" ? message["toolName"] : undefined;
  return toolName ? `[${toolName}] ${body}` : body;
}

/**
 * Whether an entry is conversation, which compaction preserves rather than judges.
 *
 * Session metadata (`model_change`, `thinking_level_change`, `session`, an earlier `compaction`) is
 * neither: it carries no task information, so it is neither judged nor copied into the summary. The
 * first version copied it, and a live summary came out littered with raw JSON like
 * `[entry 0] {"type":"model_change",...}`. A system message is excluded for the same reason: the
 * harness rebuilds it on every request.
 */
function isConversational(entry: unknown): boolean {
  const role = messageOf(entry)?.["role"];
  if (role === "user" || role === "assistant") return true;
  return typeof entry === "string";
}

/**
 * Whether an entry is tool traffic, which is what compaction should thin out. Conversation intent is
 * not this feature's job.
 *
 * pi's real shape is `{type: "message", message: {role: "toolResult", toolName, content}}`, where the
 * role is nested and camel-cased. This was read from an actual session file on 2026-09-21 after a live
 * `/compact` produced `fromHook: false`: the first version looked for `type === "tool_result"`, matched
 * nothing, sent an empty question set, failed validation, and silently deferred to pi's own summarizer
 * on every compaction. The alternative spellings are kept because a shape change should degrade to
 * "judge more entries" rather than to "judge none".
 */
function isCandidate(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;
  const role = messageOf(entry)?.["role"] ?? record["role"];
  if (role === "toolResult" || role === "tool" || role === "tool_result") return true;
  const type = record["type"];
  return type === "tool_result" || type === "toolResult";
}

export class Compactor {
  enabled: boolean;

  private chain: () => BackendChain | null;

  /** What the last compaction this layer supplied did, for the marker appended after the card. */
  private lastMarker: CompactMarker | null = null;

  constructor(chain: () => BackendChain | null, enabled = false) {
    this.chain = chain;
    this.enabled = enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  install(pi: ExtensionAPI): void {
    pi.registerEntryRenderer<CompactMarker>(COMPACT_MARKER_TYPE, (entry, { expanded }, theme) => {
      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
      const label = theme.fg("customMessageLabel", "\x1b[1m[adecider compaction]\x1b[22m");
      const data = entry.data;
      if (!data) {
        box.addChild(new Text(`${label} ${theme.fg("customMessageText", "summary supplied")}`, 0, 0));
        return box;
      }
      box.addChild(
        new Text(
          `${label} ${theme.fg(
            "customMessageText",
            `default summarizer skipped, kept ${data.kept} of ${data.considered} entries`
          )}`,
          0,
          0
        )
      );
      if (expanded) {
        const details = [`judged ${data.judged}`, `backend ${data.backend}`];
        if (data.budgeted > 0) details.push(`${data.budgeted} over the request budget`);
        box.addChild(new Text(theme.fg("dim", details.join(", ")), 0, 0));
      }
      return box;
    });

    // pi's own compaction runs on the same event, so the marker is appended only when the summary
    // came from a handler, which on this machine is this one. The append waits a tick because pi
    // writes its own card after the handlers return: appending from inside the event drew the marker
    // above the card live, while a replay of the same session drew it below, which is the order a
    // reader wants (the card, then what was skipped to produce it).
    pi.on("session_compact", async (event) => {
      const marker = this.lastMarker;
      this.lastMarker = null;
      if (!event.fromExtension || !marker) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
      pi.appendEntry<CompactMarker>(COMPACT_MARKER_TYPE, marker);
    });

    pi.on("session_before_compact", async (event, ctx) => {
      const outcome = await this.compact(event, ctx);
      if (!outcome.summary) return;
      ctx.ui.setStatus("adecider", `adecider: compact kept ${outcome.kept}/${outcome.considered}`);
      return {
        compaction: {
          summary: outcome.summary,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      };
    });
  }

  async compact(event: {
    branchEntries?: unknown[];
    customInstructions?: string;
    signal?: AbortSignal;
  }, _ctx: ExtensionContext): Promise<CompactOutcome> {
    if (!this.enabled) return { summary: "", kept: 0, considered: 0, skipped: "disabled" };

    const chain = this.chain();
    if (!chain) return { summary: "", kept: 0, considered: 0, skipped: "no-backend" };

    const branch = event.branchEntries ?? [];
    if (branch.length === 0) return { summary: "", kept: 0, considered: 0, skipped: "empty" };

    const entries: Entry[] = branch.slice(0, COMPACT_MAX_ENTRIES).map((entry, index) => ({
      index,
      // 2000 characters is the summary-side cap: a kept entry is copied into the summary at this
      // length. The request-side cap is separate and smaller; see ENTRY_CHARS.
      text: textOf(entry).slice(0, 2000),
      candidate: isCandidate(entry),
      conversational: isConversational(entry),
    }));

    try {
      // Select first so the question set is budgeted against the window of whoever will answer. The
      // first version of this request carried every entry's text twice, once in the state and once
      // per question, which fit Jev's 8192-token floor and never fit the local checkpoint's 512: on
      // the default chain every keep/drop verdict was computed on a silently truncated prefix. The
      // state now carries no entry text at all, and entries past the budget are left to the
      // unanswered path below, which keeps them: dropping history is irreversible, and a request
      // that cannot fit is reported rather than sent.
      const backend = await chain.select(undefined, event.signal);
      const budgetTokens = Math.floor(backend.contextTokensFor() * BUDGET_FRACTION);

      const pairs: Array<{ entry: Entry; question: BudgetedQuestion }> = [];
      for (const entry of entries) {
        if (!entry.candidate) continue;
        pairs.push({
          entry,
          question: {
            id: `keep_${entry.index}`,
            instructions:
              "Should this historical entry remain available in the compacted context? Keep it if it holds " +
              "facts, errors, constraints, file paths, or tool results needed to continue the task. " +
              `Entry: ${clip(entry.text, ENTRY_CHARS)}`,
          },
        });
      }
      const budget = budgetQuestions(pairs, (pair) => pair.question, budgetTokens);

      const questions: Record<string, { type: "noul"; instructions: string }> = {};
      for (const pair of budget.kept) {
        questions[pair.question.id] = { type: "noul", instructions: pair.question.instructions };
      }

      const output = await judge(
        {
          state: {
            goal: event.customInstructions ?? "Continue the user's ongoing coding task",
            entryCount: entries.length,
            judged: budget.kept.map((pair) => pair.entry.index),
          },
          questions,
          threshold: COMPACT_KEEP_THRESHOLD,
        },
        { chain, signal: event.signal }
      );

      const byId = new Map((output.decisions ?? []).map((decision) => [decision.id, decision]));
      const kept: string[] = [];
      let unanswered = 0;
      for (const entry of entries) {
        // An entry with no readable text is skipped rather than copied as JSON.
        if (entry.text.length === 0) continue;
        if (!entry.candidate) {
          // Conversation is preserved; session metadata is dropped rather than dumped as JSON.
          if (entry.conversational) kept.push(`[entry ${entry.index}] ${entry.text}`);
          continue;
        }
        const decision = byId.get(`keep_${entry.index}`);
        if (!decision) {
          // The backend did not answer for this entry. Keeping it is the safe default: dropping
          // history is irreversible and silent, while keeping it only costs context.
          unanswered += 1;
          kept.push(`[entry ${entry.index}] ${entry.text}`);
          continue;
        }
        if (decision.passed) kept.push(`[entry ${entry.index}] ${entry.text}`);
      }

      let unjudgedNote = "";
      if (unanswered > 0) {
        unjudgedNote =
          `${unanswered} candidate entry(ies) were not answered and were kept rather than dropped.`;
        if (budget.dropped.length > 0) {
          unjudgedNote +=
            ` ${budget.dropped.length} of those were over the request budget for the answering backend's window.`;
        }
      }

      const summary = [
        "adecider compaction: tool history retained selectively, conversation intent preserved.",
        event.customInstructions ? `Goal: ${event.customInstructions}` : "",
        unjudgedNote,
        kept.length > 0 ? kept.join("\n") : "No historical tool entries were judged necessary to retain.",
      ]
        .filter(Boolean)
        .join("\n");

      this.lastMarker = {
        kept: kept.length,
        considered: entries.length,
        judged: budget.kept.length,
        budgeted: budget.dropped.length,
        backend: output.backend,
      };

      return {
        summary,
        kept: kept.length,
        considered: entries.length,
        judged: budget.kept.length,
        budgeted: budget.dropped.length,
      };
    } catch (error) {
      if (error instanceof SystemOneError && error.code === "calibration") {
        // An uncalibrated backend cannot ground a keep/drop decision. pi's own compaction is the safe
        // default, so this declines rather than guessing.
        return {
          summary: "",
          kept: 0,
          considered: entries.length,
          skipped: "uncalibrated",
          error: error.message,
        };
      }
      return {
        summary: "",
        kept: 0,
        considered: entries.length,
        skipped: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
