import { test } from "node:test";
import assert from "node:assert/strict";
import { judge, validateQuestions } from "../src/judge.ts";
import { SystemOneError } from "../src/errors.ts";
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

test("judge sends state and all questions in one call", async () => {
  const fake = await startFakeLaya();
  try {
    const output = await judge(
      { state: "a duplicate charge", questions: THREE_QUESTIONS },
      { chain: chainFor(fake) }
    );

    assert.equal(fake.decideRequests.length, 1, "one round trip, however many questions");
    const sent = fake.decideRequests[0];
    assert.equal(sent?.["state"], "a duplicate charge");
    assert.deepEqual(Object.keys(sent?.["questions"] as object), [
      "department",
      "urgency",
      "churn_risk",
    ]);

    assert.equal(output.backend, "fake");
    assert.equal(output.calibration, "absolute");
    assert.equal(output.answers["department"]?.value, "billing");
    assert.equal(output.answers["department"]?.score, 0.8773);
    assert.equal(output.decisions, undefined, "no verdict is invented when the caller gave no rule");
  } finally {
    await fake.close();
  }
});

test("a threshold produces verdicts and a topK switches to ranking", async () => {
  const fake = await startFakeLaya();
  try {
    const chain = chainFor(fake);
    const thresholded = await judge(
      { state: "x", questions: THREE_QUESTIONS, threshold: 0.75 },
      { chain }
    );
    assert.equal(thresholded.decisions?.find((d) => d.id === "department")?.passed, true);
    assert.equal(thresholded.decisions?.find((d) => d.id === "urgency")?.passed, false);

    const ranked = await judge({ state: "x", questions: THREE_QUESTIONS, topK: 1 }, { chain });
    assert.equal(ranked.decisions?.filter((d) => d.passed).length, 1);
  } finally {
    await fake.close();
  }
});

test("a judgment on a local chain opens no connection that is not loopback", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
    seen.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return real(input, init);
  }) as typeof fetch;
  try {
    await judge({ state: "a duplicate charge", questions: THREE_QUESTIONS }, { chain: chainFor(fake) });
  } finally {
    globalThis.fetch = real;
    await fake.close();
  }

  assert.ok(seen.length > 0, "the local backend was really reached, so this is not a vacuous pass");
  for (const url of seen) {
    assert.match(
      new URL(url).hostname,
      /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/,
      `README claims nothing leaves the machine with a local backend, but this judgment fetched ${url}`
    );
  }
});

test("a backend that answers with an error becomes a typed failure", async () => {
  const fake = await startFakeLaya({
    onDecide: () => ({ error: "request is missing 'state'" }),
  });
  try {
    await assert.rejects(
      () => judge({ state: "x", questions: THREE_QUESTIONS }, { chain: chainFor(fake) }),
      (error: unknown) => error instanceof SystemOneError && error.code === "bad_request"
    );
  } finally {
    await fake.close();
  }
});

test("an unreachable backend never yields a verdict", async () => {
  const config: SystemOneConfig = {
    chain: ["dead"],
    backends: { dead: { name: "dead", kind: "laya", baseUrl: "http://127.0.0.1:1", timeoutMs: 500 } },
    allowCloud: false,
    configPath: "<test>",
  };
  await assert.rejects(
    () => judge({ state: "x", questions: THREE_QUESTIONS }, { chain: BackendChain.fromConfig(config) }),
    (error: unknown) =>
      error instanceof SystemOneError &&
      error.code === "unreachable" &&
      /no backend in the chain answered a health probe/.test(error.message)
  );
});

test("a named backend is never silently substituted", async () => {
  const fake = await startFakeLaya();
  try {
    await assert.rejects(
      () => judge({ state: "x", questions: THREE_QUESTIONS, backend: "absent" }, { chain: chainFor(fake) }),
      (error: unknown) =>
        error instanceof SystemOneError &&
        error.code === "bad_request" &&
        /no backend named "absent"/.test(error.message)
    );
    assert.equal(fake.decideRequests.length, 0, "the healthy backend was not used as a substitute");
  } finally {
    await fake.close();
  }
});

test("questions are validated before any call is made", () => {
  const cases: Array<[unknown, RegExp]> = [
    [{}, /questions is empty/],
    [[], /questions must be an object/],
    [{ a: "noul" }, /is not an object/],
    [{ a: { type: "sentiment", instructions: "x" } }, /expected choice, noul, or score/],
    [{ a: { type: "noul", instructions: " " } }, /needs non-empty instructions/],
    [{ a: { type: "choice", instructions: "x" } }, /needs a non-empty criteria object/],
    [{ a: { type: "choice", instructions: "x", criteria: {} } }, /needs a non-empty criteria object/],
    [{ a: { type: "score", instructions: "x" } }, /needs a non-empty criteria array/],
    [{ a: { type: "score", instructions: "x", criteria: ["ok", 3] } }, /level 1 must be a string/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(
      () => validateQuestions(input),
      (error: unknown) =>
        error instanceof SystemOneError && error.code === "bad_request" && pattern.test(error.message)
    );
  }
});

test("a valid noul question keeps its optional criteria and drops an empty one", () => {
  const questions = validateQuestions({
    a: { type: "noul", instructions: "Is it true?", criteria: "the claim" },
    b: { type: "noul", instructions: "Is it true?", criteria: "" },
  });
  assert.equal(questions["a"]?.type, "noul");
  assert.equal((questions["a"] as { criteria?: string }).criteria, "the claim");
  assert.equal((questions["b"] as { criteria?: string }).criteria, undefined);
});
