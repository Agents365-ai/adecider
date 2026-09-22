/**
 * The Jev adapter, pinned against a local stand-in.
 *
 * The live API is billed, so this file is where the wire contract is held: what leaves here, and what
 * a rejected request looks like to the caller. Both cases were measured against the real API on
 * 2026-09-24: a `noul` question whose criteria is a string is answered with HTTP 422 naming
 * `questions.<id>.noul.criteria`, the same question with an object criteria is answered normally, and
 * the probability is identical either way (0.67), so Jev reads the instructions and ignores the
 * clarification. The adapter sends the object form; these tests make that unobservable at the tool
 * surface but visible on the wire.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { judge } from "../src/judge.ts";
import { isSystemOneError } from "../src/errors.ts";
import { BackendChain } from "../src/backends/index.ts";
import type { SystemOneConfig } from "../src/config.ts";
import { startFakeLaya, type FakeLaya } from "./helpers/fake-laya.ts";

const KEY = "test-key";

/** A chain whose only backend is the Jev adapter, pointed at the fake's /decide route. */
function chainFor(fake: FakeLaya): BackendChain {
  const config: SystemOneConfig = {
    chain: ["jev"],
    backends: {
      jev: { name: "jev", kind: "jev", baseUrl: `${fake.url}/decide`, apiKey: KEY, model: "jev-latest" },
    },
    allowCloud: true,
    configPath: "<test>",
  };
  return BackendChain.fromConfig(config);
}

const QUESTION = {
  refund: {
    type: "noul" as const,
    instructions: "Does the state ask for a refund?",
    criteria: "count only explicit refunds",
  },
};

function sentQuestions(fake: FakeLaya): Record<string, unknown> {
  const request = fake.decideRequests[0];
  assert.ok(request, "the adapter sent a request");
  return request["questions"] as Record<string, unknown>;
}

test("a noul clarification string leaves as the object form Jev accepts", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  try {
    const output = await judge({ state: "please refund the duplicate charge", questions: QUESTION }, { chain: chainFor(fake) });

    assert.deepEqual(sentQuestions(fake)["refund"], {
      type: "noul",
      instructions: "Does the state ask for a refund?",
      criteria: { clarification: "count only explicit refunds" },
    });
    assert.equal(output.answers["refund"]?.value, 0.9);
    assert.equal(output.backend, "jev");
  } finally {
    await fake.close();
  }
});

test("a rejected request reports the API's own detail, not just the status line", async () => {
  const detail = [
    {
      type: "model_attributes_type",
      loc: ["body", "questions", "refund", "noul", "criteria"],
      msg: "Input should be a valid dictionary or object to extract fields from",
      input: "count only explicit refunds",
    },
  ];
  const fake = await startFakeLaya({ status: 422, onDecide: () => ({ detail }) });
  try {
    await assert.rejects(
      judge({ state: "x", questions: QUESTION }, { chain: chainFor(fake) }),
      (error: unknown) => {
        assert.ok(isSystemOneError(error), "a typed failure, not a raw fetch error");
        assert.equal(error.code, "bad_request");
        assert.match(error.message, /"noul","criteria"/, "the offending field is named");
        assert.match(error.message, /dictionary or object/, "the API's own message survives");
        assert.ok(!error.message.includes(KEY), "a rejected request never echoes the key");
        return true;
      }
    );
  } finally {
    await fake.close();
  }
});

test("an overloaded API is retried once and reported as busy, not as the caller's mistake", async () => {
  const fake = await startFakeLaya({ status: 529, onDecide: () => ({ detail: "overloaded" }) });
  try {
    await assert.rejects(
      judge({ state: "x", questions: QUESTION }, { chain: chainFor(fake) }),
      (error: unknown) => {
        assert.ok(isSystemOneError(error));
        assert.equal(error.code, "busy");
        assert.match(error.message, /transient, retry shortly/);
        return true;
      }
    );
    assert.equal(fake.decideRequests.length, 2, "one bounded retry, then the failure surfaces");
  } finally {
    await fake.close();
  }
});
