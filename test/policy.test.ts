import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, scoreOf, soleDecision } from "../src/policy.ts";
import { SystemOneError, isSystemOneError } from "../src/errors.ts";
import type { SystemOneResponse } from "../src/types.ts";
import { normalizeFamilyResponse } from "../src/normalize.ts";
import { CANNED_PAYLOAD } from "./helpers/fake-laya.ts";

const response: SystemOneResponse = normalizeFamilyResponse("laya-mlx", CANNED_PAYLOAD, 1);

test("score is the peak of the distribution, not the reported confidence", () => {
  const choice = response.answers["department"];
  assert.ok(choice);
  assert.equal(scoreOf(choice), 0.8773);
  assert.notEqual(scoreOf(choice), choice.confidence, "confidence is a spread measure, a separate axis");

  const noul = response.answers["churn_risk"];
  assert.ok(noul);
  assert.equal(scoreOf(noul), 0.7848, "a noul value is already the probability");

  const score = response.answers["urgency"];
  assert.ok(score);
  assert.equal(scoreOf(score), 0.6964);
});

test("threshold mode marks every answer", () => {
  const decisions = decide(response, { calibration: "absolute", threshold: 0.7 });
  const byId = Object.fromEntries(decisions.map((d) => [d.id, d]));

  assert.equal(byId["department"]?.passed, true, "0.8773 clears 0.7");
  assert.equal(byId["urgency"]?.passed, false, "0.6964 does not");
  assert.equal(byId["churn_risk"]?.passed, true);
});

test("confidence is a second gate, applied only when asked for", () => {
  const permissive = decide(response, { calibration: "absolute", threshold: 0.7, minConfidence: 0.5 });
  assert.equal(
    permissive.find((d) => d.id === "department")?.passed,
    true,
    "confidence 0.5846 clears 0.5, so the score threshold is still what binds"
  );

  const strict = decide(response, { calibration: "absolute", threshold: 0.7, minConfidence: 0.6 });
  assert.equal(
    strict.find((d) => d.id === "department")?.passed,
    false,
    "peak probability 0.8773 clears the score threshold but confidence 0.5846 fails 0.6"
  );
  assert.equal(
    strict.find((d) => d.id === "churn_risk")?.passed,
    true,
    "the noul answer carries confidence 0.7848"
  );
});

test("an answer with no confidence cannot fail a confidence gate", () => {
  const noConfidence: SystemOneResponse = {
    answers: { a: { id: "a", type: "noul", value: 0.9 } },
    backend: "fake",
    usage: {},
    elapsedMs: 0,
  };
  const decisions = decide(noConfidence, { calibration: "absolute", threshold: 0.5, minConfidence: 0.99 });
  assert.equal(decisions[0]?.passed, true);
});

test("ranking mode keeps the top K by score", () => {
  const decisions = decide(response, { calibration: "absolute", topK: 1 });
  assert.equal(decisions[0]?.id, "department", "ranked first at 0.8773");
  assert.equal(decisions[0]?.passed, true);
  assert.equal(decisions.filter((d) => d.passed).length, 1);
});

test("a fixed threshold against a ranking backend is refused", () => {
  assert.throws(
    () => decide(response, { calibration: "ranking", threshold: 0.7 }),
    (error: unknown) =>
      error instanceof SystemOneError &&
      error.code === "calibration" &&
      /declares ranking calibration/.test(error.message)
  );
});

test("ranking a ranking backend is allowed and needs no opt-in", () => {
  const decisions = decide(response, { calibration: "ranking", topK: 2 });
  assert.equal(decisions.filter((d) => d.passed).length, 2);
  assert.equal(decisions[0]?.uncalibrated, undefined, "ranking verdicts are not marked uncalibrated");
});

test("thresholding anyway is possible but marked", () => {
  const decisions = decide(response, { calibration: "ranking", threshold: 0.7, allowUncalibrated: true });
  assert.equal(decisions.every((d) => d.uncalibrated === true), true);
  assert.equal(decisions.find((d) => d.id === "department")?.passed, true);
});

test("a decision rule is mandatory", () => {
  assert.throws(
    () => decide(response, { calibration: "absolute" }),
    (error: unknown) => error instanceof SystemOneError && error.code === "bad_request"
  );
});

test("an answer with nothing to score is refused rather than given a number", () => {
  assert.throws(
    () => scoreOf({ id: "pick", type: "choice", value: "billing" }),
    (error: unknown) => {
      assert.ok(isSystemOneError(error));
      assert.equal(error.code, "bad_response");
      assert.match(error.message, /answer "pick" has neither a distribution nor a confidence/);
      return true;
    }
  );
});

test("a single-question caller is told which ids were answered instead", () => {
  const decisions = decide(response, { calibration: "absolute", threshold: 0.5 });
  assert.equal(soleDecision(decisions, "department").id, "department");
  assert.throws(
    () => soleDecision(decisions, "typo"),
    (error: unknown) => {
      assert.ok(isSystemOneError(error));
      assert.equal(error.code, "bad_request");
      assert.match(error.message, /no answer for question "typo"; answered ids were department, urgency, churn_risk/);
      return true;
    }
  );
});
