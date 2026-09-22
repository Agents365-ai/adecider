/**
 * The unified layer: one model namespace over every transport, served over one HTTP format.
 *
 * The fake backend stands in for a local service and reports checkpoints the way the real Laya
 * services do, so the catalogue is exercised the way it is exercised in production: model ids come
 * from the backend's own health probe rather than a list kept here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { modelCatalogue, resolveModel } from "../src/models.ts";
import { BackendChain } from "../src/backends/index.ts";
import { SystemOneError } from "../src/errors.ts";
import { judge } from "../src/judge.ts";
import { serve } from "../src/server/http.ts";
import type { SystemOneConfig } from "../src/config.ts";
import { isSystemOneError } from "../src/errors.ts";
import { startFakeLaya, type FakeLaya } from "./helpers/fake-laya.ts";

function chainOf(backends: SystemOneConfig["backends"], chain: string[], allowCloud = false): BackendChain {
  return BackendChain.fromConfig({ chain, backends, allowCloud, configPath: "<test>" });
}

/**
 * Two local services with different checkpoints resident plus one cloud model behind a key. They must
 * differ, or a bare model name is ambiguous and resolution is supposed to refuse it.
 */
function multiChain(main: FakeLaya, reference: FakeLaya): BackendChain {
  return chainOf(
    {
      "laya-mlx": { name: "laya-mlx", kind: "laya", baseUrl: main.url },
      laya: { name: "laya", kind: "laya", baseUrl: reference.url },
      jev: { name: "jev", kind: "jev", model: "jev-latest" },
    },
    ["laya-mlx", "laya"],
    true
  );
}

test("a qualified selector that names an excluded backend says why, not just that it is missing", async () => {
  const fake = await startFakeLaya({});
  try {
    const chain = chainOf(
      {
        local: { name: "local", kind: "laya", baseUrl: fake.url },
        jev: { name: "jev", kind: "jev", model: "jev-latest" },
      },
      ["local", "jev"],
      false
    );
    await assert.rejects(
      () => resolveModel(chain, "jev:jev-latest"),
      (error: unknown) => {
        assert.ok(error instanceof SystemOneError);
        assert.equal(error.code, "unconfigured");
        assert.match(
          error.message,
          /sends state off this machine/,
          "the privacy reason, not \"no backend named\""
        );
        return true;
      }
    );
  } finally {
    await fake.close();
  }
});

test("the catalogue lists every nameable model, with the window its checkpoint actually has", async () => {
  const fake = await startFakeLaya({
    health: { status: "ok", runtime: "mlx", device: "gpu", loaded: ["english"], checkpoints: ["english", "multilingual"] },
  });
  try {
    const reference = await startFakeLaya({
      health: { status: "ok", runtime: "mps", device: "mps", loaded: ["typed-decisions"], checkpoints: ["typed-decisions"] },
    });
    const chain = multiChain(fake, reference);
    const catalogue = await modelCatalogue(chain);
    const ids = catalogue.map((entry) => entry.id).sort();

    assert.deepEqual(ids, [
      "jev:jev-latest",
      "laya-mlx:english",
      "laya-mlx:multilingual",
      "laya:typed-decisions",
    ]);

    const english = catalogue.find((entry) => entry.id === "laya-mlx:english");
    const multilingual = catalogue.find((entry) => entry.id === "laya-mlx:multilingual");
    assert.equal(english?.contextTokens, 512);
    assert.equal(multilingual?.contextTokens, 1024, "per checkpoint, not per backend");
    assert.equal(english?.calibration, "absolute");

    const jev = catalogue.find((entry) => entry.id === "jev:jev-latest");
    assert.equal(jev?.cloud, true, "a cloud model is nameable without being automatic");
    assert.equal(chain.names().includes("jev"), false, "and it is not in the automatic chain");
    await reference.close();
  } finally {
    await fake.close();
  }
});

test("a cloud backend in the chain is dropped until cloud use is allowed explicitly", () => {
  const denied = chainOf({ jev: { name: "jev", kind: "jev", model: "jev-latest" } }, ["jev"], false);
  assert.deepEqual(denied.names(), [], "a key on disk is not consent to use it");
  assert.deepEqual(denied.allNames(), [], "and it is not nameable either, so --backend cannot reach it");
  assert.match(
    denied.skipped[0]?.reason ?? "",
    /sends state off this machine/,
    "the reason is reported rather than the backend disappearing silently"
  );

  const allowed = chainOf({ jev: { name: "jev", kind: "jev", model: "jev-latest" } }, ["jev"], true);
  assert.deepEqual(allowed.names(), ["jev"], "the same config with allowCloud answers");
});

