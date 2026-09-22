/**
 * The pi-only paths that need pi's own state: the runner RPC channel, the model registry, and the
 * session's completion call.
 *
 * These are the parts a live session would exercise, but the code under test is the decision logic
 * and the wire contract, not pi's event loop, so they run against fakes here: an event bus that can
 * answer or stay silent, a model registry with a chosen catalogue, and a completion function that
 * returns whatever the test needs. What a live session is still required for is whether pi calls
 * these handlers at all, which no fake can answer.
 *
 * The bounded-timeout paths run on mocked timers: ten real seconds per timeout test would be paid on
 * every `npm run check`, and the assertion is about the wait being bounded, not about its length.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { RPC_REQUEST, RPC_REPLY_PREFIX, RPC_TIMEOUT_MS, rpcCall, type RpcReply } from "../src/harness/pi/rpc.ts";
import { Orchestrator, buildWorkflowScript, determineTopology } from "../src/harness/pi/orchestrator.ts";
import { AutoModelRouter } from "../src/harness/pi/model-router.ts";
import { designEvaluation } from "../src/harness/pi/designer.ts";
import { ToolGuard } from "../src/harness/pi/tool-guard.ts";
import { Compactor } from "../src/harness/pi/compact.ts";
import { BackendChain } from "../src/backends/index.ts";
import type { SystemOneConfig } from "../src/config.ts";
import { startFakeLaya } from "./helpers/fake-laya.ts";

/** Let pending microtasks and un-mocked immediates settle before a mocked timer is ticked. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class FakeBus {
  private handlers = new Map<string, Set<(payload: unknown) => void>>();
  readonly emitted: Array<{ event: string; payload: unknown }> = [];

  on(event: string, handler: (payload: unknown) => void): () => void {
    const set = this.handlers.get(event) ?? new Set<(payload: unknown) => void>();
    set.add(handler);
    this.handlers.set(event, set);
    return () => set.delete(handler);
  }

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(payload);
  }

  listeners(event: string): number {
    return (this.handlers.get(event) ?? new Set()).size;
  }
}

type FakeMessage = { customType?: string; content?: string };

/** The `pi.on` half: handlers take several arguments, and what they return is what pi acts on. */
class FakeHooks {
  private handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();

  on(event: string, handler: (...args: unknown[]) => unknown): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => {
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
  }

  /** Await every handler the way pi does, and hand back what each one returned. */
  async emit(event: string, ...args: unknown[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of [...(this.handlers.get(event) ?? [])]) results.push(await handler(...args));
    return results;
  }

  count(event: string): number {
    return (this.handlers.get(event) ?? []).length;
  }
}

function fakeApi(options: { setModel?: (model: unknown) => boolean | Promise<boolean> } = {}): {
  api: ExtensionAPI;
  bus: FakeBus;
  hooks: FakeHooks;
  messages: FakeMessage[];
} {
  const bus = new FakeBus();
  const hooks = new FakeHooks();
  const messages: FakeMessage[] = [];
  const api = {
    on: hooks.on.bind(hooks),
    events: { on: bus.on.bind(bus), emit: bus.emit.bind(bus) },
    sendMessage: (message: FakeMessage) => {
      messages.push(message);
    },
    setModel: options.setModel ?? (() => true),
  };
  return { api: api as unknown as ExtensionAPI, bus, hooks, messages };
}

interface PendingRequest {
  requestId: string;
  method: string;
  params: Record<string, unknown>;
  source?: { extension?: string };
}

/** A stand-in for the subagents extension: records requests, replies only when told to. */
function fakeRunner(bus: FakeBus): { pending: PendingRequest[]; reply: (index: number, reply: RpcReply) => void } {
  const pending: PendingRequest[] = [];
  bus.on(RPC_REQUEST, (raw) => {
    pending.push(raw as PendingRequest);
  });
  return {
    pending,
    reply(index, reply) {
      const request = pending[index];
      if (request) bus.emit(`${RPC_REPLY_PREFIX}${request.requestId}`, reply);
    },
  };
}

