/**
 * Conformance across the wire dialects, on captured payload shapes rather than a live service.
 *
 * The three transports encode the same three primitives three different ways. Laya returns an
 * `answers` map keyed by each primitive plus `action.act_probability` and top-level `routing`; Jev
 * returns the same map without either; an OpenAI-compatible endpoint returns a chat message whose
 * JSON carries `value`/`probability` instead of a key named after the primitive. This file pins what
 * must not differ between them: the ids and types that come back, what `score` means, and the
 * verdicts a rule produces. It is the regression net for backend API drift.
 *
 * Wall-clock latency is deliberately not asserted anywhere here. It is a measurement (README keeps
 * the numbers) and a timing assertion on a shared machine fails for reasons that have nothing to do
 * with this layer. What is asserted is what latency regressions actually came from: an adapter that
 * turns one batched judgment into one request per question.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { judge, type JudgeOutput } from "../src/judge.ts";
import { isSystemOneError } from "../src/errors.ts";
import { BackendChain } from "../src/backends/index.ts";
import type { SystemOneConfig } from "../src/config.ts";
import { startFakeLaya, type FakeLaya } from "./helpers/fake-laya.ts";

/** The same three answers, in the numbers a calibrated backend would report. */
const NUMBERS = {
  keep: { noul: 0.92, confidence: 0.92 },
  pick: { choice: "billing", probabilities: { billing: 0.8773, support: 0.0693, sales: 0.0534 } },
  risk: {
    score: 2,
    probabilities: { "0": 0.0302, "1": 0.2734, "2": 0.6964 },
    legend: { "0": "not urgent", "1": "soon", "2": "critical" },
  },
};

const QUESTIONS = {
  keep: { type: "noul" as const, instructions: "Is the state worth keeping?" },
  pick: {
    type: "choice" as const,
    instructions: "Which team should handle this?",
    criteria: { billing: "invoice issues", support: "how-to", sales: "pricing" },
  },
  risk: { type: "score" as const, instructions: "How urgent is this?", criteria: ["not urgent", "soon", "critical"] },
};

/** A Laya payload: primitive-keyed values plus the two fields only Laya returns. */
function layaPayload(): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const [id, answer] of Object.entries(NUMBERS)) {
    answers[id] = {
      ...answer,
      type: id === "keep" ? "noul" : id === "pick" ? "choice" : "score",
      action: { act_probability: 1.0 },
    };
  }
  return {
    model: "laya-rl-agent",
    answers,
    usage: { input_tokens: 154, output_tokens: 0 },
    routing: { model: "english", reason: "English Latin text", detection: { script: "latin", language: "en" } },
    elapsed_ms: 51.5,
  };
}

/** The same numbers as Jev returns them: no action head, no routing, no elapsed time. */
function jevPayload(): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const [id, answer] of Object.entries(NUMBERS)) {
    answers[id] = { ...answer, type: id === "keep" ? "noul" : id === "pick" ? "choice" : "score" };
  }
  return { model: "jev-1.13.0", answers, usage: { input_tokens: 299, output_tokens: 22 } };
}

/** The same numbers as a chat model has to write them: one flat object per question id. */
const CHAT_ANSWERS: Record<string, unknown> = {
  keep: { value: 0.92, probability: 0.92 },
  pick: { value: "billing", probability: 0.8773, probabilities: NUMBERS.pick.probabilities },
  risk: { value: 2, probability: 0.6964, probabilities: NUMBERS.risk.probabilities },
};

interface Dialect {
  name: string;
  chain: (fake: FakeLaya) => BackendChain;
  calibration: string;
}

function dialect(
  name: string,
  spec: SystemOneConfig["backends"][string],
  calibration: string,
  // Jev is cloud by declaration, so even a stand-in on loopback needs the explicit opt-in.
  allowCloud = false
): Dialect {
  return {
    name,
    calibration,
    chain: (fake: FakeLaya) =>
      BackendChain.fromConfig({
        chain: [name],
        backends: { [name]: { ...spec, baseUrl: spec.baseUrl?.replace("$FAKE", fake.url) ?? fake.url } },
        allowCloud,
        configPath: "<test>",
      }),
  };
}

