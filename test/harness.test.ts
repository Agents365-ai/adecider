/**
 * Tests for the pi adapter's decision-bearing parts and its tool surface.
 *
 * A live pi process is what activates tools, switches models, and emits events, so session wiring is
 * not covered here. What is covered is the logic those paths depend on, including the calibration
 * rule that decides whether a feature may act on a number at all, and the three registered tools,
 * driven by a fake backend that answers whatever question ids the code asks.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shortlist, skillCatalog } from "../src/harness/pi/catalog.ts";
import { selectCandidates, verdictFrom, type ScoreResult } from "../src/harness/pi/decisions.ts";
import { classifyModelError, classifyModelNeed } from "../src/harness/pi/model-router.ts";
import { buildWorkflowScript, classifyTopologyFallback } from "../src/harness/pi/orchestrator.ts";
import { validateDesign } from "../src/harness/pi/designer.ts";
import { Compactor } from "../src/harness/pi/compact.ts";
import { routeTools } from "../src/harness/pi/router.ts";
import { findSkills } from "../src/harness/pi/skills.ts";
import { ToolGuard } from "../src/harness/pi/tool-guard.ts";
import { registerAdapterTools, PI_TOOL_NAMES } from "../src/harness/pi/tools.ts";
import { BackendChain } from "../src/backends/index.ts";
import type { SystemOneConfig } from "../src/config.ts";
import { startFakeLaya, THREE_QUESTIONS, type FakeLaya } from "./helpers/fake-laya.ts";

function chainFor(fake: FakeLaya): BackendChain {
  const config: SystemOneConfig = {
    chain: ["fake"],
    backends: { fake: { name: "fake", kind: "laya", baseUrl: fake.url } },
    allowCloud: false,
    configPath: "<test>",
  };
  return BackendChain.fromConfig(config);
}

function scores(entries: Record<string, number>, calibration: "absolute" | "ranking"): ScoreResult {
  return { scores: entries, calibration, backend: "fake", elapsedMs: 1 };
}

/** The subset of the pi API these code paths touch. */
interface FakePiOptions {
  active?: string[];
  inactive: Array<{ name: string; description: string }>;
  skills?: Array<{ name: string; description: string }>;
}

/** What `registerTool` is handed, reduced to what these tests call and assert. */
interface FakeTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown; isError?: boolean }>;
}

function fakePi(options: FakePiOptions): {
  api: ExtensionAPI;
  active: () => string[];
  registered: Map<string, FakeTool>;
} {
  let active = [...(options.active ?? [])];
  const registered = new Map<string, FakeTool>();
  const api = {
    registerTool: (tool: FakeTool) => {
      registered.set(tool.name, tool);
    },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
    getAllTools: () =>
      [...options.inactive, ...(options.active ?? []).map((name) => ({ name, description: "" }))].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: {},
        promptGuidelines: [],
        sourceInfo: { path: `<test:${tool.name}>`, source: "extension" },
      })),
    getCommands: () =>
      (options.skills ?? []).map((skill) => ({
        name: skill.name,
        description: skill.description,
        source: "skill" as const,
        sourceInfo: { path: `/skills/${skill.name}/SKILL.md` },
      })),
  };
  return { api: api as unknown as ExtensionAPI, active: () => active, registered };
}

const INACTIVE = [  { name: "ast_grep_search", description: "Find code patterns structurally across the repository" },
  { name: "lsp_navigation", description: "Jump to definitions and references in code" },
  { name: "web_search", description: "Search the web for current information" },
];

test("the shortlist is a recall filter that keeps only term matches", () => {
  const entries = [
    { id: "ast_grep_search", description: "Find code patterns structurally" },
    { id: "web_search", description: "Search the web" },
    { id: "lsp_navigation", description: "Jump to definitions and references" },
  ];
  assert.deepEqual(
    shortlist(entries, "find code definitions", 2).map((entry) => entry.id),
    ["ast_grep_search", "lsp_navigation"]
  );
  // Stopwords cannot discriminate: without filtering them, `and` and `the` match every long
  // description and the ranking degenerates to "longest description first".
  assert.deepEqual(shortlist(entries, "the and of it", 5), [], "nothing to match, so nothing offered");
  assert.equal(shortlist(entries, "", 2).length, 0);
  assert.deepEqual(
    shortlist(entries, "draw an architecture diagram", 5),
    [],
    "a query no candidate matches returns nothing rather than the pool head"
  );
});