function fakeModel(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id,
    provider: "fake",
    contextWindow: 128_000,
    input: ["text"],
    reasoning: false,
    cost: { input: 1 },
    ...overrides,
  } as unknown as Model<Api>;
}

const cost = (input: number): Model<Api>["cost"] => ({ input, output: input, cacheRead: input, cacheWrite: input });

const FAST = fakeModel("fast", { cost: cost(0.1), contextWindow: 32_000 });
const LONG = fakeModel("long", { contextWindow: 1_000_000, cost: cost(5) });
const REASONING = fakeModel("reasoning", { reasoning: true, cost: cost(20) });
const VISION = fakeModel("vision", { input: ["text", "image"], reasoning: true });

interface FakeCtxOptions {
  model?: Model<Api>;
  available?: Model<Api>[];
  scoped?: Model<Api>[];
  configured?: boolean;
  completion?: unknown;
  systemPrompt?: string;
}

function fakeCtx(options: FakeCtxOptions = {}): {
  ctx: ExtensionCommandContext;
  notes: string[];
  statuses: string[];
  completions: Array<{ model: unknown; request: { systemPrompt?: string; messages?: unknown[] } }>;
} {
  const notes: string[] = [];
  const statuses: string[] = [];
  const completions: Array<{ model: unknown; request: { systemPrompt?: string; messages?: unknown[] } }> = [];
  const ctx = {
    model: options.model,
    signal: undefined,
    scopedModels: (options.scoped ?? []).map((model) => ({ model })),
    getSystemPrompt: () => options.systemPrompt ?? "",
    ui: {
      notify: (message: string, level?: string) => {
        notes.push(`${level ?? "info"}: ${message}`);
      },
      // The text verbatim: the guard's own messages already carry the key as their prefix.
      setStatus: (_key: string, text: string) => {
        statuses.push(text);
      },
    },
    modelRegistry: {
      hasConfiguredAuth: () => options.configured ?? true,
      getAvailable: () => options.available ?? [],
      complete: async (model: unknown, request: { systemPrompt?: string; messages?: unknown[] }) => {
        completions.push({ model, request });
        return options.completion ?? { content: [] };
      },
    },
  };
  return { ctx: ctx as unknown as ExtensionCommandContext, notes, statuses, completions };
}

test("a request goes out with the protocol a pi-jev runner expects, and is answered", async () => {
  const { api, bus } = fakeApi();
  const runner = fakeRunner(bus);

  const pending = rpcCall(api, "spawn", { async: true, workflowScript: "return 1;" }, "adecider");
  await flush();
  runner.reply(0, { success: true, data: { runId: "run-7" } });

  const reply = await pending;
  assert.equal(reply.success, true);
  assert.equal(reply.data?.runId, "run-7");

  const request = runner.pending[0];
  assert.equal(request?.method, "spawn");
  assert.deepEqual(request?.params, { async: true, workflowScript: "return 1;" });
  assert.equal(request?.source?.extension, "adecider", "the runner is told which extension asked");
  assert.equal(
    bus.emitted.find((entry) => entry.event === RPC_REQUEST)?.payload &&
      (bus.emitted.find((entry) => entry.event === RPC_REQUEST)?.payload as { version: number }).version,
    1,
    "the version in the request is the one the runner protocol pins"
  );
  assert.equal(bus.listeners(`${RPC_REPLY_PREFIX}${request?.requestId}`), 0, "the reply listener is removed");
});

test("no runner means a bounded failure, not a hang, and no listener is left behind", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { api, bus } = fakeApi();

  const pending = rpcCall(api, "spawn", {}, "adecider");
  const requestId = (bus.emitted.find((entry) => entry.event === RPC_REQUEST)?.payload as { requestId: string }).requestId;
  assert.equal(bus.listeners(`${RPC_REPLY_PREFIX}${requestId}`), 1, "the reply is awaited");

  await flush();
  t.mock.timers.tick(RPC_TIMEOUT_MS);

  const reply = await pending;
  assert.equal(reply.success, false);
  assert.match(reply.error?.message ?? "", /timed out/);
  assert.equal(bus.listeners(`${RPC_REPLY_PREFIX}${requestId}`), 0, "and the wait is cleaned up");
});