test("a model can be named bare, qualified, or not at all", async () => {
  const fake = await startFakeLaya({
    health: { status: "ok", runtime: "mlx", device: "gpu", loaded: ["english"], checkpoints: ["english", "multilingual"] },
  });
  try {
    const reference = await startFakeLaya({
      health: { status: "ok", runtime: "mps", device: "mps", loaded: ["typed-decisions"], checkpoints: ["typed-decisions"] },
    });
    const chain = multiChain(fake, reference);

    const bare = await resolveModel(chain, "multilingual");
    assert.equal(bare?.backend.name, "laya-mlx", "the backend that serves it");
    assert.equal(bare?.checkpoint, "multilingual");
    const other = await resolveModel(chain, "typed-decisions");
    assert.equal(other?.backend.name, "laya");

    // Bare resolution is ambiguous when two services serve the same checkpoint.
    const ambiguous = chainOf(
      {
        a: { name: "a", kind: "laya", baseUrl: fake.url },
        b: { name: "b", kind: "laya", baseUrl: fake.url },
      },
      ["a", "b"]
    );
    await assert.rejects(
      () => resolveModel(ambiguous, "english"),
      (error: unknown) =>
        error instanceof SystemOneError &&
        error.code === "bad_request" &&
        /served by more than one backend/.test(error.message)
    );

    const qualified = await resolveModel(ambiguous, "b:english");
    assert.equal(qualified?.backend.name, "b", "a qualified selector needs no probe and no disambiguation");

    const unknown = await resolveModel(chain, "gpt-9-turbo");
    assert.equal(unknown, null, "an unenumerable id is passed through rather than rejected here");

    await assert.rejects(
      () => resolveModel(chain, "nope:english"),
      (error: unknown) => error instanceof SystemOneError && /no backend named "nope"/.test(error.message)
    );
    await reference.close();
  } finally {
    await fake.close();
  }
});

test("naming a model routes to its transport, and an unnamed request stays on the chain", async () => {
  const fake = await startFakeLaya({ echo: 0.8 });
  const reference = await startFakeLaya({ echo: 0.8 });
  try {
    const chain = multiChain(fake, reference);

    const named = await judge(
      { model: "laya-mlx:multilingual", state: "x", questions: { a: { type: "noul", instructions: "Is it true?" } } },
      { chain }
    );
    assert.equal(named.backend, "laya-mlx");
    assert.equal(fake.decideRequests[0]?.["model"], "multilingual", "the checkpoint reached the transport");

    const unnamed = await judge({ state: "x", questions: { a: { type: "noul", instructions: "Is it true?" } } }, { chain });
    assert.equal(unnamed.backend, "laya-mlx");
    assert.equal(fake.decideRequests[1]?.["model"], undefined, "no model means no forced checkpoint");
    await reference.close();
  } finally {
    await fake.close();
  }
});

test("a threshold against an uncalibrated model is refused before the call is spent", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  try {
    const chain = chainOf(
      { local27b: { name: "local27b", kind: "openai", baseUrl: `${fake.url}/v1`, model: "fake-chat-model" } },
      ["local27b"]
    );
    await assert.rejects(
      () =>
        judge(
          { state: "x", questions: { a: { type: "noul", instructions: "Is it true?" } }, threshold: 0.7 },
          { chain }
        ),
      (error: unknown) => error instanceof SystemOneError && error.code === "calibration"
    );
    assert.equal(fake.decideRequests.length, 0, "refusing costs nothing: no request was made");

    // The same request with a ranking rule is allowed through.
    const ranked = await judge(
      { state: "x", questions: { a: { type: "noul", instructions: "Is it true?" } }, topK: 1 },
      { chain }
    );
    assert.equal(ranked.decisions?.[0]?.passed, true);
  } finally {
    await fake.close();
  }
});

