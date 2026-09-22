/**
 * Live check against the local Laya services. Skipped, never failed, when nothing is listening:
 * the reference service on 8318 runs only on demand and a CI host has neither.
 *
 * What this asserts that the hermetic tests cannot: that the real model separates a clean positive
 * case from a clean negative one, with a margin wide enough to justify thresholding at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { BackendChain } from "../src/backends/index.ts";
import type { SystemOneConfig } from "../src/config.ts";
import { judge } from "../src/judge.ts";
import { decide } from "../src/policy.ts";
import { isSystemOneError } from "../src/errors.ts";

const CANDIDATES = [
  { name: "laya-mlx", baseUrl: "http://127.0.0.1:8317" },
  { name: "laya", baseUrl: "http://127.0.0.1:8318" },
];

/**
 * Where the local services are expected. `ADECIDER_LIVE_URLS=name=url,name=url` points this file at
 * services running elsewhere, which is also how the suite itself is checked before a model is up.
 */
function candidates(): Array<{ name: string; baseUrl: string }> {
  const raw = process.env["ADECIDER_LIVE_URLS"]?.trim();
  if (!raw) return CANDIDATES;
  return raw.split(",").map((pair) => {
    const [name, baseUrl] = pair.split("=");
    return { name: (name ?? "").trim(), baseUrl: (baseUrl ?? "").trim() };
  });
}

function configFor(name: string, baseUrl: string): SystemOneConfig {
  return {
    chain: [name],
    backends: { [name]: { name, kind: "laya", baseUrl, timeoutMs: 30_000 } },
    allowCloud: false,
    configPath: "<live>",
  };
}

async function allLiveBackends(): Promise<Array<{ name: string; chain: BackendChain }>> {
  const up: Array<{ name: string; chain: BackendChain }> = [];
  for (const candidate of candidates()) {
    const chain = BackendChain.fromConfig(configFor(candidate.name, candidate.baseUrl));
    const health = await chain.health(candidate.name);
    if (health.ok) up.push({ name: candidate.name, chain });
  }
  return up;
}

async function anyLiveBackend(): Promise<{ name: string; chain: BackendChain } | null> {
  const [first] = await allLiveBackends();
  return first ?? null;
}

const QUESTION = {
  satisfies: {
    type: "noul" as const,
    instructions:
      "Does the state satisfy this criterion: the change reports a refund for a duplicate charge?",
  },
};

const POSITIVE = [
  'diff --git a/billing.py\n+def refund(invoice):\n+    """Issue a refund for a duplicate charge."""\n+    return refunds.create(invoice=invoice)',
  "All 42 tests passed. Coverage 87%. The refund path is covered by test_refund_duplicate_charge.",
];

const NEGATIVE = [
  "diff --git a/billing.py\n+def refund(invoice):\n+    raise NotImplementedError('refunds are not supported yet')",
  "No tests were run. The change touches the refund path but nothing verifies it.",
];

test("a live backend separates a clear positive from a clear negative", async (t) => {
  const live = await anyLiveBackend();
  if (!live) {
    t.skip("no local Laya service is listening on 8317 or 8318");
    return;
  }

  const probabilities: number[] = [];
  for (const state of [...POSITIVE, ...NEGATIVE]) {
    const output = await judge({ state, questions: QUESTION }, { chain: live.chain });
    const score = output.answers["satisfies"]?.score;
    assert.equal(typeof score, "number");
    probabilities.push(score as number);
  }

  const positives = probabilities.slice(0, POSITIVE.length);
  const negatives = probabilities.slice(POSITIVE.length);
  const worstPositive = Math.min(...positives);
  const bestNegative = Math.max(...negatives);

  assert.ok(
    worstPositive > 0.5,
    `${live.name}: every positive case should clear 0.5, got ${positives.map((p) => p.toFixed(3)).join(", ")}`
  );
  assert.ok(
    bestNegative < 0.5,
    `${live.name}: every negative case should stay under 0.5, got ${negatives.map((p) => p.toFixed(3)).join(", ")}`
  );
  // The plan's Milestone 7 asks for a measured calibration signal. A wide gap is what makes a fixed
  // threshold meaningful, which is the whole premise of the `absolute` calibration mode.
  assert.ok(
    worstPositive - bestNegative > 0.4,
    `${live.name}: the separation is too narrow to threshold (positive ${worstPositive.toFixed(3)} vs negative ${bestNegative.toFixed(3)})`
  );
});

