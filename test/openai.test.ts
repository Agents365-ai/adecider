/**
 * The OpenAI-compatible adapter: the escape hatch, and the one transport that writes its answers
 * instead of scoring them.
 *
 * Everything here is an error branch, because that is what this adapter's contract is made of: a chat
 * model can answer with prose, skip a question, answer one twice, or put a level where a name belongs,
 * and none of that may turn into a plausible-looking answer. Each case must surface as a typed code
 * that says what was wrong, and the retry that local servers need (many reject `response_format`) must
 * be bounded and visible in what was sent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { judge } from "../src/judge.ts";
import { isSystemOneError, type SystemOneError } from "../src/errors.ts";
import { BackendChain } from "../src/backends/index.ts";
import type { SystemOneConfig } from "../src/config.ts";
import { startFakeLaya, type FakeLaya } from "./helpers/fake-laya.ts";

const KEY = "test-key";

function chainFor(fake: FakeLaya, spec: { model?: string } = { model: "fake-chat-model" }): BackendChain {
  const config: SystemOneConfig = {
    chain: ["chat"],
    backends: {
      chat: { name: "chat", kind: "openai", baseUrl: `${fake.url}/v1`, apiKey: KEY, ...spec },
    },
    allowCloud: false,
    configPath: "<test>",
  };
  return BackendChain.fromConfig(config);
}

/** Answers a chat model would write, one per question type, so a full request can be replayed. */
const CHAT_ANSWERS = {
  keep: { value: 0.9, probability: 0.9 },
  pick: { value: "billing", probability: 0.9, probabilities: { billing: 0.9, support: 0.1 } },
  risk: { value: 1, probability: 0.9, probabilities: { "0": 0.1, "1": 0.9 } },
};

const QUESTIONS = {
  keep: { type: "noul" as const, instructions: "Is the state worth keeping?" },
  pick: {
    type: "choice" as const,
    instructions: "Which team should handle this?",
    criteria: { billing: "invoice issues", support: "how-to" },
  },
  risk: { type: "score" as const, instructions: "How urgent is this?", criteria: ["not urgent", "soon"] },
};