test("dispatch hands the runner the workflow script for the topology it decided", async () => {
  const { api, bus } = fakeApi();
  const runner = fakeRunner(bus);
  const orchestrator = new Orchestrator(api, () => null, true);
  const { ctx, notes } = fakeCtx();

  const task = "fix the duplicate refund path";
  const pending = orchestrator.dispatch(task, ctx);
  await flush();
  runner.reply(0, { success: true, data: { id: "run-9" } });

  const result = await pending;
  assert.equal(result.accepted, true);
  assert.equal(result.topology, "implementation", "no backend, so the local classifier decided");
  assert.equal(result.decidedBy, "local");
  assert.equal(result.runId, "run-9", "the id field is read as well as runId");

  const sent = runner.pending[0]?.params;
  assert.equal(sent?.["async"], true);
  assert.equal(sent?.["workflowScript"], buildWorkflowScript(task, "implementation"), "the script is the contract");
  assert.match(notes.join("\n"), /Orchestration started \(implementation topology, chosen by local\) \[run-9\]/);
});

test("no subagent runner is reported instead of the workflow being run here", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { api, bus } = fakeApi();
  const orchestrator = new Orchestrator(api, () => null, true);
  const { ctx } = fakeCtx();

  const pending = orchestrator.dispatch("review the auth change", ctx);
  await flush();
  t.mock.timers.tick(RPC_TIMEOUT_MS);

  const result = await pending;
  assert.equal(result.accepted, false);
  assert.equal(result.topology, "review", "the decision is still reported");
  assert.match(result.error ?? "", /no reply from the subagent runner \(timed out\)/);
  assert.equal((await determineTopology("review the auth change", null)).decidedBy, "local", "and the workflow was never run here");

  // A runner that is present but declines without a reason gets the fallback message rather than an
  // empty error. It only sees requests that arrive after it installed itself, so this reply is the
  // first entry in its list.
  const runner = fakeRunner(bus);
  const declined = orchestrator.dispatch("review the auth change", ctx);
  await flush();
  runner.reply(0, { success: false });
  assert.match((await declined).error ?? "", /no subagent runner is installed/);
});

test("a dispatch in flight is busy, an empty task is refused, and automatic stays off", async () => {
  const { api, bus } = fakeApi();
  const runner = fakeRunner(bus);
  const orchestrator = new Orchestrator(api, () => null, true);
  const { ctx } = fakeCtx();

  const first = orchestrator.dispatch("plan the migration", ctx);
  await flush();
  const busy = await orchestrator.dispatch("plan the migration", ctx);
  assert.equal(busy.accepted, false);
  assert.equal(busy.error, "busy", "a second workflow is not started on top of the first");
  runner.reply(0, { success: true, data: { runId: "run-1" } });
  assert.equal((await first).accepted, true);

  const empty = await orchestrator.dispatch("   ", ctx);
  assert.equal(empty.error, "empty task");

  const automatic = new Orchestrator(api, () => null, false);
  const refused = await automatic.dispatch("plan the migration", ctx, true);
  assert.equal(refused.error, "disabled", "an automatic dispatch never runs while the feature is off");
});

test("a completion notice is reported once, and only when it names a run", () => {
  const { api, messages } = fakeApi();
  const orchestrator = new Orchestrator(api, () => null, false);
  orchestrator.installCompletionNotice();

  api.events.emit("subagent:async-complete", { runId: "run-3" });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.customType, "adecider-agents");
  assert.match(messages[0]?.content ?? "", /run-3/);

  api.events.emit("subagent:async-complete", { output: "no run id in this shape" });
  assert.equal(messages.length, 1, "an event with nothing to report produces no notice");
});