test("a calibrated backend is thresholded and an uncalibrated one is ranked", () => {
  const rule = { threshold: 0.65, maxSelections: 3 };
  const numbers = { a: 0.9, b: 0.7, c: 0.64, d: 0.2 };

  const calibrated = selectCandidates(numbers, scores(numbers, "absolute"), rule);
  assert.deepEqual(calibrated.selected, ["a", "b"]);
  assert.equal(calibrated.ranked, false);

  // The same numbers from an uncalibrated backend select nothing at 0.65, so ranking takes over
  // rather than returning an empty selection that would silently disable the feature.
  const ranked = selectCandidates(numbers, scores(numbers, "ranking"), rule);
  assert.deepEqual(ranked.selected, ["a", "b", "c"]);
  assert.equal(ranked.ranked, true);
});

test("maxSelections bounds a permissive backend", () => {
  const flooded = { a: 0.99, b: 0.98, c: 0.97, d: 0.96, e: 0.95 };
  const selection = selectCandidates(flooded, scores(flooded, "ranking"), { threshold: 0.65, maxSelections: 3 });
  assert.equal(selection.selected.length, 3);
});

test("tool routing activates what the judge selects, and nothing else", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  try {
    const pi = fakePi({ active: ["read", "bash"], inactive: INACTIVE });
    const outcome = await routeTools(pi.api, chainFor(fake), "find code definitions and references", {
      exclude: ["adecider_find_tools"],
    });

    assert.equal(outcome.skipped, undefined);
    assert.ok(outcome.activated.length > 0);
    for (const name of outcome.activated) {
      assert.ok(pi.active().includes(name), `${name} should be active`);
      assert.equal(outcome.probabilities[name], 0.9);
    }
    // `read` and `bash` were active to begin with, so they are not routing questions.
    assert.equal(outcome.candidates.includes("read"), false);
    assert.equal(outcome.candidates.includes("bash"), false);
    // `web_search` shares no discriminating term with the request, so it is never offered to the
    // judge: a leading question about an irrelevant tool invites a yes.
    assert.equal(outcome.candidates.includes("web_search"), false);
  } finally {
    await fake.close();
  }
});

test("the request is budgeted against the answering backend's window", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  try {
    // A pool of tools whose descriptions all match, with a tiny window, so candidates must be dropped.
    const many = Array.from({ length: 6 }, (_, index) => ({
      name: `code_tool_${index}`,
      description: `Find code definitions and references, variant ${index}, ${"detail ".repeat(20)}`,
    }));
    const pi = fakePi({ active: ["read"], inactive: many });
    const config: SystemOneConfig = {
      chain: ["tiny"],
      backends: { tiny: { name: "tiny", kind: "laya", baseUrl: fake.url, contextTokens: 512 } },
      allowCloud: false,
      configPath: "<test>",
    };
    const outcome = await routeTools(pi.api, BackendChain.fromConfig(config), "find code definitions and references");

    assert.ok(outcome.judged < outcome.candidates.length, "a small window must drop candidates");
    assert.ok(outcome.dropped > 0);
    assert.equal(outcome.contextTokens, 512);
    const asked = Object.keys((fake.decideRequests[0]?.["questions"] ?? {}) as object);
    assert.equal(asked.length, outcome.judged, "only the budgeted candidates were asked about");
  } finally {
    await fake.close();
  }
});

test("a request that cannot fit the window is declined rather than sent", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  try {
    // One clipped candidate question already estimates past a 128-token window, so the adapter
    // refuses the request and the router declines. Judging one candidate against a request the
    // server would silently truncate is the failure mode the budget exists to prevent.
    const many = Array.from({ length: 6 }, (_, index) => ({
      name: `code_tool_${index}`,
      description: `Find code definitions and references, variant ${index}, ${"detail ".repeat(20)}`,
    }));
    const pi = fakePi({ active: ["read"], inactive: many });
    const config: SystemOneConfig = {
      chain: ["tiny"],
      backends: { tiny: { name: "tiny", kind: "laya", baseUrl: fake.url, contextTokens: 128 } },
      allowCloud: false,
      configPath: "<test>",
    };
    const outcome = await routeTools(pi.api, BackendChain.fromConfig(config), "find code definitions and references");

    assert.equal(outcome.skipped, "error");
    assert.equal(outcome.judged, 0);
    assert.match(outcome.error ?? "", /about 128 tokens/);
    assert.equal(fake.decideRequests.length, 0, "the over-window request was never sent");
  } finally {
    await fake.close();
  }
});