/** Run one judgment and insist it failed with a typed code, returning the error for inspection. */
async function failsWith(chain: BackendChain, code: string, questions: unknown = QUESTIONS): Promise<SystemOneError> {
  try {
    await judge({ state: "state", questions: questions as Record<string, unknown> }, { chain });
  } catch (error) {
    assert.ok(isSystemOneError(error), `expected a typed failure, got ${String(error)}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  throw new Error(`expected a ${code} failure, but the judgment succeeded`);
}

test("a backend with no model id is refused before anything is sent", async () => {
  const fake = await startFakeLaya();
  try {
    const chain = chainFor(fake, {});
    const error = await failsWith(chain, "bad_request", { keep: QUESTIONS.keep });
    assert.match(error.message, /needs a model id/);
    assert.match(error.message, /pass model in the request or set it in the backend config/);
    assert.equal(fake.chatRequests.length, 0, "nothing was sent to a server that cannot know the model");
  } finally {
    await fake.close();
  }
});

test("the request asks for JSON, sends the key when it has one, and carries every question", async () => {
  const fake = await startFakeLaya({ chatAnswers: CHAT_ANSWERS });
  try {
    const output = await judge({ state: "a duplicate charge", questions: QUESTIONS }, { chain: chainFor(fake) });

    const sent = fake.chatRequests[0];
    assert.ok(sent, "one chat request");
    assert.equal(sent.headers["authorization"], `Bearer ${KEY}`, "a configured key is sent");
    assert.equal(sent.body["model"], "fake-chat-model");
    assert.equal(sent.body["temperature"], 0, "a judgment is not a place for sampling");
    assert.deepEqual(sent.body["response_format"], { type: "json_object" });
    const messages = sent.body["messages"] as Array<{ role: string; content: string }>;
    assert.equal(messages.length, 2);
    assert.match(messages[0]?.content ?? "", /reply with JSON only/);
    for (const id of Object.keys(QUESTIONS)) assert.match(messages[1]?.content ?? "", new RegExp(id));

    assert.equal(output.calibration, "ranking");
    assert.equal(output.backend, "chat");
    assert.equal(output.label, "fake-chat-model", "the label falls back to the requested model");
    assert.deepEqual(output.usage, { inputTokens: 100, outputTokens: 20 });
    assert.equal(output.answers["keep"]?.score, 0.9);
  } finally {
    await fake.close();
  }
});

test("a server that rejects response_format is asked once more without it", async () => {
  const fake = await startFakeLaya({ chatAnswers: CHAT_ANSWERS, chatStatus: [400, 200] });
  try {
    const output = await judge({ state: "a duplicate charge", questions: QUESTIONS }, { chain: chainFor(fake) });

    assert.equal(fake.chatRequests.length, 2, "one bounded retry, not a loop");
    assert.ok(fake.chatRequests[0]?.body["response_format"], "the first attempt asked for JSON mode");
    assert.equal(fake.chatRequests[1]?.body["response_format"], undefined, "the retry relies on extraction");
    assert.equal(output.answers["keep"]?.score, 0.9, "and the answer is used");
  } finally {
    await fake.close();
  }
});

test("a 400 that survives the retry says so, and a 401 is not the caller's mistake", async () => {
  const bad = await startFakeLaya({ chatStatus: 400 });
  try {
    const error = await failsWith(chainFor(bad), "bad_request");
    assert.match(error.message, /also without response_format/, "the caller learns the retry happened");
    assert.equal(bad.chatRequests.length, 2);
  } finally {
    await bad.close();
  }

  const unauth = await startFakeLaya({ chatStatus: 401 });
  try {
    await failsWith(chainFor(unauth), "unconfigured");
    assert.equal(unauth.chatRequests.length, 1, "a rejected key is not retried");
  } finally {
    await unauth.close();
  }

  const overloaded = await startFakeLaya({ chatStatus: 503 });
  try {
    await failsWith(chainFor(overloaded), "busy", { keep: QUESTIONS.keep });
  } finally {
    await overloaded.close();
  }
});

test("prose, an empty reply, and a non-JSON body are all bad_response", async () => {
  const prose = await startFakeLaya({ chatContent: "Sure! The answer is probably yes, but I would need more context." });
  try {
    const error = await failsWith(chainFor(prose), "bad_response", { keep: QUESTIONS.keep });
    assert.match(error.message, /reply was not JSON/);
    assert.match(error.message, /first 200 characters: Sure!/, "the caller can see what the model said");
  } finally {
    await prose.close();
  }

  const empty = await startFakeLaya({ chatContent: "   " });
  try {
    const error = await failsWith(chainFor(empty), "bad_response", { keep: QUESTIONS.keep });
    assert.match(error.message, /returned an empty completion/);
  } finally {
    await empty.close();
  }

  const html = await startFakeLaya({ chatRaw: "<html><body>502 Bad Gateway</body></html>" });
  try {
    const error = await failsWith(chainFor(html), "bad_response", { keep: QUESTIONS.keep });
    assert.match(error.message, /returned a non-JSON body/);
  } finally {
    await html.close();
  }
});

test("an answer that does not fit its question is refused, never coerced", async () => {
  const missing = await startFakeLaya({ chatAnswers: { keep: { value: 0.9, probability: 0.9 } } });
  try {
    const error = await failsWith(chainFor(missing), "bad_response");
    assert.match(error.message, /answered no question "pick"/, "a skipped question is named, not defaulted");
  } finally {
    await missing.close();
  }

  const outOfRange = await startFakeLaya({ chatAnswers: { keep: { value: 1.5, probability: 1.5 } } });
  try {
    const error = await failsWith(chainFor(outOfRange), "bad_response", { keep: QUESTIONS.keep });
    assert.match(error.message, /expected a number in \[0,1\]/);
  } finally {
    await outOfRange.close();
  }

  const wrongOption = await startFakeLaya({ chatAnswers: { pick: { value: "engineering", probability: 0.9 } } });
  try {
    const error = await failsWith(chainFor(wrongOption), "bad_response", { pick: QUESTIONS.pick });
    assert.match(error.message, /not one of billing, support/);
  } finally {
    await wrongOption.close();
  }

  const wrongLevel = await startFakeLaya({ chatAnswers: { risk: { value: 7, probability: 0.9 } } });
  try {
    const error = await failsWith(chainFor(wrongLevel), "bad_response", { risk: QUESTIONS.risk });
    assert.match(error.message, /expected a level from 0 to 1/);
  } finally {
    await wrongLevel.close();
  }
});

test("health reports what the server offers, and why it cannot be used when it cannot", async () => {
  const fake = await startFakeLaya({ echo: 0.9, openaiModel: "one-model" });
  try {
    const health = await chainFor(fake).health("chat");
    assert.equal(health.ok, true);
    assert.match(health.detail, /serves one-model/);
    assert.deepEqual(health.models, ["one-model"]);
  } finally {
    await fake.close();
  }

  // A base URL the server does not serve under: the probe reports the status it got.
  const wrongPath = await startFakeLaya();
  try {
    const chain = BackendChain.fromConfig({
      chain: ["chat"],
      backends: { chat: { name: "chat", kind: "openai", baseUrl: `${wrongPath.url}/v1/absent`, model: "m" } },
      allowCloud: false,
      configPath: "<test>",
    });
    const health = await chain.health("chat");
    assert.equal(health.ok, false);
    assert.match(health.detail, /HTTP 404 from/);
  } finally {
    await wrongPath.close();
  }

  const dead = BackendChain.fromConfig({
    chain: ["chat"],
    backends: { chat: { name: "chat", kind: "openai", baseUrl: "http://127.0.0.1:9/v1", model: "m", timeoutMs: 1200 } },
    allowCloud: false,
    configPath: "<test>",
  });
  const gone = await dead.health("chat");
  assert.equal(gone.ok, false);
  assert.match(gone.detail, /not reachable at http:\/\/127\.0\.0\.1:9\/v1\/models/);
});

test("a remote base URL is cloud, and a loopback one is not", async () => {
  const local = BackendChain.fromConfig({
    chain: ["chat"],
    backends: { chat: { name: "chat", kind: "openai", baseUrl: "http://127.0.0.1:8090/v1", model: "m" } },
    allowCloud: false,
    configPath: "<test>",
  });
  assert.equal(local.get("chat")?.cloud, false, "loopback stays on this machine");

  const remote = BackendChain.fromConfig({
    chain: ["chat"],
    backends: { chat: { name: "chat", kind: "openai", baseUrl: "https://api.example.com/v1", model: "m" } },
    allowCloud: false,
    configPath: "<test>",
  });
  assert.equal(remote.get("chat"), undefined, "a non-loopback chat endpoint is cloud, so it needs the opt-in");
  assert.deepEqual(remote.names(), []);
});