test("the HTTP endpoint serves every model behind one format", async () => {
  const fake = await startFakeLaya({
    echo: 0.9,
    health: { status: "ok", runtime: "mlx", device: "gpu", loaded: ["english"], checkpoints: ["english", "multilingual"] },
  });
  const reference = await startFakeLaya({
    health: { status: "ok", runtime: "mps", device: "mps", loaded: ["typed-decisions"], checkpoints: ["typed-decisions"] },
  });
  const chain = multiChain(fake, reference);
  const running = await serve({ port: 0, chain });
  try {
    const health = await (await fetch(`${running.url}/health`)).json() as Record<string, unknown>;
    assert.equal(health["status"], "ok");
    assert.deepEqual(health["automatic_chain"], ["laya-mlx", "laya"]);
    const backends = health["backends"] as Array<Record<string, unknown>>;
    const jev = backends.find((entry) => entry["name"] === "jev");
    assert.equal(jev?.["automatic"], false, "configured, nameable, and reported as not automatic");

    const models = await (await fetch(`${running.url}/models`)).json() as { models: Array<{ id: string }> };
    assert.ok(models.models.some((entry) => entry.id === "jev:jev-latest"));
    assert.ok(models.models.some((entry) => entry.id === "laya-mlx:multilingual"));

    // /route answers without spending a judgment.
    const before = fake.decideRequests.length;
    const route = await (
      await fetch(`${running.url}/route`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "laya-mlx:multilingual" }),
      })
    ).json() as Record<string, unknown>;
    assert.equal(route["model"], "laya-mlx:multilingual");
    assert.equal(route["checkpoint"], "multilingual");
    assert.equal(route["context_tokens"], 1024);
    assert.equal(fake.decideRequests.length, before, "/route spends no judgment");

    const decided = await (
      await fetch(`${running.url}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "english",
          state: "a duplicate charge",
          questions: { a: { type: "noul", instructions: "Is this billing?" } },
          threshold: 0.7,
        }),
      })
    ).json() as Record<string, unknown>;
    assert.equal(decided["backend"], "laya-mlx");
    assert.equal((decided["decisions"] as Array<Record<string, unknown>>)[0]?.["passed"], true);

    // A caller naming a backend that does not exist is the caller's mistake: 400, with a code.
    const refused = await fetch(`${running.url}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "x", questions: { a: { type: "noul", instructions: "y" } }, backend: "nope" }),
    });
    assert.equal(refused.status, 400);
    const refusedBody = await refused.json() as Record<string, unknown>;
    assert.equal(refusedBody["code"], "bad_request");

    const missing = await fetch(`${running.url}/nothing`);
    assert.equal(missing.status, 404);
    const missingBody = await missing.json() as Record<string, unknown>;
    assert.ok(Array.isArray(missingBody["routes"]), "a 404 says what the routes are");
  } finally {
    await running.close();
    await reference.close();
    await fake.close();
  }
});

test("a backend outage is a 502 with a code, not a generic failure", async () => {
  const down = chainOf(
    { dead: { name: "dead", kind: "laya", baseUrl: "http://127.0.0.1:1", timeoutMs: 300 } },
    ["dead"]
  );
  const running = await serve({ port: 0, chain: down });
  try {
    const response = await fetch(`${running.url}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "x", questions: { a: { type: "noul", instructions: "y" } } }),
    });
    assert.equal(response.status, 502);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body["code"], "unreachable");
    assert.match(String(body["error"]), /no backend in the chain answered a health probe/);

    // Health stays 200 and reports the outage, so a probe never has to guess from a failure.
    const health = await fetch(`${running.url}/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json() as Record<string, unknown>;
    const backends = healthBody["backends"] as Array<Record<string, unknown>>;
    assert.equal(backends[0]?.["ok"], false);
  } finally {
    await running.close();
  }
});

test("an endpoint that is not an http URL is refused when the backend is built", () => {
  assert.throws(
    () => chainOf({ odd: { name: "odd", kind: "laya", baseUrl: "htp://127.0.0.1:8317" } }, ["odd"]),
    (error: unknown) => {
      assert.ok(isSystemOneError(error));
      assert.equal(error.code, "unconfigured");
      assert.match(error.message, /endpoint must be http or https, found "htp:"/);
      return true;
    },
    "a scheme typo fails where it can be explained, not as an opaque fetch failure later"
  );

  assert.throws(
    () => chainOf({ odd: { name: "odd", kind: "openai", baseUrl: "file:///etc/passwd", model: "m" } }, ["odd"]),
    (error: unknown) => isSystemOneError(error) && /must be http or https/.test(error.message)
  );

  assert.throws(
    () => chainOf({ odd: { name: "odd", kind: "laya", baseUrl: "127.0.0.1:8317" } }, ["odd"]),
    (error: unknown) => isSystemOneError(error) && /not a URL/.test(error.message)
  );

  // A normal endpoint and a built-in default are unaffected.
  assert.ok(chainOf({ ok: { name: "ok", kind: "laya", baseUrl: "http://127.0.0.1:8317" } }, ["ok"]).get("ok"));
  assert.ok(chainOf({ jev: { name: "jev", kind: "jev", model: "jev-latest" } }, ["jev"], true).get("jev"));
});
