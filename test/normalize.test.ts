import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFamilyResponse } from "../src/normalize.ts";
import { SystemOneError } from "../src/errors.ts";
import { CANNED_PAYLOAD } from "./helpers/fake-laya.ts";

test("reads the shape both backends produce", () => {
  const response = normalizeFamilyResponse("laya-mlx", CANNED_PAYLOAD, 10);

  assert.equal(response.backend, "laya-mlx");
  assert.equal(response.label, "laya-rl-agent");
  assert.equal(response.model, "english");
  assert.equal(response.elapsedMs, 45.4, "the backend's own elapsed_ms wins over the measured one");
  assert.deepEqual(response.usage, { inputTokens: 154, outputTokens: 0 });
  assert.equal(response.routing?.checkpoint, "english");
  assert.equal(response.routing?.language, "en");
  assert.equal(response.routing?.script, "latin");

  const choice = response.answers["department"];
  assert.equal(choice?.type, "choice");
  assert.equal(choice?.value, "billing");
  assert.equal(choice?.confidence, 0.5846);
  assert.equal(choice?.actProbability, 1);
  assert.equal(choice?.distribution?.["billing"], 0.8773);

  const score = response.answers["urgency"];
  assert.equal(score?.type, "score");
  assert.equal(score?.value, 1.6661);
  assert.equal(score?.legend?.["2"], "critical deadline");

  const noul = response.answers["churn_risk"];
  assert.equal(noul?.type, "noul");
  assert.equal(noul?.value, 0.7848);
});

test("reads a Jev payload, which has no action head and no routing", () => {
  const response = normalizeFamilyResponse(
    "jev",
    {
      model: "jev-1.13.0",
      answers: {
        is_urgent: { type: "noul", noul: 1.0 },
        department: {
          type: "choice",
          choice: "technical",
          confidence: 0.78,
          probabilities: { technical: 0.85, billing: 0.15 },
        },
      },
      usage: { input_tokens: 392, output_tokens: 65 },
    },
    5
  );

  assert.equal(response.label, "jev-1.13.0");
  assert.equal(response.model, undefined, "no routing means no checkpoint, only a label");
  assert.equal(response.routing, undefined);
  assert.equal(response.answers["is_urgent"]?.actProbability, undefined);
  assert.equal(response.answers["department"]?.value, "technical");
  assert.deepEqual(response.usage, { inputTokens: 392, outputTokens: 65 });
});

function rejects(payload: unknown, pattern: RegExp): void {
  assert.throws(
    () => normalizeFamilyResponse("fake", payload, 1),
    (error: unknown) => error instanceof SystemOneError && pattern.test(error.message)
  );
}

test("refuses payloads it cannot read instead of inventing an answer", () => {
  rejects({}, /no `answers` object/);
  rejects({ answers: {} }, /is empty/);
  rejects({ answers: { a: "yes" } }, /is not an object/);
  rejects({ answers: { a: { type: "sentiment", noul: 1 } } }, /expected one of choice, noul, score/);
  rejects({ answers: { a: { type: "noul" } } }, /no readable noul value/);
  rejects({ answers: { a: { type: "noul", noul: "high" } } }, /must be a probability/);
});

test("surfaces a backend error string as a bad request", () => {
  assert.throws(
    () => normalizeFamilyResponse("fake", { error: "request is missing 'state'" }, 1),
    (error: unknown) =>
      error instanceof SystemOneError &&
      error.code === "bad_request" &&
      /request is missing 'state'/.test(error.message)
  );
});