test("model selection is off until enabled, and refuses a prompt it cannot classify", async () => {
  const { api } = fakeApi();
  const off = new AutoModelRouter(api, false);
  const { ctx } = fakeCtx({ model: FAST, available: [FAST, LONG] });
  assert.equal((await off.route("plan the architecture", ctx)).skipped, "disabled");

  const on = new AutoModelRouter(api, true);
  const vague = await on.route("ok go ahead and do the thing", ctx);
  assert.equal(vague.skipped, "low-confidence", "a confidence below 0.6 must not switch anything");
  assert.equal(vague.changed, false);
});

test("a long-context prompt picks the largest window, and a vision task needs a vision model", async () => {
  const { api } = fakeApi();
  const router = new AutoModelRouter(api, true);

  const long = await router.route("read the entire repo and the migration plan", fakeCtx({ model: FAST, available: [FAST, LONG] }).ctx);
  assert.equal(long.profile, "long-context");
  assert.equal(long.changed, true);
  assert.equal(long.model?.id, "long");

  const visionCtx = fakeCtx({ model: FAST, available: [LONG, VISION] });
  const vision = await router.route("what does this screenshot show?", visionCtx.ctx, { hasImages: true });
  assert.equal(vision.profile, "vision");
  assert.equal(vision.model?.id, "vision", "a model that cannot take images is not a candidate");

  // A pool with no vision-capable model must be reported as having no candidate, not be scored and
  // picked anyway: -100 in the score is an exclusion, and a switch into a text model for an image
  // prompt would be worse than leaving the model alone.
  const textOnly = fakeCtx({ model: LONG, available: [FAST, REASONING, LONG] });
  const refused = await router.route("what does this screenshot show?", textOnly.ctx, { hasImages: true });
  assert.equal(refused.changed, false);
  assert.equal(refused.skipped, "no-model");
  assert.equal(refused.reason, "no compatible model");
});

test("a scoped catalogue is what the router chooses from when the session has one", async () => {
  const { api } = fakeApi();
  const router = new AutoModelRouter(api, true);
  const { ctx } = fakeCtx({ model: FAST, available: [FAST, REASONING, LONG], scoped: [FAST] });

  const result = await router.route("plan the architecture and review the trade-offs", ctx);
  assert.equal(result.profile, "reasoning");
  assert.equal(result.changed, false, "the only scoped model is the current one");
  assert.equal(result.model?.id, "fast");
});

test("a provider failure blocks that model for the next prompt, and auth does not", async () => {
  const { api } = fakeApi();
  const router = new AutoModelRouter(api, true);

  assert.equal(router.recordProviderResponse(429, LONG), "rate-limit");
  assert.equal(router.recordProviderResponse(401, REASONING), "auth");

  const afterThrottle = await router.route(
    "read the entire repo and the migration plan",
    fakeCtx({ model: FAST, available: [FAST, LONG, REASONING] }).ctx
  );
  assert.equal(afterThrottle.model?.id, "reasoning", "the throttled model is skipped for the next prompt");

  assert.equal(router.recordProviderResponse(200, LONG), undefined, "a success records nothing");
  assert.equal(router.recordProviderResponse(429), undefined, "and neither does a failure with no model");
});

