#!/usr/bin/env node
/**
 * `adecider` CLI: inspect the backend chain, run a judgment, or print MCP client config.
 *
 * Exit codes: 0 success, 2 a typed failure (unreachable backend, invalid request, refused
 * calibration). stdout carries JSON only, so the output is pipeable; diagnostics go to stderr.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describeError } from "../errors.ts";
import { judge } from "../judge.ts";
import { BackendChain } from "../backends/index.ts";
import { loadConfig } from "../config.ts";
import { modelCatalogue } from "../models.ts";
import { serve } from "../server/http.ts";
import { numberFlag, parseArgs } from "./args.ts";
import { questionsFrom, stateFrom } from "./io.ts";

const SERVER_ENTRY = path.resolve(fileURLToPath(import.meta.url), "../../mcp/server.ts");

const USAGE = `adecider: typed System One decisions for any agent

  adecider models [--json]
      List every model that can be named, how it is reached, and its request window.

  adecider status [--json]
      Probe every backend and print health, calibration, and whether it is local.

  adecider judge --questions <json|@file> [--state <text> | --state-file <path> | --state-json <json>]
                   [--model <id> | --backend <name>] [--preset <name>]
                   [--threshold <n> | --top-k <n>] [--min-confidence <n>] [--allow-uncalibrated]
      Run one judgment and print the normalized result as JSON.

  adecider serve [--host <addr>] [--port <n>] [--verbose]
      Serve every model behind one HTTP format: GET /health, GET /models,
      POST /route, POST /decide.

  adecider mcp-config [--name <server-name>]
      Print ready-to-paste MCP client config for pi, Claude Code, and Codex.

A model may be named bare (english) or qualified by transport (laya-mlx:english,
jev:jev-latest). The automatic chain is local by default: ~/.pi/agent/adecider.json,
overridden by ADECIDER_CHAIN and ADECIDER_ALLOW_CLOUD.
`;

function renderModels(
  entries: Array<{
    id: string;
    backend: string;
    checkpoint: string;
    kind: string;
    calibration: string;
    cloud: boolean;
    contextTokens: number;
    detail: string;
  }>,
  chainNames: string[],
  asJson: boolean
): string {
  if (asJson) return `${JSON.stringify({ automatic_chain: chainNames, models: entries }, null, 2)}\n`;
  if (entries.length === 0) {
    return `No model is reachable. Check that a local service is running, or run \`adecider status\`.\nconfig: ${loadConfig().configPath}\n`;
  }

  const rows = entries.map((entry) => ({
    model: entry.id,
    transport: entry.kind,
    calibration: entry.calibration,
    scope: entry.cloud ? "cloud" : "local",
    window: String(entry.contextTokens),
    automatic: chainNames.includes(entry.backend) ? "yes" : "no",
  }));
  const width = (key: keyof (typeof rows)[number], header: string) =>
    Math.max(header.length, ...rows.map((row) => row[key].length));
  const w = {
    model: width("model", "MODEL"),
    transport: width("transport", "KIND"),
    calibration: width("calibration", "CALIBRATION"),
    scope: width("scope", "SCOPE"),
    window: width("window", "WINDOW"),
    automatic: width("automatic", "AUTO"),
  };

  const lines = [
    `${'MODEL'.padEnd(w.model)}  ${'KIND'.padEnd(w.transport)}  ${'CALIBRATION'.padEnd(w.calibration)}  ${'SCOPE'.padEnd(w.scope)}  ${'WINDOW'.padEnd(w.window)}  ${'AUTO'.padEnd(w.automatic)}`,
  ];
  for (const row of rows) {
    lines.push(
      `${row.model.padEnd(w.model)}  ${row.transport.padEnd(w.transport)}  ${row.calibration.padEnd(w.calibration)}  ${row.scope.padEnd(w.scope)}  ${row.window.padEnd(w.window)}  ${row.automatic.padEnd(w.automatic)}`
    );
  }
  lines.push(
    "",
    "AUTO=yes means the model answers when no model is named. Others must be named explicitly.",
    `automatic chain: ${chainNames.join(" -> ") || "(empty)"}`
  );
  return `${lines.join("\n")}\n`;
}

async function models(asJson: boolean): Promise<number> {
  const chain = BackendChain.fromConfig(loadConfig());
  process.stdout.write(renderModels(await modelCatalogue(chain), chain.names(), asJson));
  return 0;
}

async function status(asJson: boolean): Promise<number> {
  const config = loadConfig();
  const chain = BackendChain.fromConfig(config);
  const results = await chain.healthAll();

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          config: config.configPath,
          chain: chain.names(),
          available: chain.allNames(),
          allowCloud: config.allowCloud,
          skipped: chain.skipped,
          backends: results.map(({ backend, inChain, health }) => ({
            name: backend.name,
            kind: backend.kind,
            calibration: backend.calibration,
            cloud: backend.cloud,
            automatic: inChain,
            endpoint: backend.endpoint,
            contextTokens: backend.contextTokens,
            ok: health.ok,
            detail: health.detail,
            models: health.models ?? [],
          })),
        },
        null,
        2
      ) + "\n"
    );
    return 0;
  }

  const rows = results.map(({ backend, inChain, health }) => ({
    backend: backend.name,
    kind: backend.kind,
    calibration: backend.calibration,
    scope: backend.cloud ? "cloud" : "local",
    automatic: inChain ? "yes" : "no",
    health: health.ok ? "ok" : "down",
    detail: health.detail,
  }));

  const width = (key: keyof (typeof rows)[number], header: string) =>
    Math.max(header.length, ...rows.map((row) => String(row[key]).length));
  const w = {
    backend: width("backend", "BACKEND"),
    kind: width("kind", "KIND"),
    calibration: width("calibration", "CALIBRATION"),
    scope: width("scope", "SCOPE"),
    automatic: width("automatic", "AUTO"),
    health: width("health", "HEALTH"),
  };

  const headers: Array<[string, keyof typeof w]> = [
    ["BACKEND", "backend"],
    ["KIND", "kind"],
    ["CALIBRATION", "calibration"],
    ["SCOPE", "scope"],
    ["AUTO", "automatic"],
    ["HEALTH", "health"],
  ];
  const lines = [headers.map(([text, key]) => text.padEnd(w[key])).join("  ")];
  for (const row of rows) {
    lines.push(
      `${row.backend.padEnd(w.backend)}  ${row.kind.padEnd(w.kind)}  ${row.calibration.padEnd(w.calibration)}  ${row.scope.padEnd(w.scope)}  ${row.automatic.padEnd(w.automatic)}  ${row.health.padEnd(w.health)}  ${row.detail}`
    );
  }
  if (chain.skipped.length > 0) {
    lines.push("", "skipped:");
    for (const skip of chain.skipped) lines.push(`  ${skip.name}: ${skip.reason}`);
  }
  lines.push(
    "",
    "AUTO=yes means the backend answers when no model is named; others are reachable by name only.",
    `config: ${config.configPath}`,
    `cloud allowed: ${config.allowCloud ? "yes" : "no"}`
  );
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function runJudge(argv: string[]): Promise<number> {
  const args = parseArgs(argv, ["allow-uncalibrated", "json"]);
  const threshold = numberFlag(args, "threshold");
  const topK = numberFlag(args, "top-k");
  const minConfidence = numberFlag(args, "min-confidence");

  const output = await judge({
    state: stateFrom({
      text: args.get("state"),
      file: args.get("state-file"),
      json: args.get("state-json"),
    }),
    questions: questionsFrom(args.get("questions")),
    ...(args.get("backend") ? { backend: args.get("backend") as string } : {}),
    ...(args.get("model") ? { model: args.get("model") as string } : {}),
    ...(args.get("preset") ? { preset: args.get("preset") as string } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
    ...(topK !== undefined ? { topK } : {}),
    ...(minConfidence !== undefined ? { minConfidence } : {}),
    ...(args.has("allow-uncalibrated") ? { allowUncalibrated: true } : {}),
  });

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return 0;
}

async function runServe(argv: string[]): Promise<number> {
  const args = parseArgs(argv, ["verbose"]);
  const host = args.get("host") ?? "127.0.0.1";
  const port = numberFlag(args, "port") ?? 8319;
  const running = await serve({ host, port, verbose: args.has("verbose") });
  process.stderr.write(
    `[adecider] listening on ${running.url}\n` +
      `[adecider] GET /health, GET /models, POST /route, POST /decide\n` +
      (host === "127.0.0.1" || host === "localhost"
        ? ""
        : `[adecider] WARNING: bound beyond loopback and this endpoint does not authenticate\n`)
  );
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  await running.close();
  return 0;
}

function mcpConfig(argv: string[]): number {
  const args = parseArgs(argv, []);
  const name = args.get("name") ?? "adecider";
  const command = "node";
  const entry = SERVER_ENTRY;

  const jsonBlock = JSON.stringify(
    { mcpServers: { [name]: { command, args: [entry] } } },
    null,
    2
  );
  process.stdout.write(
    [
      `# MCP client config for ${name}`,
      "",
      "## pi (~/.pi/agent/mcp.json) and Claude Code (~/.claude.json): merge this mcpServers entry",
      "",
      jsonBlock,
      "",
      "## Codex (~/.codex/config.toml): append this table",
      "",
      `[mcp_servers.${name}]`,
      `command = "${command}"`,
      `args = ["${entry}"]`,
      "",
    ].join("\n")
  );
  return 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "status") {
    return status(parseArgs(rest, ["json"]).has("json"));
  }
  if (command === "models") {
    return models(parseArgs(rest, ["json"]).has("json"));
  }
  if (command === "serve") {
    return runServe(rest);
  }
  if (command === "judge") {
    return runJudge(rest);
  }
  if (command === "mcp-config") {
    return mcpConfig(rest);
  }
  process.stderr.write(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
  return 2;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${describeError(error)}\n`);
  process.exitCode = 2;
}
