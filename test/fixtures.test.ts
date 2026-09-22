/**
 * The captured wire evidence is load-bearing, not decoration.
 *
 * `fixtures/laya-mlx/` holds payloads recorded from the live service on 2026-09-21 with curl, which
 * is the only durable record of what the backend actually sends, including its error bodies. If a
 * future Laya release changes any of them, these tests fail before a user sees a wrong verdict.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeFamilyResponse } from "../src/normalize.ts";
import { SystemOneError } from "../src/errors.ts";

const DIR = path.resolve(fileURLToPath(import.meta.url), "../../fixtures/laya-mlx");

function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(DIR, name), "utf8")) as unknown;
}

test("the captured decide payload normalizes into three typed answers", () => {
  const response = normalizeFamilyResponse("laya-mlx", fixture("decide-3primitives.json"), 0);

  assert.equal(response.label, "laya-rl-agent");
  assert.equal(response.model, "english", "read off routing.model");
  assert.equal(response.routing?.reason, "English Latin text");
  assert.deepEqual(Object.keys(response.answers).sort(), ["churn_risk", "department", "urgency"]);

  assert.equal(response.answers["department"]?.type, "choice");
  assert.equal(response.answers["urgency"]?.type, "score");
  assert.equal(response.answers["churn_risk"]?.type, "noul");
  assert.equal(response.usage.inputTokens, 154);
  assert.equal(response.elapsedMs, 45.4);
});

test("both captured error bodies become bad_request with the backend's own message", () => {
  const missingState = fixture("error-missing-state.json");
  assert.throws(
    () => normalizeFamilyResponse("laya-mlx", missingState, 0),
    (error: unknown) =>
      error instanceof SystemOneError &&
      error.code === "bad_request" &&
      /request is missing 'state'/.test(error.message)
  );

  const unknownPreset = fixture("error-preset.json");
  assert.throws(
    () => normalizeFamilyResponse("laya-mlx", unknownPreset, 0),
    (error: unknown) =>
      error instanceof SystemOneError &&
      error.code === "bad_request" &&
      /unknown preset 'nope'/.test(error.message)
  );
});

test("the captured health payload has the fields the probe reads", () => {
  const health = fixture("health.json") as Record<string, unknown>;
  assert.equal(health["status"], "ok");
  assert.equal(health["runtime"], "mlx");
  assert.equal(typeof health["device"], "string");
  assert.ok(Array.isArray(health["loaded"]));
});