test("a refused switch and a failing switch are reported, not thrown", async () => {  const refused = fakeApi({ setModel: () => false });
  const first = new AutoModelRouter(refused.api, true);
  const refusedResult = await first.route(
    "read the entire repo and the migration plan",
    fakeCtx({ model: FAST, available: [FAST, LONG] }).ctx
  );
  assert.equal(refusedResult.changed, false);
  assert.equal(refusedResult.skipped, "no-model");
  assert.match(refusedResult.reason, /no authentication for fake\/long/);

  // The first switch fails, the second succeeds: that is how the blocked model is shown to be skipped
  // rather than retried immediately.
  let attempts = 0;
  const failing = fakeApi({
    setModel: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("429 rate limit exceeded");
      return true;
    },
  });
  const second = new AutoModelRouter(failing.api, true);
  const failingResult = await second.route(
    "read the entire repo and the migration plan",
    fakeCtx({ model: FAST, available: [FAST, LONG, REASONING] }).ctx
  );
  assert.equal(failingResult.skipped, "error");
  assert.match(failingResult.reason, /model switch failed: rate-limit/);

  const retry = await second.route(
    "read the entire repo and the migration plan",
    fakeCtx({ model: FAST, available: [FAST, LONG, REASONING] }).ctx
  );
  assert.equal(attempts, 2, "the second route call is the only retry");
  assert.equal(retry.model?.id, "reasoning", "the switch that failed is not retried immediately");
});

test("designing an evaluation refuses before spending a model call when it cannot", async () => {
  const noModel = fakeCtx({ available: [LONG] });
  await assert.rejects(designEvaluation(noModel.ctx, "evaluate the refund path"), /no active model is available/);
  assert.equal(noModel.completions.length, 0, "nothing was sent to a model");

  const unauth = fakeCtx({ model: LONG, configured: false });
  await assert.rejects(designEvaluation(unauth.ctx, "evaluate the refund path"), /no authentication is configured/);
  assert.equal(unauth.completions.length, 0);
});

test("a designed evaluation is validated, and the session prompt carries the type rules", async () => {
  const designed = {
    state: "a duplicate charge was refunded twice",
    questions: {
      satisfies: { type: "noul", instructions: "Does the state report a refund?" },
      risk: { type: "score", instructions: "How risky?", criteria: ["trivial", "routine"] },
    },
  };
  const { api } = fakeApi();
  const router = new AutoModelRouter(api, false);
  assert.equal(router.enabled, false, "an unrelated feature does not turn the router on");

  const completion = {
    content: [{ type: "text", text: `Here is the schema:\n${JSON.stringify(designed)}\nHope that helps.` }],
  };
  const { ctx, completions } = fakeCtx({ model: LONG, completion });

  const result = await designEvaluation(ctx, "evaluate the refund path");
  assert.deepEqual(result.state, designed.state);
  assert.deepEqual(Object.keys(result.questions), ["satisfies", "risk"]);
  assert.deepEqual(result.questions["risk"]?.criteria, ["trivial", "routine"]);

  const sent = completions[0];
  assert.equal(sent?.model, LONG, "the session's own model designs the questions");
  assert.match(sent?.request.systemPrompt ?? "", /"noul" is a yes\/no probability question and must not include "criteria"/);
  assert.match(sent?.request.systemPrompt ?? "", /"score" requires "criteria" as an array of rubric levels/);
  assert.equal(sent?.request.messages?.length, 1, "one user message with the prompt");
});

test("a schema the layer cannot use is an error, not a partial evaluation", async () => {
  // Parseable, and not usable: the state is missing, so there is nothing to judge.
  const { ctx } = fakeCtx({
    model: LONG,
    completion: { content: [{ type: "text", text: '{"questions": {}}' }] },
  });
  await assert.rejects(designEvaluation(ctx, "evaluate the refund path"), /did not return a usable question schema/);

  // Parseable, and not usable: a question with no instructions would be answered about nothing.
  const thin = fakeCtx({
    model: LONG,
    completion: { content: [{ type: "text", text: '{"state": "x", "questions": {"a": {"type": "noul"}}}' }] },
  });
  await assert.rejects(designEvaluation(thin.ctx, "evaluate the refund path"), /did not return a usable question schema/);

  // Not even JSON: the failure names that, rather than pretending a schema was returned.
  const prose = fakeCtx({ model: LONG, completion: { content: [{ type: "text", text: "I cannot help with that." }] } });
  await assert.rejects(designEvaluation(prose.ctx, "evaluate the refund path"), /returned no JSON object/);
});