const DIALECTS: Dialect[] = [
  dialect("laya-mlx", { name: "laya-mlx", kind: "laya", baseUrl: "$FAKE" }, "absolute"),
  dialect("jev", { name: "jev", kind: "jev", baseUrl: "$FAKE/decide", apiKey: "test-key" }, "absolute", true),
  dialect("chat", { name: "chat", kind: "openai", baseUrl: "$FAKE/v1", model: "fake-chat-model" }, "ranking"),
];

/** The parts of an answer that must not depend on the dialect that produced it. */
function comparableAnswer(output: JudgeOutput, id: string): Record<string, unknown> {
  const answer = output.answers[id];
  assert.ok(answer, `answer ${id} is missing`);
  return {
    id,
    type: answer.type,
    value: answer.value,
    score: answer.score,
    ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
    ...(answer.distribution !== undefined ? { distribution: answer.distribution } : {}),
    ...(answer.legend !== undefined ? { legend: answer.legend } : {}),
  };
}

/** The part of a verdict that must not depend on the dialect: everything except the act head. */
function comparableDecisions(output: JudgeOutput): Array<Record<string, unknown>> {
  return (output.decisions ?? []).map((decision) => ({
    id: decision.id,
    type: decision.type,
    value: decision.value,
    score: decision.score,
    passed: decision.passed,
    ...(decision.uncalibrated !== undefined ? { uncalibrated: decision.uncalibrated } : {}),
  }));
}

test("the same numbers in three encodings normalize to the same answers and the same verdicts", async () => {
  const laya = await startFakeLaya({ payload: layaPayload() });
  const jev = await startFakeLaya({ payload: jevPayload() });
  try {
    const rules = { threshold: 0.7 };
    const fromLaya = await judge({ state: "state", questions: QUESTIONS, ...rules }, { chain: DIALECTS[0]!.chain(laya) });
    const fromJev = await judge({ state: "state", questions: QUESTIONS, ...rules }, { chain: DIALECTS[1]!.chain(jev) });

    for (const id of Object.keys(QUESTIONS)) {
      assert.deepEqual(
        comparableAnswer(fromJev, id),
        comparableAnswer(fromLaya, id),
        `${id} must not depend on how the payload was encoded`
      );
    }
    assert.deepEqual(comparableDecisions(fromJev), comparableDecisions(fromLaya), "the verdict follows the number, not the transport");
    assert.notEqual(fromLaya.answers["pick"]?.actProbability, undefined, "only Laya carries the action head");
    assert.equal(fromJev.answers["pick"]?.actProbability, undefined);
    assert.equal(fromJev.routing, undefined, "and only Laya carries routing");
    assert.equal(fromLaya.model, "english", "routing names the checkpoint that answered");
  } finally {
    await laya.close();
    await jev.close();
  }
});

