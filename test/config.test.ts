/**
 * Configuration resolution: what is reachable, what may be used automatically, and in what order.
 *
 * This is the layer where a privacy decision is made (a cloud backend is skipped until cloud use is
 * allowed) and where an environment override can silently change which backend answers. Both are
 * worth pinning, including the ugly cases: a config file that is not JSON, an environment chain that
 * is only commas and spaces, and a boolean that is spelled in a way this layer does not recognize.
 *
 * Every test here sets and restores the environment variables it uses, because `loadConfig` reads the
 * process environment and a leaked variable would change what other tests see.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CHAIN, loadConfig } from "../src/config.ts";

const VARIABLES = ["ADECIDER_CONFIG", "ADECIDER_CHAIN", "ADECIDER_ALLOW_CLOUD"] as const;

/** Run one case with a private environment, a private home, and no config file unless given one. */
function withConfig(contents: string | undefined, env: Partial<Record<(typeof VARIABLES)[number], string>>, run: (configPath: string) => void): void {
  const saved = VARIABLES.map((name) => [name, process.env[name]] as const);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adecider-config-"));
  const configPath = path.join(dir, "adecider.json");
  if (contents !== undefined) fs.writeFileSync(configPath, contents);
  process.env["ADECIDER_CONFIG"] = configPath;
  delete process.env["ADECIDER_CHAIN"];
  delete process.env["ADECIDER_ALLOW_CLOUD"];
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) process.env[name] = value;
  }
  try {
    run(configPath);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("with nothing configured, the chain is local and cloud use is off", () => {
  withConfig(undefined, {}, () => {
    const config = loadConfig();
    assert.deepEqual(config.chain, DEFAULT_CHAIN);
    assert.deepEqual(config.chain, ["laya-mlx", "laya"]);
    assert.equal(config.allowCloud, false, "a local service being down is not consent to use a cloud one");
    assert.deepEqual(Object.keys(config.backends).sort(), ["jev", "laya", "laya-mlx"]);
  });
});

test("a config file merges over the known backends instead of replacing them", () => {
  withConfig(
    JSON.stringify({
      chain: ["local27b"],
      allowCloud: true,
      backends: { local27b: { kind: "openai", baseUrl: "http://127.0.0.1:8090/v1", model: "Ternary-Bonsai-2-27B" } },
    }),
    {},
    (configPath) => {
      const config = loadConfig();
      assert.deepEqual(config.chain, ["local27b"], "a declared backend can be the whole chain");
      assert.equal(config.allowCloud, true);
      assert.equal(config.backends["local27b"]?.model, "Ternary-Bonsai-2-27B");
      assert.ok(config.backends["laya-mlx"], "the built-in definitions are still there to name");
      assert.equal(config.configPath, configPath);
    }
  );
});

test("a config file this layer cannot read leaves the defaults standing", () => {
  withConfig("{ not json at all", {}, () => {
    const config = loadConfig();
    assert.deepEqual(config.chain, DEFAULT_CHAIN);
    assert.equal(config.allowCloud, false);
  });

  // A directory where a file was expected is unreadable in the other direction, and is not an error.
  withConfig(undefined, {}, (configPath) => {
    fs.rmSync(configPath, { force: true });
    fs.mkdirSync(configPath);
    assert.deepEqual(loadConfig().chain, DEFAULT_CHAIN);
  });
});

test("the environment overrides the file, for the chain and for cloud use", () => {
  withConfig(JSON.stringify({ chain: ["laya"], allowCloud: false }), { ADECIDER_CHAIN: " jev , laya-mlx , ", ADECIDER_ALLOW_CLOUD: "true" }, () => {
    const config = loadConfig();
    assert.deepEqual(config.chain, ["jev", "laya-mlx"], "entries are trimmed and empty ones dropped");
    assert.equal(config.allowCloud, true);
    assert.equal(config.backends["jev"]?.kind, "jev", "the override names configured backends, it does not declare them");
  });

  withConfig(JSON.stringify({ chain: ["laya"], allowCloud: true }), { ADECIDER_CHAIN: "   ", ADECIDER_ALLOW_CLOUD: "off" }, () => {
    const config = loadConfig();
    assert.deepEqual(config.chain, ["laya"], "a blank override is ignored rather than emptying the chain");
    assert.equal(config.allowCloud, false);
  });
});

test("cloud consent accepts the spellings it documents and ignores the rest", () => {
  for (const [value, expected] of [["1", true], ["TRUE", true], ["yes", true], ["on", true], ["0", false], ["No", false], ["off", false]] as const) {
    withConfig(JSON.stringify({ allowCloud: !expected }), { ADECIDER_ALLOW_CLOUD: value }, () => {
      assert.equal(loadConfig().allowCloud, expected, `${JSON.stringify(value)} should mean ${expected}`);
    });
  }

  withConfig(JSON.stringify({ allowCloud: true }), { ADECIDER_ALLOW_CLOUD: "maybe" }, () => {
    assert.equal(loadConfig().allowCloud, true, "a spelling this layer does not know is not a false");
  });
});

test("a config path can be passed in, which is what the tests and the CLI both rely on", () => {
  const saved = process.env["ADECIDER_CONFIG"];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adecider-config-explicit-"));
  const configPath = path.join(dir, "other.json");
  fs.writeFileSync(configPath, JSON.stringify({ chain: ["laya"] }));
  delete process.env["ADECIDER_CONFIG"];
  try {
    const config = loadConfig({ configPath });
    assert.deepEqual(config.chain, ["laya"]);
    assert.equal(config.configPath, configPath, "the explicit path is the one reported back");
  } finally {
    if (saved !== undefined) process.env["ADECIDER_CONFIG"] = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a config file opts a harness feature in, and only an explicit true counts", () => {
  withConfig(
    JSON.stringify({
      chain: ["laya-mlx"],
      harness: { compact: true, toolGuard: false, auto: "yes", nonsense: true },
    }),
    {},
    () => {
      assert.deepEqual(
        loadConfig().harness,
        { compact: true },
        "false, a string, and an unknown key are all not an opt-in"
      );
    }
  );
  withConfig(undefined, {}, () => {
    assert.deepEqual(loadConfig().harness, {}, "no config file means every automatic feature is off");
  });
  withConfig("{ not json", {}, () => {
    assert.deepEqual(loadConfig().harness, {}, "a config that cannot be read opts nothing in");
  });
});
