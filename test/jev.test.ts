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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { judge } from "../src/judge.ts";
import { isSystemOneError } from "../src/errors.ts";
import { BackendChain } from "../src/backends/index.ts";
import { createJevBackend } from "../src/backends/jev.ts";
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

/** A server that accepts a request and never answers, so the client's own timeout is what fires. */
async function startHangingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const { createServer } = await import("node:http");
  const server = createServer(() => {
    // Deliberately no response: an endpoint that stalls is the case a timeout has to cover.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/decide`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("the key is found in the spec, the environment, or the secret file, and its absence says so", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  const saved = {
    key: process.env["TYPESAFE_API_KEY"],
    model: process.env["TYPESAFE_DEFAULT_MODEL"],
    home: process.env["HOME"],
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "adecider-home-"));
  const jevAt = (name: string) => {
    const config: SystemOneConfig = {
      chain: [name],
      backends: { [name]: { name, kind: "jev", baseUrl: `${fake.url}/decide` } },
      allowCloud: true,
      configPath: "<test>",
    };
    return BackendChain.fromConfig(config);
  };

  try {
    // The key in the config wins, and is never reported as coming from anywhere else.
    const explicit = chainFor(fake);
    assert.match((await explicit.health("jev")).detail, /key from configured/);

    process.env["TYPESAFE_API_KEY"] = "env-key";
    process.env["TYPESAFE_DEFAULT_MODEL"] = "jev-from-env";
    delete process.env["HOME"];
    process.env["HOME"] = home;
    const fromEnv = jevAt("jev");
    const envHealth = await fromEnv.health("jev");
    assert.equal(envHealth.ok, true);
    assert.match(envHealth.detail, /key from \$TYPESAFE_API_KEY/);
    assert.deepEqual(envHealth.models, ["jev-from-env"], "a configured default model is reported");
    assert.equal((await judge({ state: "x", questions: QUESTION }, { chain: fromEnv })).backend, "jev");

    // No environment key: the secret file is next, and then there is nothing.
    delete process.env["TYPESAFE_API_KEY"];
    delete process.env["TYPESAFE_DEFAULT_MODEL"];
    const secret = path.join(home, ".pi", "agent", "secrets", "typesafe_api_key");
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.writeFileSync(secret, "file-key\n");
    const fromFile = jevAt("jev");
    assert.match((await fromFile.health("jev")).detail, /key from ~\/.pi\/agent\/secrets\/typesafe_api_key/);
    assert.equal((await judge({ state: "x", questions: QUESTION }, { chain: fromFile })).backend, "jev");

    fs.rmSync(secret);
    const none = jevAt("jev");
    const emptyHealth = await none.health("jev");
    assert.equal(emptyHealth.ok, false);
    assert.match(emptyHealth.detail, /no API key; set TYPESAFE_API_KEY or write/);

    // Without a name, the health probe is what decides, so the failure is that nothing in the chain
    // can answer, and the missing key is the reason it reports.
    await assert.rejects(
      judge({ state: "x", questions: QUESTION }, { chain: none }),
      (error: unknown) => {
        assert.ok(isSystemOneError(error));
        assert.equal(error.code, "unreachable");
        assert.match(error.message, /no API key; set TYPESAFE_API_KEY or write/);
        return true;
      }
    );

    // Naming the backend skips the health gate and reaches the adapter, which says what is missing.
    await assert.rejects(
      judge({ state: "x", questions: QUESTION, backend: "jev" }, { chain: none }),
      (error: unknown) => {
        assert.ok(isSystemOneError(error));
        assert.equal(error.code, "unconfigured");
        assert.match(error.message, /add an apiKey for this backend in/);
        return true;
      }
    );
  } finally {
    if (saved.key === undefined) delete process.env["TYPESAFE_API_KEY"];
    else process.env["TYPESAFE_API_KEY"] = saved.key;
    if (saved.model === undefined) delete process.env["TYPESAFE_DEFAULT_MODEL"];
    else process.env["TYPESAFE_DEFAULT_MODEL"] = saved.model;
    process.env["HOME"] = saved.home;
    fs.rmSync(home, { recursive: true, force: true });
    await fake.close();
  }
});

test("a stalled call is a timeout and a refused connection is unreachable", async () => {
  const hanging = await startHangingServer();
  try {
    const stalled = BackendChain.fromConfig({
      chain: ["jev"],
      backends: { jev: { name: "jev", kind: "jev", baseUrl: hanging.url, apiKey: KEY, model: "jev-latest", timeoutMs: 300 } },
      allowCloud: true,
      configPath: "<test>",
    });
    await assert.rejects(
      judge({ state: "x", questions: QUESTION }, { chain: stalled }),
      (error: unknown) => {
        assert.ok(isSystemOneError(error));
        assert.equal(error.code, "timeout", "a server that never answers is not the caller's mistake");
        assert.match(error.message, /jev call failed/);
        return true;
      }
    );
  } finally {
    await hanging.close();
  }

  const refused = BackendChain.fromConfig({
    chain: ["jev"],
    backends: { jev: { name: "jev", kind: "jev", baseUrl: "http://127.0.0.1:9/decide", apiKey: KEY, timeoutMs: 1200 } },
    allowCloud: true,
    configPath: "<test>",
  });
  await assert.rejects(
    judge({ state: "x", questions: QUESTION }, { chain: refused }),
    (error: unknown) => {
      assert.ok(isSystemOneError(error));
      assert.equal(error.code, "unreachable");
      return true;
    }
  );
});

test("the key only goes to the vendor API or loopback, checked before any call", () => {
  const build = (baseUrl: string) =>
    BackendChain.fromConfig({
      chain: ["jev"],
      backends: { jev: { name: "jev", kind: "jev", baseUrl, apiKey: KEY, model: "jev-latest" } },
      allowCloud: true,
      configPath: "<test>",
    });

  assert.throws(
    () => build("https://typesafe-lookalike.example.com/v1/systemone"),
    (error: unknown) => {
      assert.ok(isSystemOneError(error));
      assert.equal(error.code, "unconfigured");
      assert.match(error.message, /would send its API key to "typesafe-lookalike\.example\.com"/);
      assert.match(error.message, /allowed hosts are api\.typesafe\.ai and loopback/);
      return true;
    },
    "a host that is not the vendor API is refused, not called with the key attached"
  );

  // The endpoints that have a reason to exist still build: a stand-in on loopback, and the default.
  assert.ok(build("http://127.0.0.1:8319/decide").get("jev"));
  assert.ok(build("http://localhost:8319/decide").get("jev"));
  assert.ok(
    BackendChain.fromConfig({
      chain: ["jev"],
      backends: { jev: { name: "jev", kind: "jev", apiKey: KEY, model: "jev-latest" } },
      allowCloud: true,
      configPath: "<test>",
    }).get("jev"),
    "the built-in vendor endpoint is the default and needs no declaration"
  );
});

test("a factory imported directly refuses an endpoint it cannot even parse", () => {
  // Every path through a chain checks the scheme first, so this covers the adapter's own guard.
  assert.throws(
    () => createJevBackend({ name: "jev", kind: "jev", baseUrl: "not a url at all", apiKey: KEY }),
    (error: unknown) => {
      assert.ok(isSystemOneError(error));
      assert.equal(error.code, "unconfigured");
      assert.match(error.message, /has an endpoint that is not a URL/);
      return true;
    }
  );
});
