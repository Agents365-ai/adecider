/** Reading state and questions from a flag, a file, or stdin. */

import * as fs from "node:fs";

export function readFile(path: string): string {
  return fs.readFileSync(path, "utf8");
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export function stateFrom(args: {
  text?: string | undefined;
  file?: string | undefined;
  json?: string | undefined;
}): unknown {
  if (args.json !== undefined) {
    return JSON.parse(args.json) as unknown;
  }
  if (args.file !== undefined) {
    return readFile(args.file);
  }
  if (args.text !== undefined) {
    return args.text;
  }
  if (!process.stdin.isTTY) {
    const piped = readStdin();
    if (piped.trim().length > 0) return piped;
  }
  throw new Error(
    "no state supplied: pass --state <text>, --state-file <path>, --state-json <json>, or pipe it on stdin"
  );
}

/** Parse a questions argument: inline JSON, or @path to read it from a file. */
export function questionsFrom(value: string | undefined): Record<string, unknown> {
  if (value === undefined) {
    throw new Error("no questions supplied: pass --questions <json> or --questions @<path>");
  }
  const raw = value.startsWith("@") ? readFile(value.slice(1)) : value;
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("questions must be a JSON object mapping ids to questions");
  }
  return parsed as Record<string, unknown>;
}