test("a low-scoring backend activates nothing rather than falling back to keyword matches", async () => {
  const fake = await startFakeLaya({ echo: 0.2 });
  try {
    const pi = fakePi({ active: ["read"], inactive: INACTIVE });
    const outcome = await routeTools(pi.api, chainFor(fake), "find code definitions", {});
    assert.deepEqual(outcome.activated, []);
    assert.equal(pi.active().includes("ast_grep_search"), false);
    assert.equal(outcome.candidates.length > 0, true, "candidates were still considered");
  } finally {
    await fake.close();
  }
});

test("an empty candidate pool spends no backend request", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  try {
    const pi = fakePi({ active: ["read", "bash", "edit", "write"], inactive: [] });
    const outcome = await routeTools(pi.api, chainFor(fake), "anything at all", {});
    assert.equal(outcome.skipped, "no-candidates");
    assert.deepEqual(outcome.activated, []);
    assert.equal(fake.decideRequests.length, 0, "nothing was asked because there was nothing to ask about");
  } finally {
    await fake.close();
  }
});

test("a routing failure activates nothing and reports why", async () => {
  const pi = fakePi({ active: ["read"], inactive: INACTIVE });
  const config: SystemOneConfig = {
    chain: ["dead"],
    backends: { dead: { name: "dead", kind: "laya", baseUrl: "http://127.0.0.1:1", timeoutMs: 400 } },
    allowCloud: false,
    configPath: "<test>",
  };
  const outcome = await routeTools(pi.api, BackendChain.fromConfig(config), "find code definitions", {});
  assert.equal(outcome.skipped, "error");
  assert.deepEqual(outcome.activated, []);
  assert.equal(pi.active().includes("ast_grep_search"), false);
});

test("skill suggestions are capped and carry the judged probability", async () => {
  const fake = await startFakeLaya({ echo: 0.8 });
  try {
    const pi = fakePi({
      inactive: INACTIVE,
      skills: [
        { name: "tmux-skill", description: "Drive long running terminal programs in tmux" },
        { name: "mermaid-skill", description: "Draw diagrams from text" },
        { name: "pdf", description: "Read and combine PDF files" },
      ],
    });
    const outcome = await findSkills(pi.api, chainFor(fake), "drive a long running terminal program", {});
    assert.ok(outcome.recommended.length > 0);
    assert.ok(outcome.recommended.length <= 2, "suggestions are capped so a message stays readable");
    assert.equal(outcome.recommended[0]?.probability, 0.8);
    assert.equal(outcome.recommended[0]?.id, "tmux-skill");
  } finally {
    await fake.close();
  }
});

test("an uncalibrated backend can never block a tool call", () => {
  const high = { is_hallucinated: 0.97 };
  assert.equal(verdictFrom(high, "is_hallucinated", scores(high, "absolute"), 0.85).blocked, true);
  const uncalibrated = verdictFrom(high, "is_hallucinated", scores(high, "ranking"), 0.85);
  assert.equal(uncalibrated.blocked, false, "the same number from an uncalibrated backend does not block");
  assert.equal(uncalibrated.uncalibrated, true, "and the caller is told why");
});

test("the tool guard blocks a fabricated call above its cutoff", async () => {
  const fake = await startFakeLaya({ echo: 0.97 });
  try {
    const guard = new ToolGuard(fakePi({ inactive: INACTIVE }).api, () => chainFor(fake), true);
    const check = await guard.check("bash", { command: "cat /nonexistent/path.txt" });
    assert.ok(check);
    assert.equal(check.blocked, true);
    assert.equal(check.probability, 0.97);
    assert.ok(check.reason);
  } finally {
    await fake.close();
  }
});

