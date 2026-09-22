/**
 * The local Laya adapter, against a stand-in: the two payload dialects it must read, and the failures
 * it must name.
 *
 * The service is a local process that someone else starts, so its failure modes are the ones that
 * actually show up in use: it is not running, it answers a health probe with something unexpected, it
 * answers with an HTML error page, or it rejects a request without saying why. Each case has to reach
 * the caller as a typed code that says which of those happened.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { judge, type JudgeOutput } from "../src/judge.ts";
import { isSystemOneError, type SystemOneError } from "../src/errors.ts";
import { BackendChain } from "../src/backends/index.ts";
import type { SystemOneConfig } from "../src/config.ts";
import { startFakeLaya } from "./helpers/fake-laya.ts";

const QUESTION = { keep: { type: "noul" as const, instructions: "Is the state worth keeping?" } };

function chainFor(baseUrl: string, extra: Record<string, unknown> = {}): BackendChain {
  const config: SystemOneConfig = {
    chain: ["laya"],
    backends: { laya: { name: "laya", kind: "laya", baseUrl, ...extra } },
    allowCloud: false,
    configPath: "<test>",
  };
  return BackendChain.fromConfig(config);
}

async function failsWith(chain: BackendChain, code: string): Promise<SystemOneError> {
  try {
    await judge({ state: "state", questions: QUESTION }, { chain });
  } catch (error) {
    assert.ok(isSystemOneError(error), `expected a typed failure, got ${String(error)}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  throw new Error(`expected a ${code} failure, but the judgment succeeded`);
}

test("a health probe reports what the service loaded, and why it is unusable otherwise", async () => {
  const healthy = await startFakeLaya({
    health: { status: "ok", runtime: "mlx", device: "gpu", loaded: ["english"], checkpoints: ["english", "multilingual"] },
  });
  try {
    const health = await chainFor(healthy.url).health("laya");
    assert.equal(health.ok, true);
    assert.match(health.detail, /mlx on gpu/);
    assert.match(health.detail, /loaded english/);
    assert.deepEqual(health.models, ["english", "multilingual"], "every resident checkpoint is nameable");
  } finally {
    await healthy.close();
  }

  const refusing = await startFakeLaya({ healthStatus: 503 });
  try {
    const health = await chainFor(refusing.url).health("laya");
    assert.equal(health.ok, false);
    assert.match(health.detail, /HTTP 503 from/);
  } finally {
    await refusing.close();
  }

  // A 200 that is not this service's shape: reported as unexpected rather than read as healthy.
  const odd = await startFakeLaya({ health: { status: "degraded" } });
  try {
    const health = await chainFor(odd.url).health("laya");
    assert.equal(health.ok, false);
    assert.match(health.detail, /unexpected health payload from/);
    assert.equal(health.models, undefined, "no checkpoints are invented from a payload that has none");
  } finally {
    await odd.close();
  }
});

test("a rejection without an error field still names the status it got", async () => {
  const html = await startFakeLaya({ decideRaw: "<html><body>502 Bad Gateway</body></html>" });
  try {
    const error = await failsWith(chainFor(html.url), "bad_response");
    assert.match(error.message, /returned a non-JSON body/);
  } finally {
    await html.close();
  }

  const broken = await startFakeLaya({ status: 500 });
  try {
    const error = await failsWith(chainFor(broken.url), "busy");
    assert.match(error.message, /rejected the request: HTTP 500/, "the status is the only detail there is");
  } finally {
    await broken.close();
  }
});

test("a preset is forwarded as the request dialect expects, instead of questions", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  try {
    const output: JudgeOutput = await judge(
      {
        state: "a duplicate charge",
        preset: "triage",
        questions: { keep: { type: "noul", instructions: "Is the state worth keeping?" } },
      },
      { chain: chainFor(fake.url) }
    );

    const sent = fake.decideRequests[0];
    assert.equal(sent?.["preset"], "triage");
    assert.ok(sent?.["questions"], "the questions go too, so the caller still controls the ids it reads");
    assert.equal(output.answers["keep"]?.score, 0.9);
  } finally {
    await fake.close();
  }
});