test("the live response carries the fields this layer depends on", async (t) => {
  const live = await anyLiveBackend();
  if (!live) {
    t.skip("no local Laya service is listening");
    return;
  }

  const output = await judge(
    {
      state: "Duplicate charge on invoice #4411.",
      questions: {
        team: {
          type: "choice",
          instructions: "Which team should handle this?",
          criteria: { billing: "invoice and charge issues", support: "how-to questions" },
        },
        urgent: { type: "noul", instructions: "Is this urgent?" },
      },
    },
    { chain: live.chain }
  );

  assert.equal(output.calibration, "absolute");
  assert.ok(output.elapsedMs > 0);
  assert.ok(output.answers["team"]?.distribution, "a choice answer carries its distribution");
  assert.equal(typeof output.answers["team"]?.score, "number");
  assert.equal(typeof output.answers["urgent"]?.score, "number");

  const decisions = decide(
    {
      answers: {
        urgent: { id: "urgent", type: "noul", value: output.answers["urgent"]?.score as number },
      },
      backend: output.backend,
      usage: {},
      elapsedMs: output.elapsedMs,
    },
    { calibration: "absolute", threshold: 0.5 }
  );
  assert.equal(decisions.length, 1);
});

test("an explicit backend that is down fails instead of falling back", async (t) => {  const chain = BackendChain.fromConfig(configFor("laya", "http://127.0.0.1:8318"));
  try {
    await judge({ state: "x", questions: QUESTION, backend: "laya" }, { chain });
  } catch (error) {
    assert.ok(isSystemOneError(error));
    assert.ok(
      error.code === "unreachable" || error.code === "timeout",
      `expected an unreachable or timeout failure, got ${error.code}`
    );
    return;
  }
  t.skip("the reference service on 8318 happens to be running, so there is nothing to assert");
});

test("when two local services answer, they agree on clear-cut cases", async (t) => {
  // Milestone 7's agreement suite. Without labels, agreement between two backends on a fixed case set
  // is the cheapest calibration signal there is, and it is only meaningful against real models: the
  // encodings are pinned hermetically in conformance.test.ts. Both services are optional dependencies,
  // so this skips rather than fails when one of them is down.
  const live = await allLiveBackends();
  const [first, second] = live;
  if (!first || !second) {
    t.skip(`needs two local services, found ${live.map((entry) => entry.name).join(", ") || "none"}`);
    return;
  }

  const cases = [...POSITIVE, ...NEGATIVE];
  const scores: Record<string, number[]> = {};
  const passed: Record<string, boolean[]> = {};
  for (const entry of [first, second]) {
    scores[entry.name] = [];
    passed[entry.name] = [];
    for (const state of cases) {
      const output = await judge({ state, questions: QUESTION, threshold: 0.5 }, { chain: entry.chain });
      const decision = output.decisions?.[0];
      assert.ok(decision, `${entry.name}: a thresholded judgment produces a verdict`);
      scores[entry.name]?.push(decision.score);
      passed[entry.name]?.push(decision.passed);
    }
  }

  const firstPassed = passed[first.name] ?? [];
  const secondPassed = passed[second.name] ?? [];
  const verdictAgreement = cases.filter((_, index) => firstPassed[index] === secondPassed[index]).length / cases.length;
  assert.equal(
    verdictAgreement,
    1,
    `${first.name} vs ${second.name} disagree on clear-cut cases: ` +
      `${first.name} ${JSON.stringify(scores[first.name]?.map((score) => score.toFixed(2)))} vs ` +
      `${second.name} ${JSON.stringify(scores[second.name]?.map((score) => score.toFixed(2)))} ` +
      `(positives first, then negatives)`
  );

  // Agreement on verdicts is the claim; the mean absolute difference is the measurement behind it.
  const deltas = (scores[first.name] ?? []).map((score, index) => Math.abs(score - (scores[second.name]?.[index] ?? score)));
  const meanDelta = deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length;
  assert.ok(
    meanDelta <= 0.5,
    `${first.name} and ${second.name} agree on verdicts but differ by ${meanDelta.toFixed(3)} on average`
  );
});
