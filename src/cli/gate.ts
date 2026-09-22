#!/usr/bin/env node
/**
 * `adecider-gate`: one thresholded judgment as a process exit code, for CI and for subagent
 * acceptance checks.
 *
 * Exit codes: 0 pass, 1 fail, 2 error (including a refused calibration). `--fail-open` turns an
 * error into a pass and says so loudly on stderr, so a caller can distinguish an outage from a
 * verdict.
 *
 * The default threshold is 0.7 rather than the 0.65 used for routing in pi-jev: a gate should be
 * stricter than a suggestion.
 */

import { describeError, isSystemOneError } from "../errors.ts";
import { judge } from "../judge.ts";
import { numberFlag, parseArgs } from "./args.ts";
import { stateFrom } from "./io.ts";

const USAGE = `adecider-gate: exit 0 when a judgment passes, 1 when it fails, 2 on error

  adecider-gate -c <criteria> [--state <text> | --state-file <path> | --state-json <json>]
                  [--threshold <n>] [--min-confidence <n>] [--backend <name>] [--model <id>]
                  [--fail-open] [--allow-uncalibrated] [--json]

  -c, --criteria <text>   The acceptance criterion the state is judged against.
      --file <path>       Shortcut for --state-file.
      --fail-open         Treat a backend failure as a pass, reported on stderr.
      --json              Print the full decision payload on stdout.
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), ["fail-open", "allow-uncalibrated", "json"]);
  if (args.has("help")) {
    process.stdout.write(USAGE);
    return 0;
  }

  const criteria = args.get("criteria") ?? args.positional[0];
  if (criteria === undefined || criteria.trim().length === 0) {
    process.stderr.write(`missing criteria\n\n${USAGE}`);
    return 2;
  }
  const threshold = numberFlag(args, "threshold") ?? 0.7;
  const minConfidence = numberFlag(args, "min-confidence");
  const failOpen = args.has("fail-open");

  try {
    const output = await judge({
      state: stateFrom({
        text: args.get("state"),
        file: args.get("file") ?? args.get("state-file"),
        json: args.get("state-json"),
      }),
      questions: {
        gate_passed: {
          type: "noul",
          instructions: `Does the state satisfy this acceptance criterion: "${criteria}"?`,
        },
      },
      ...(args.get("backend") ? { backend: args.get("backend") as string } : {}),
      ...(args.get("model") ? { model: args.get("model") as string } : {}),
      threshold,
      ...(minConfidence !== undefined ? { minConfidence } : {}),
      ...(args.has("allow-uncalibrated") ? { allowUncalibrated: true } : {}),
    });

    const decision = output.decisions?.find((d) => d.id === "gate_passed");
    if (!decision) {
      process.stderr.write("no gate_passed decision in the result\n");
      return 2;
    }

    if (args.has("json")) {
      process.stdout.write(`${JSON.stringify({ output, decision }, null, 2)}\n`);
    } else {
      process.stdout.write(
        `gate ${decision.passed ? "PASS" : "FAIL"} probability=${decision.score.toFixed(3)} ` +
          `threshold=${threshold} backend=${output.backend}` +
          (decision.uncalibrated ? " (uncalibrated)" : "") +
          "\n"
      );
    }
    return decision.passed ? 0 : 1;
  } catch (error) {
    const detail = describeError(error);
    if (failOpen && !(isSystemOneError(error) && error.code === "bad_request")) {
      process.stderr.write(`gate fail-open: ${detail}\n`);
      process.stdout.write("gate PASS (fail-open, no verdict produced)\n");
      return 0;
    }
    process.stderr.write(`gate error: ${detail}\n`);
    return 2;
  }
}

process.exitCode = await main();
