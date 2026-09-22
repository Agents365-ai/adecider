/**
 * The CLI contract, over the real entry points.
 *
 * README promises a pipeable stdout (JSON and nothing else), diagnostics on stderr, exit 2 for a
 * typed failure from `adecider`, and 0 pass / 1 fail / 2 error from `adecider-gate`. None of that is
 * visible to a unit test, so the entry points are spawned the way a CI step or a subagent acceptance
 * check runs them, against the fake Laya service, with a config file in a temp directory so the
 * machine's own chain is never touched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeLaya } from "./helpers/fake-laya.ts";

const REPO = path.resolve(fileURLToPath(import.meta.url), "../..");
const MAIN = path.join(REPO, "src/cli/main.ts");
const GATE = path.join(REPO, "src/cli/gate.ts");

const QUESTIONS = JSON.stringify({
  satisfies: { type: "noul", instructions: "Does the state report a refund?" },
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** One temp config file per instance, so a test never reads the machine's own chain. */
class Cli {
  readonly dir: string;
  private readonly configPath: string;

  constructor(config: Record<string, unknown>) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "adecider-cli-"));
    this.configPath = path.join(this.dir, "adecider.json");
    fs.writeFileSync(this.configPath, JSON.stringify(config));
  }

  /** Point the same temp config at a different backend, for the outage cases. */
  repoint(config: Record<string, unknown>): void {
    fs.writeFileSync(this.configPath, JSON.stringify(config));
  }

  run(entry: string, args: string[]): Promise<CliResult> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [entry, ...args], {
        cwd: REPO,
        env: { ...process.env, ADECIDER_CONFIG: this.configPath },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }

  cleanup(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

function localChain(baseUrl: string): Record<string, unknown> {
  return { chain: ["fake"], allowCloud: false, backends: { fake: { kind: "laya", baseUrl } } };
}

const DEAD = { chain: ["fake"], allowCloud: false, backends: { fake: { kind: "laya", baseUrl: "http://127.0.0.1:9", timeoutMs: 1200 } } };

test("judge prints one JSON document on stdout, and a verdict only when a rule was given", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  const cli = new Cli(localChain(fake.url));
  try {
    const plain = await cli.run(MAIN, ["judge", "--state", "refunded twice", "--questions", QUESTIONS]);
    assert.equal(plain.code, 0);
    assert.equal(plain.stderr, "", "diagnostics stay off a clean run");
    const output = JSON.parse(plain.stdout) as Record<string, unknown>;
    assert.equal(output["backend"], "fake");
    assert.equal(output["decisions"], undefined, "no cutoff was asked for, so no pass/fail is invented");

    const thresholded = await cli.run(MAIN, ["judge", "--state", "refunded twice", "--questions", QUESTIONS, "--threshold", "0.7", "--json"]);
    assert.equal(thresholded.code, 0);
    const decisions = (JSON.parse(thresholded.stdout) as { decisions: Array<{ id: string; passed: boolean; score: number }> }).decisions;
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.id, "satisfies");
    assert.equal(decisions[0]?.score, 0.9);
    assert.equal(decisions[0]?.passed, true);
  } finally {
    cli.cleanup();
    await fake.close();
  }
});

test("judge refuses a malformed question before spending a request, and keeps stdout empty", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  const cli = new Cli(localChain(fake.url));
  try {
    const result = await cli.run(MAIN, [
      "judge",
      "--state", "refunded twice",
      "--questions", JSON.stringify({ pick: { type: "choice", instructions: "Which team?" } }),
    ]);
    assert.equal(result.code, 2, "a typed failure is exit 2");
    assert.equal(result.stdout, "", "nothing on stdout, so a pipe sees no partial document");
    assert.match(result.stderr, /bad_request/);
    assert.match(result.stderr, /choice question "pick" needs a non-empty criteria object/);
    assert.equal(fake.decideRequests.length, 0, "validation happens before the backend is called");
  } finally {
    cli.cleanup();
    await fake.close();
  }
});

test("judge reports an outage as unreachable rather than answering from another backend", async () => {
  const cli = new Cli(DEAD);
  try {
    const result = await cli.run(MAIN, ["judge", "--state", "x", "--questions", QUESTIONS]);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /unreachable/);
    assert.match(result.stderr, /http:\/\/127\.0\.0\.1:9\/health/);
  } finally {
    cli.cleanup();
  }
});

test("gate maps a judgment onto 0 pass, 1 fail, and prints the probability either way", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  const cli = new Cli(localChain(fake.url));
  const args = (threshold: string) => [
    GATE,
    "-c", "the state reports a refund",
    "--state", "refunded twice",
    "--threshold", threshold,
  ];
  try {
    const pass = await cli.run(GATE, args("0.7"));
    assert.equal(pass.code, 0);
    assert.equal(pass.stdout, "gate PASS probability=0.900 threshold=0.7 backend=fake\n");

    const fail = await cli.run(GATE, args("0.95"));
    assert.equal(fail.code, 1);
    assert.match(fail.stdout, /^gate FAIL probability=0\.900/);
  } finally {
    cli.cleanup();
    await fake.close();
  }
});