test("a backend decides the topology when one is available, and a bad answer falls back locally", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  const chain = () => {
    const config: SystemOneConfig = {
      chain: ["fake"],
      backends: { fake: { name: "fake", kind: "laya", baseUrl: fake.url } },
      allowCloud: false,
      configPath: "<test>",
    };
    return BackendChain.fromConfig(config);
  };
  try {
    // The fake answers a choice question with its first criterion, which is `implementation`.
    const decided = await determineTopology("fix the duplicate refund path", chain());
    assert.deepEqual(decided, { topology: "implementation", decidedBy: "model" });
    const asked = fake.decideRequests[0]?.["questions"] as Record<string, unknown>;
    assert.deepEqual(Object.keys(asked), ["topology"], "one choice question, four named options");
  } finally {
    await fake.close();
  }

  // A backend that answers with something outside the four topologies does not invent one: the local
  // classifier decides and says so.
  const wrong = await startFakeLaya({ payload: { model: "laya", answers: { topology: { type: "choice", choice: "not-a-topology", probabilities: { "not-a-topology": 0.9 } } } } });
  try {
    const config: SystemOneConfig = {
      chain: ["fake"],
      backends: { fake: { name: "fake", kind: "laya", baseUrl: wrong.url } },
      allowCloud: false,
      configPath: "<test>",
    };
    const fellBack = await determineTopology("review the security of the auth change", BackendChain.fromConfig(config));
    assert.deepEqual(fellBack, { topology: "review", decidedBy: "local" });
  } finally {
    await wrong.close();
  }
});

/** A chain over the fake service, in either dialect. */
function chainFor(baseUrl: string, kind: "laya" | "openai" = "laya"): BackendChain {
  const spec = kind === "openai" ? { name: "fake", kind, baseUrl, model: "fake-chat-model" } : { name: "fake", kind, baseUrl };
  const config: SystemOneConfig = {
    chain: ["fake"],
    backends: { fake: spec as SystemOneConfig["backends"][string] },
    allowCloud: false,
    configPath: "<test>",
  };
  return BackendChain.fromConfig(config);
}

test("the guard installs on both tool events and does nothing while it is off", async () => {
  const { api, hooks } = fakeApi();
  const guard = new ToolGuard(api, () => null, false);
  guard.install();

  assert.equal(hooks.count("tool_call"), 1, "one handler, so a migration cannot double-guard");
  assert.equal(hooks.count("tool_result"), 1);

  const call = await hooks.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, fakeCtx().ctx);
  const result = await hooks.emit("tool_result", { toolName: "bash", input: {}, content: [], isError: true }, fakeCtx().ctx);
  assert.deepEqual(call, [undefined], "an off guard allows the call");
  assert.deepEqual(result, [undefined], "and adds no guidance");
});

test("the guard never inspects its own tools, and never spends a request on them", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  const { api, hooks } = fakeApi();
  try {
    const guard = new ToolGuard(api, () => chainFor(fake.url), true);
    guard.install();

    const results = await hooks.emit(
      "tool_call",
      { toolName: "adecider_evaluate", input: { state: "x" } },
      fakeCtx().ctx
    );
    assert.deepEqual(results, [undefined]);
    assert.equal(fake.decideRequests.length, 0, "guarding the guard would recurse and cost a request");
  } finally {
    await fake.close();
  }
});

test("a calibrated backend above the cutoff blocks the call and says so in the status", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  const { api, hooks } = fakeApi();
  try {
    const guard = new ToolGuard(api, () => chainFor(fake.url), true);
    guard.install();
    const { ctx, statuses } = fakeCtx();

    const [outcome] = await hooks.emit(
      "tool_call",
      { toolName: "read", input: { path: "/data7/quantum/wormhole/cache/xyz.txt" } },
      ctx
    );
    const block = outcome as { block: boolean; reason: string };
    assert.equal(block.block, true);
    assert.match(block.reason, /Blocked by the adecider tool guard/);
    assert.match(block.reason, /P=0\.90/);
    assert.deepEqual(statuses, ["adecider: blocked read"]);
    assert.equal(fake.decideRequests.length, 1, "one request per guarded call");
  } finally {
    await fake.close();
  }
});

