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

function configFor(name: string, baseUrl: string): SystemOneConfig {
  return {
    chain: [name],
    backends: { [name]: { name, kind: "laya", baseUrl, timeoutMs: 30_000 } },
    allowCloud: false,
    configPath: "<live>",
  };
}

async function anyLiveBackend(): Promise<{ name: string; chain: BackendChain } | null> {
  for (const candidate of CANDIDATES) {
    const chain = BackendChain.fromConfig(configFor(candidate.name, candidate.baseUrl));
    const health = await chain.health(candidate.name);
    if (health.ok) return { name: candidate.name, chain };
  }
  return null;
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

test("an explicit backend that is down fails instead of falling back", async (t) => {
  const chain = BackendChain.fromConfig(configFor("laya", "http://127.0.0.1:8318"));
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