test("the tool guard stays off unless enabled, and fails open when the backend is down", async () => {
  const fake = await startFakeLaya({ echo: 0.97 });
  try {
    const disabled = new ToolGuard(fakePi({ inactive: INACTIVE }).api, () => chainFor(fake), false);
    assert.equal(await disabled.check("bash", { command: "ls" }), null);
    assert.equal(fake.decideRequests.length, 0, "a disabled guard spends nothing");

    const config: SystemOneConfig = {
      chain: ["dead"],
      backends: { dead: { name: "dead", kind: "laya", baseUrl: "http://127.0.0.1:1", timeoutMs: 400 } },
      allowCloud: false,
      configPath: "<test>",
    };
    const down = new ToolGuard(fakePi({ inactive: INACTIVE }).api, () => BackendChain.fromConfig(config), true);
    assert.equal(await down.check("bash", { command: "ls" }), null, "an outage must not block every tool");
  } finally {
    await fake.close();
  }
});

test("a failed tool call is classified after the fact, where the information actually exists", async () => {
  // The echo backend answers a choice question with its first criterion key, which is `missing_file`.
  const fake = await startFakeLaya({ echo: 0.9 });
  try {
    const guard = new ToolGuard(fakePi({ inactive: INACTIVE }).api, () => chainFor(fake), true);
    const guidance = await guard.explainFailure(
      "bash",
      { command: "cat /data7/quantum/wormhole/cache/xyz.txt" },
      [{ type: "text", text: "cat: /data7/quantum/wormhole/cache/xyz.txt: No such file or directory" }]
    );
    assert.match(guidance ?? "", /Path not found/);
    assert.equal(fake.decideRequests.length, 1, "one call, and it carries the error text in the state");
    const state = fake.decideRequests[0]?.["state"] as Record<string, unknown>;
    assert.match(String(state["error"]), /No such file or directory/, "the judgment is shown what went wrong");

    // Nothing to say about a failure that needs no guidance.
    const silent = new ToolGuard(fakePi({ inactive: INACTIVE }).api, () => chainFor(fake), false);
    assert.equal(await silent.explainFailure("bash", {}, [{ type: "text", text: "boom" }]), null);
  } finally {
    await fake.close();
  }
});

test("the local topology classifier covers pi-jev's branches", () => {
  assert.equal(classifyTopologyFallback("review this pull request for security"), "review");
  assert.equal(classifyTopologyFallback("research how the auth flow works"), "research");
  assert.equal(classifyTopologyFallback("implement the new refund endpoint"), "implementation");
  assert.equal(classifyTopologyFallback("what is the weather"), "general");
});

test("every topology produces a workflow script naming a runner call", () => {
  for (const topology of ["implementation", "research", "review", "general"] as const) {
    const script = buildWorkflowScript("do the thing", topology);
    assert.match(script, /runs\.(run|all)\(/, `${topology} must call the runner`);
    assert.ok(script.includes("do the thing"), `${topology} must carry the task text`);
  }
});

test("model classification is local, and its error kinds map status codes", () => {
  assert.equal(classifyModelNeed("look at this screenshot", 0, false).profile, "vision");
  assert.equal(classifyModelNeed("x", 200_000, false).profile, "long-context");
  assert.equal(classifyModelNeed("design the architecture", 0, false).profile, "reasoning");
  assert.equal(classifyModelNeed("list files", 0, false).profile, "fast");
  assert.equal(classifyModelNeed("do something with the thing that is neither", 0, false).profile, "balanced");
  assert.equal(classifyModelNeed("look at this screenshot", 0, true).confidence, 0.95);

  assert.equal(classifyModelError(new Error("429 too many requests")), "rate-limit");
  assert.equal(classifyModelError(new Error("401 unauthorized")), "auth");
  assert.equal(classifyModelError(new Error("prompt too long")), "context-limit");
  assert.equal(classifyModelError("something else"), "unknown");
});

test("a model-authored schema is validated, and rejected when malformed", () => {
  const good = validateDesign({
    state: "some text",
    questions: {
      urgent: { type: "noul", instructions: "Is it urgent?" },
      tone: { type: "choice", instructions: "Which tone?", criteria: { a: "calm", b: "angry" } },
      severity: { type: "score", instructions: "How severe?", criteria: ["low", "high"] },
    },
  });
  assert.ok(good);
  assert.equal(Object.keys(good.questions).length, 3);
  assert.equal(good.questions["tone"]?.type, "choice");

  const bad: unknown[] = [
    null,
    { questions: {} },
    { state: "x" },
    { state: "x", questions: { a: { type: "noul" } } },
    { state: "x", questions: { a: { type: "noul", instructions: " " } } },
    { state: "x", questions: { a: { type: "choice", instructions: "y", criteria: {} } } },
    { state: "x", questions: { a: { type: "score", instructions: "y", criteria: [] } } },
    { state: "x", questions: { a: { type: "score", instructions: "y", criteria: ["ok", 2] } } },
    { state: "x", questions: { a: { type: "sentiment", instructions: "y" } } },
    { state: "x", questions: { a: { type: "choice", instructions: "y", criteria: { k: 5 } } } },
  ];
  for (const value of bad) {
    assert.equal(validateDesign(value), null, `should reject ${JSON.stringify(value)}`);
  }
});

test("compaction keeps conversation entries and judges tool traffic", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  try {
    const compactor = new Compactor(() => chainFor(fake), true);
    const outcome = await compactor.compact(
      {
        branchEntries: [
          { type: "message", message: { role: "user", content: "please fix the refund path" } },
          { type: "message", message: { role: "toolResult", toolName: "read", content: "40 lines" } },
        ],
        customInstructions: "fix the refund path",
      },
      {} as never
    );

    assert.equal(outcome.skipped, undefined);
    assert.equal(outcome.considered, 2);
    assert.equal(outcome.kept, 2);
    assert.match(outcome.summary, /please fix the refund path/);
    assert.match(outcome.summary, /\[read\] 40 lines/, "a tool result is labelled with its tool name");
    assert.equal(fake.decideRequests.length, 1, "one call for every keep question");  } finally {
    await fake.close();
  }
});