test("every dialect satisfies the same structural contract, and reports its own calibration", async () => {
  const laya = await startFakeLaya({ payload: layaPayload() });
  const chat = await startFakeLaya({ chatAnswers: CHAT_ANSWERS });
  try {
    const sources: Array<{ dialect: Dialect; chain: BackendChain }> = [
      { dialect: DIALECTS[0]!, chain: DIALECTS[0]!.chain(laya) },
      { dialect: DIALECTS[2]!, chain: DIALECTS[2]!.chain(chat) },
    ];

    for (const { dialect: source, chain } of sources) {
      const output = await judge({ state: "state", questions: QUESTIONS }, { chain });
      assert.equal(output.calibration, source.calibration, `${source.name} reports its own calibration`);
      assert.deepEqual(Object.keys(output.answers).sort(), Object.keys(QUESTIONS).sort(), "one answer per id, no extras");
      assert.equal(output.decisions, undefined, "no rule was given, so no verdict is invented");

      for (const [id, question] of Object.entries(QUESTIONS)) {
        const answer = output.answers[id];
        assert.ok(answer);
        assert.equal(answer.type, question.type, `${source.name}: the answer type is the question type`);
        assert.ok(typeof answer.score === "number" && answer.score >= 0 && answer.score <= 1, "score is a probability");

        if (question.type === "noul") {
          assert.ok(typeof answer.value === "number" && answer.value >= 0 && answer.value <= 1);
          assert.equal(answer.score, answer.value, "for noul the score is the probability itself");
        }
        if (question.type === "choice") {
          assert.ok(Object.keys(question.criteria).includes(String(answer.value)));
        }
        if (question.type === "score") {
          assert.ok(Number.isInteger(answer.value) && Number(answer.value) <= question.criteria.length - 1);
          assert.deepEqual(answer.legend, { 0: "not urgent", 1: "soon", 2: "critical" });
        }
        if (answer.distribution) {
          const peak = Math.max(...Object.values(answer.distribution));
          assert.equal(answer.score, peak, `${source.name}: score is the peak of the distribution, not its spread`);
        }
      }
    }
  } finally {
    await laya.close();
    await chat.close();
  }
});

test("one judgment is one round trip, whatever the question count", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  try {
    const chain = DIALECTS[0]!.chain(fake);
    for (const count of [1, 5, 12]) {
      const questions = Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `q${index}`,
          { type: "noul", instructions: `Is statement ${index} true?` },
        ])
      );
      const before = fake.decideRequests.length;
      const output = await judge({ state: "state", questions }, { chain });
      assert.equal(fake.decideRequests.length - before, 1, `${count} questions must still be one request`);
      assert.equal(Object.keys(output.answers).length, count, "and every question is answered");
      assert.equal(
        Object.keys(fake.decideRequests[before]?.["questions"] as object).length,
        count,
        "the whole batch is sent in that one request"
      );
    }
  } finally {
    await fake.close();
  }
});

test("two backends reporting opposite numbers stay opposite: nothing is averaged or voted", async () => {
  const high = await startFakeLaya({ echo: 0.95 });
  const low = await startFakeLaya({ echo: 0.05 });
  try {
    const question = { keep: { type: "noul" as const, instructions: "Is the state worth keeping?" } };
    const rules = { threshold: 0.5 };
    const fromHigh = await judge({ state: "state", questions: question, ...rules }, { chain: DIALECTS[0]!.chain(high) });
    const fromLow = await judge({ state: "state", questions: question, ...rules }, { chain: DIALECTS[1]!.chain(low) });

    assert.equal(fromHigh.answers["keep"]?.score, 0.95, "the number a backend reported is the number reported back");
    assert.equal(fromLow.answers["keep"]?.score, 0.05);
    assert.equal(fromHigh.decisions?.[0]?.passed, true);
    assert.equal(fromLow.decisions?.[0]?.passed, false, "a second backend is never consulted to break the tie");
    assert.equal(low.decideRequests.length, 1, "exactly the request that was asked for");
  } finally {
    await high.close();
    await low.close();
  }
});

test("a dialect that drifts out of contract fails loudly instead of answering", async () => {
  // The shape a future API version might return: the value under an unknown key.
  const drifted = await startFakeLaya({ payload: { model: "laya-next", answers: { keep: { type: "noul", probability: 0.9 } } } });
  try {
    await assert.rejects(
      judge(
        { state: "state", questions: { keep: { type: "noul", instructions: "Is the state worth keeping?" } } },
        { chain: DIALECTS[0]!.chain(drifted) }
      ),
      (error: unknown) => {
        assert.ok(isSystemOneError(error));
        assert.equal(error.code, "bad_response", "a payload this layer cannot read is not a guessed answer");
        return true;
      }
    );
  } finally {
    await drifted.close();
  }
});