test("gate --json keeps the verdict and the payload a caller needs, under one id", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  const cli = new Cli(localChain(fake.url));
  try {
    const result = await cli.run(GATE, [
      GATE,
      "-c", "the state reports a refund",
      "--state", "refunded twice",
      "--json",
    ]);
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout) as { output: { backend: string; usage: unknown }; decision: { id: string; passed: boolean; score: number } };
    assert.equal(payload.output.backend, "fake");
    assert.equal(payload.decision.id, "gate_passed");
    assert.equal(payload.decision.score, 0.9);
    assert.equal(payload.decision.passed, true);
  } finally {
    cli.cleanup();
    await fake.close();
  }
});

test("gate separates an outage from a verdict: exit 2 by default, exit 0 and loud with --fail-open", async () => {
  const cli = new Cli(DEAD);
  try {
    const closed = await cli.run(GATE, [GATE, "-c", "the state reports a refund", "--state", "refunded twice"]);
    assert.equal(closed.code, 2);
    assert.equal(closed.stdout, "");
    assert.match(closed.stderr, /gate error: unreachable/);

    const open = await cli.run(GATE, [GATE, "-c", "the state reports a refund", "--state", "refunded twice", "--fail-open"]);
    assert.equal(open.code, 0);
    assert.match(open.stdout, /gate PASS \(fail-open, no verdict produced\)/);
    assert.match(open.stderr, /gate fail-open: unreachable/, "an outage is never silently a verdict");
  } finally {
    cli.cleanup();
  }
});

test("models --json reports what can be reached, and the chain that answers unnamed requests", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  const cli = new Cli(localChain(fake.url));
  try {
    const result = await cli.run(MAIN, ["models", "--json"]);
    assert.equal(result.code, 0);
    const catalogue = JSON.parse(result.stdout) as {
      automatic_chain: string[];
      models: Array<{ id: string; backend: string; calibration: string; cloud: boolean; contextTokens: number }>;
    };
    assert.deepEqual(catalogue.automatic_chain, ["fake"]);
    assert.equal(catalogue.models.length, 1, "a backend that answers no probe contributes no row");
    assert.equal(catalogue.models[0]?.id, "fake:english");
    assert.equal(catalogue.models[0]?.calibration, "absolute");
    assert.equal(catalogue.models[0]?.cloud, false);
    assert.equal(catalogue.models[0]?.contextTokens, 512, "the window is the answering checkpoint's");
  } finally {
    cli.cleanup();
    await fake.close();
  }
});

test("status --json reports health, calibration, and which backend answers unnamed requests", async () => {
  const fake = await startFakeLaya({ echo: 0.9 });
  const cli = new Cli(localChain(fake.url));
  try {
    const result = await cli.run(MAIN, ["status", "--json"]);
    assert.equal(result.code, 0);
    const status = JSON.parse(result.stdout) as {
      chain: string[];
      allowCloud: boolean;
      backends: Array<{ name: string; ok: boolean; calibration: string; cloud: boolean; automatic: boolean }>;
    };
    const entry = status.backends.find((backend) => backend.name === "fake");
    assert.ok(entry, "the configured chain is what status reports on");
    assert.equal(entry.ok, true);
    assert.equal(entry.calibration, "absolute");
    assert.equal(entry.cloud, false);
    assert.equal(entry.automatic, true);
    assert.deepEqual(status.chain, ["fake"]);
    assert.equal(status.allowCloud, false);
  } finally {
    cli.cleanup();
    await fake.close();
  }
});

test("mcp-config prints blocks a client can paste, for each client's own config format", async () => {
  const cli = new Cli(DEAD);
  try {
    const result = await cli.run(MAIN, ["mcp-config"]);
    assert.equal(result.code, 0);

    const block = result.stdout.match(/\{[\s\S]*"mcpServers"[\s\S]*?\n\}/);
    assert.ok(block, "the JSON block is delimited well enough to extract");
    const entry = (JSON.parse(block[0]) as { mcpServers: { adecider: { command: string; args: string[] } } }).mcpServers["adecider"];
    assert.equal(entry?.command, "node");
    assert.equal(path.resolve(entry?.args[0] ?? ""), path.join(REPO, "src/mcp/server.ts"));
    assert.match(result.stdout, /\[mcp_servers\.adecider\]/, "Codex gets a TOML table");
    assert.match(result.stdout, /command = "node"/);
  } finally {
    cli.cleanup();
  }
});