test("tool traffic is recognized in pi's real entry shape", async () => {
  // Copied from an actual pi session file, after a live /compact produced `fromHook: false` because the
  // first version looked for `type: "tool_result"` and matched nothing.
  const REAL_TOOL_RESULT = {
    type: "message",
    id: "aeb6ed31",
    parentId: "f148086c",
    timestamp: "2026-09-21T07:35:37.105Z",
    message: {
      role: "toolResult",
      toolCallId: "call_idqeabgg",
      toolName: "read",
      content: [{ type: "text", text: '{\n  "name": "adecider",\n  "version": "0.1.0"\n}' }],
    },
  };
  const REAL_USER = { type: "message", id: "x", message: { role: "user", content: "do the thing" } };
  const REAL_ASSISTANT = {
    type: "message",
    id: "y",
    message: { role: "assistant", content: [{ type: "text", text: "working on it" }] },
  };
  const REAL_METADATA = { type: "model_change", id: "z", provider: "ollama", modelId: "some-model" };

  const fake = await startFakeLaya({ echo: 0.9 });
  try {
    const compactor = new Compactor(() => chainFor(fake), true);
    const outcome = await compactor.compact(
      { branchEntries: [REAL_METADATA, REAL_USER, REAL_ASSISTANT, REAL_TOOL_RESULT] },
      {} as never
    );

    const questions = (fake.decideRequests[0]?.["questions"] ?? {}) as Record<string, unknown>;
    assert.equal(Object.keys(questions).length, 1, "exactly the tool result is judged");
    assert.ok("keep_3" in questions, "the tool result is entry index 3");

    const state = fake.decideRequests[0]?.["state"] as { entryCount: number; judged: number[] };
    assert.equal(state.entryCount, 4);
    assert.deepEqual(
      state.judged,
      [3],
      "conversation entries are preserved, only tool traffic is judged"
    );
    assert.doesNotMatch(
      JSON.stringify(state),
      /do the thing|working on it/,
      "entry text travels in its question, not duplicated in the state"
    );

    // Session metadata carries no task information, so it is neither judged nor copied forward. An
    // earlier version copied it, and a live summary came out full of raw JSON.
    assert.doesNotMatch(outcome.summary, /model_change/);
    assert.doesNotMatch(outcome.summary, /some-model/);
    assert.match(outcome.summary, /do the thing/, "conversation survives");
    assert.match(outcome.summary, /working on it/);
    assert.match(outcome.summary, /\[read\]/, "tool traffic survives when kept");

    // A system message and an entry with an empty body are skipped: the harness rebuilds the system
    // prompt, and an empty body has nothing to say. Both used to be JSON-dumped into the summary.
    // One tool result is included so the batch has something to judge.
    const noisy = await compactor.compact(
      {
        branchEntries: [
          { type: "message", id: "s", message: { role: "system", content: "", sections: { preamble: "You are an expert" } } },
          { type: "message", id: "e", message: { role: "assistant", content: [] } },
          { type: "mystery", id: "m", payload: { nested: true } },
          { type: "message", id: "u", message: { role: "user", content: "the real instruction" } },
          { type: "message", id: "t", message: { role: "toolResult", toolName: "bash", content: "exit 0" } },
        ],
      },
      {} as never
    );
    assert.match(noisy.summary, /the real instruction/);
    assert.doesNotMatch(noisy.summary, /sections|preamble|expert/);
    assert.doesNotMatch(noisy.summary, /mystery|nested/);
    assert.doesNotMatch(noisy.summary, /"role"/);

    // With no tool traffic there is nothing to thin out, so this declines and pi's own summarizer
    // runs. That is the right division of labour: this feature selects what to retain, it does not
    // summarize conversation, and pi summarizes far better than a verbatim copy would.
    const noToolTraffic = await compactor.compact(
      { branchEntries: [{ type: "message", id: "u", message: { role: "user", content: "just talk" } }] },
      {} as never
    );
    assert.equal(noToolTraffic.summary, "", "declines when there is nothing to judge");
    assert.equal(noToolTraffic.skipped, "error", "and reports why rather than pretending");
  } finally {
    await fake.close();
  }
});