test("a call under the cutoff runs, and an outage fails open", async () => {
  const plausible = await startFakeLaya({ echo: 0.2 });
  const { api, hooks } = fakeApi();
  try {
    const guard = new ToolGuard(api, () => chainFor(plausible.url), true);
    guard.install();
    const { ctx, statuses } = fakeCtx();
    const [outcome] = await hooks.emit("tool_call", { toolName: "bash", input: { command: "git log" } }, ctx);
    assert.equal(outcome, undefined, "0.20 is not grounds for blocking");
    assert.deepEqual(statuses, []);
  } finally {
    await plausible.close();
  }

  // A guard that cannot reach a backend must not stop the work it is meant to protect.
  const dead: SystemOneConfig = {
    chain: ["dead"],
    backends: { dead: { name: "dead", kind: "laya", baseUrl: "http://127.0.0.1:9", timeoutMs: 1200 } },
    allowCloud: false,
    configPath: "<test>",
  };
  const outage = fakeApi();
  const guard = new ToolGuard(outage.api, () => BackendChain.fromConfig(dead), true);
  guard.install();
  const { ctx, statuses } = fakeCtx();
  const [outcome] = await outage.hooks.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, ctx);
  assert.equal(outcome, undefined, "an outage is not a verdict");
  assert.deepEqual(statuses, [], "and it is not reported as one");
});

test("an uncalibrated backend never blocks, and says which number it is declining to act on", async () => {
  const chat = await startFakeLaya({ echo: 0.99 });
  const { api, hooks } = fakeApi();
  try {
    const guard = new ToolGuard(api, () => chainFor(`${chat.url}/v1`, "openai"), true);
    guard.install();
    const first = fakeCtx();
    const second = fakeCtx();

    const [outcome] = await hooks.emit("tool_call", { toolName: "read", input: { path: "/nope/xyz" } }, first.ctx);
    assert.equal(outcome, undefined, "a self-reported number is not grounds for stopping correct work");
    assert.deepEqual(first.statuses, ["adecider: guard cannot block (0.99, uncalibrated backend)"]);

    await hooks.emit("tool_call", { toolName: "read", input: { path: "/nope/xyz" } }, second.ctx);
    assert.deepEqual(second.statuses, [], "a declined block is reported once, not on every call");

    guard.setEnabled(false);
    guard.setEnabled(true);
    const afterToggle = fakeCtx();
    await hooks.emit("tool_call", { toolName: "read", input: { path: "/nope/xyz" } }, afterToggle.ctx);
    assert.equal(afterToggle.statuses.length, 1, "turning the guard back on reports it again");
  } finally {
    await chat.close();
  }
});