test("an entry the backend does not answer is kept rather than dropped", async () => {
  // A backend that answers only the first asked id: the second candidate has no verdict.
  const fake = await startFakeLaya({
    onDecide: (body) => {
      const questions = (body["questions"] ?? {}) as Record<string, unknown>;
      const first = Object.keys(questions)[0];
      if (!first) return undefined;
      return { model: "laya-rl-agent", answers: { [first]: { type: "noul", noul: 0.05 } }, usage: {} };
    },
  });
  try {
    const compactor = new Compactor(() => chainFor(fake), true);
    const outcome = await compactor.compact(
      {
        branchEntries: [
          { type: "tool_result", role: "tool", message: "entry that was answered" },
          { type: "tool_result", role: "tool", message: "entry that was not answered" },
        ],
      },
      {} as never
    );
    assert.match(outcome.summary, /entry that was not answered/);
    assert.match(outcome.summary, /were not answered and were kept/);
    assert.doesNotMatch(outcome.summary, /entry that was answered/, "the judged entry was dropped");
  } finally {
    await fake.close();
  }
});

test("compaction declines when it is off, and when there is no history", async () => {
  const off = new Compactor(() => null, false);
  assert.equal((await off.compact({ branchEntries: [{ role: "user" }] }, {} as never)).skipped, "disabled");

  const on = new Compactor(() => null, true);
  assert.equal((await on.compact({ branchEntries: [] }, {} as never)).skipped, "no-backend");
});

test("the adapter registers exactly the three tool names a pi-jev migration maps onto", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  try {
    const pi = fakePi({ active: [], inactive: INACTIVE });
    registerAdapterTools(pi.api, () => chainFor(fake));

    assert.deepEqual([...pi.registered.keys()].sort(), [...PI_TOOL_NAMES].sort());
    // The description is what an agent routes on, so it has to state the contract, not the vendor.
    assert.match(pi.registered.get("adecider_evaluate")?.description ?? "", /calibrated answer/);
    assert.ok(
      pi.registered.get("adecider_find_tools")?.description.includes("activate"),
      "routing is the half that only exists inside pi, so the tool has to say that it acts"
    );
  } finally {
    await fake.close();
  }
});

test("adecider_evaluate returns the judgment as content and as details, and fails as a tool result", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  try {
    const pi = fakePi({ active: [], inactive: [] });
    registerAdapterTools(pi.api, () => chainFor(fake));
    const evaluate = pi.registered.get("adecider_evaluate");
    assert.ok(evaluate);

    const result = await evaluate.execute("call-1", {
      state: "a duplicate charge",
      questions: THREE_QUESTIONS,
      threshold: 0.7,
    });
    assert.equal(result.isError, undefined);
    const output = JSON.parse(result.content[0]?.text ?? "{}") as { backend: string; decisions: Array<{ passed: boolean }> };
    assert.equal(output.backend, "fake");
    assert.equal(output.decisions.length, 3);
    assert.deepEqual(result.details, output, "details carry the same object the text renders");
  } finally {
    await fake.close();
  }

  // A backend that cannot answer is a tool error, not a thrown exception: the call was well formed.
  const dead: SystemOneConfig = {
    chain: ["dead"],
    backends: { dead: { name: "dead", kind: "laya", baseUrl: "http://127.0.0.1:9", timeoutMs: 1200 } },
    allowCloud: false,
    configPath: "<test>",
  };
  const broken = fakePi({ active: [], inactive: [] });
  registerAdapterTools(broken.api, () => BackendChain.fromConfig(dead));
  const failure = await broken.registered.get("adecider_evaluate")?.execute("call-2", {
    state: "x",
    questions: THREE_QUESTIONS,
  });
  assert.equal(failure?.isError, true);
  assert.match(failure?.content[0]?.text ?? "", /Evaluation failed: unreachable/);
});