test("a failed tool call gets guidance only when the failure looks like a fabricated path", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  const { api, hooks } = fakeApi();
  try {
    const guard = new ToolGuard(api, () => chainFor(fake.url), true);
    guard.install();
    const failed = { toolName: "read", input: { path: "/nope" }, content: [{ type: "text", text: "ENOENT" }], isError: true };

    const [guided] = await hooks.emit("tool_result", failed, fakeCtx().ctx);
    const content = (guided as { content: Array<{ text: string }> }).content;
    assert.equal(content.length, 2, "the original output is kept and the guidance is appended");
    assert.equal(content[0]?.text, "ENOENT");
    assert.match(content[1]?.text ?? "", /\[adecider guidance\]: Path not found/);

    const fine = await hooks.emit("tool_result", { ...failed, isError: false }, fakeCtx().ctx);
    assert.deepEqual(fine, [undefined], "a successful call is not explained");
  } finally {
    await fake.close();
  }

  // A failure the classifier reads as invalid syntax gets its own guidance, and one it reads as an
  // ordinary runtime failure gets none: the guard does not comment on everything.
  const syntax = await startFakeLaya({
    payload: {
      model: "laya",
      answers: {
        error_category: {
          type: "choice",
          choice: "syntax_flag",
          confidence: 0.9,
          probabilities: { syntax_flag: 0.9, runtime_other: 0.1 },
        },
      },
    },
  });
  const other = await startFakeLaya({
    payload: {
      model: "laya",
      answers: {
        error_category: {
          type: "choice",
          choice: "runtime_other",
          confidence: 0.9,
          probabilities: { runtime_other: 0.9 },
        },
      },
    },
  });
  const failed = { toolName: "bash", input: { command: "ls --wat" }, content: [{ type: "text", text: "flag" }], isError: true };
  try {
    const flagged = fakeApi();
    const flaggedGuard = new ToolGuard(flagged.api, () => chainFor(syntax.url), true);
    flaggedGuard.install();
    const [withSyntax] = await flagged.hooks.emit("tool_result", failed, fakeCtx().ctx);
    assert.match((withSyntax as { content: Array<{ text: string }> }).content[1]?.text ?? "", /Invalid syntax or flag/);

    const plain = fakeApi();
    const plainGuard = new ToolGuard(plain.api, () => chainFor(other.url), true);
    plainGuard.install();
    const [noComment] = await plain.hooks.emit("tool_result", failed, fakeCtx().ctx);
    assert.equal(noComment, undefined, "an expected runtime failure is left alone");
  } finally {
    await syntax.close();
    await other.close();
  }
});

test("the compactor answers pi's compaction hook, and stays out of the way otherwise", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  const { api, hooks } = fakeApi();
  try {
    const compactor = new Compactor(() => chainFor(fake.url), true);
    compactor.install(api);
    assert.equal(hooks.count("session_before_compact"), 1);

    // Nothing judges a conversation-only history, so pi's own summarizer keeps the job.
    const quiet = await hooks.emit(
      "session_before_compact",
      { branchEntries: [{ type: "message", message: { role: "user", content: "hello" } }], preparation: { firstKeptEntryId: "e1", tokensBefore: 10 } },
      fakeCtx().ctx
    );
    assert.deepEqual(quiet, [undefined], "no summary means no compaction from this layer");

    const { ctx, statuses } = fakeCtx();
    const [handled] = await hooks.emit(
      "session_before_compact",
      {
        branchEntries: [
          { type: "message", message: { role: "user", content: "fix the refund path" } },
          { type: "message", message: { role: "toolResult", toolName: "read", content: "40 lines" } },
        ],
        preparation: { firstKeptEntryId: "entry-4", tokensBefore: 1211 },
      },
      ctx
    );
    const compaction = (handled as { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number } }).compaction;
    assert.match(compaction.summary, /fix the refund path/);
    assert.equal(compaction.firstKeptEntryId, "entry-4", "pi's own boundary is passed through unchanged");
    assert.equal(compaction.tokensBefore, 1211, "and so is the count it measured");
    assert.deepEqual(statuses, ["adecider: compact kept 2/2"]);
  } finally {
    await fake.close();
  }
});

test("a ranking backend cannot ground a keep/drop decision, so compaction declines", async () => {
  const chat = await startFakeLaya({ echo: 0.99 });
  try {
    const compactor = new Compactor(() => chainFor(`${chat.url}/v1`, "openai"), true);
    const outcome = await compactor.compact(
      {
        branchEntries: [
          { type: "message", message: { role: "user", content: "fix the refund path" } },
          { type: "message", message: { role: "toolResult", toolName: "read", content: "40 lines" } },
        ],
      },
      {} as never
    );
    assert.equal(outcome.skipped, "uncalibrated");
    assert.equal(outcome.summary, "", "no summary, so pi compacts with its own model");
    assert.match(outcome.error ?? "", /calibration/);
  } finally {
    await chat.close();
  }
});