test("adecider_find_tools activates what it judged, and spends nothing when nothing matches", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  try {
    const pi = fakePi({ active: ["read"], inactive: INACTIVE });
    registerAdapterTools(pi.api, () => chainFor(fake));
    const findTools = pi.registered.get("adecider_find_tools");
    assert.ok(findTools);

    const routed = await findTools.execute("call-1", { query: "find code definitions and references" });
    assert.match(routed.content[0]?.text ?? "", /Activated \d+ tool\(s\)/);
    assert.ok(pi.active().includes("ast_grep_search"), "the judged tool is active for this session");
    assert.equal(pi.active().includes("web_search"), false, "and an unrelated candidate was never offered");

    const requests = fake.decideRequests.length;
    const empty = await findTools.execute("call-2", { query: "the and of it" });
    assert.match(empty.content[0]?.text ?? "", /no inactive tool shares a term/i);
    assert.equal(fake.decideRequests.length, requests, "no candidate match means no backend request");
  } finally {
    await fake.close();
  }
});

test("adecider_find_skill suggests loaded skills, and says so plainly when none are loaded", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  try {
    const pi = fakePi({
      active: [],
      inactive: [],
      // pi registers a skill as the command `skill:<name>`; that shape is what made a suggestion
      // render as `/skill:skill:pdf` until the catalogue normalized the id.
      skills: [{ name: "skill:pdf", description: "Read, split, merge, and OCR PDF documents" }],
    });
    registerAdapterTools(pi.api, () => chainFor(fake));
    const findSkill = pi.registered.get("adecider_find_skill");
    assert.ok(findSkill);

    const suggested = await findSkill.execute("call-1", { query: "split a PDF into pages" });
    assert.match(suggested.content[0]?.text ?? "", /Matching skills/);
    assert.match(suggested.content[0]?.text ?? "", /\/skill:pdf \(P=/);
    assert.doesNotMatch(suggested.content[0]?.text ?? "", /\/skill:skill:/, "the prefix is not doubled");

    const bare = fakePi({ active: [], inactive: [] });
    registerAdapterTools(bare.api, () => chainFor(fake));
    const none = await bare.registered.get("adecider_find_skill")?.execute("call-2", { query: "split a PDF" });
    assert.match(none?.content[0]?.text ?? "", /No skills are loaded in this session/);
  } finally {
    await fake.close();
  }
});

test("skills come from the command context when it lists them, and from commands when it cannot", () => {
  const pi = fakePi({ active: [], inactive: [], skills: [{ name: "skill:pdf", description: "Read and split PDFs" }] });

  // The command context is authoritative and carries locations, but a malformed entry is skipped
  // rather than offered with an empty description.
  const withOptions = {
    getSystemPromptOptions: () => ({
      skills: [
        { name: "pdf", description: "Read and split PDFs", location: "/skills/pdf/SKILL.md" },
        { name: "nameless" },
      ],
    }),
  };
  const fromOptions = skillCatalog(pi.api, withOptions as never);
  assert.deepEqual(fromOptions.map((entry) => entry.id), ["pdf"], "an id is the skill's name, not its command");
  assert.equal(fromOptions[0]?.location, "/skills/pdf/SKILL.md");

  const fromCommands = skillCatalog(pi.api);
  assert.deepEqual(
    fromCommands.map((entry) => entry.id),
    ["pdf"],
    "the command list is the fallback, and its `skill:` prefix does not survive into the id"
  );

  const broken = {
    getSystemPromptOptions: () => {
      throw new Error("no command context");
    },
  };
  assert.deepEqual(
    skillCatalog(pi.api, broken as never).map((entry) => entry.id),
    ["pdf"],
    "a context that throws falls back instead of failing the feature"
  );
});
