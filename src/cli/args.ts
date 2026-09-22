/** Minimal flag parsing. No dependency, and no surprises about what a flag consumes. */

export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
  has(name: string): boolean;
  get(name: string): string | undefined;
}

export function parseArgs(argv: string[], booleanFlags: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  const booleans = new Set(booleanFlags);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    // `--flag` and the documented one-letter form `-c` are the same flag. Without this a short flag
    // fell through to the positional list, so `adecider-gate -c "<criterion>"` judged the literal
    // `-c` and threw the criterion away: a verdict on a question nobody asked.
    let body = "";
    if (token.startsWith("--")) body = token.slice(2);
    else if (/^-[A-Za-z]$/.test(token)) body = token.slice(1);
    if (body === "") {
      positional.push(token);
      continue;
    }
    const equals = body.indexOf("=");
    if (equals !== -1) {
      flags.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    if (booleans.has(body)) {
      flags.set(body, true);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(body, true);
      continue;
    }
    flags.set(body, next);
    index += 1;
  }

  return {
    positional,
    flags,
    has(name) {
      return flags.has(name);
    },
    get(name) {
      const value = flags.get(name);
      return typeof value === "string" ? value : value === true ? "" : undefined;
    },
  };
}

/** A number flag, or undefined when absent. Rejects non-numeric values instead of coercing. */
export function numberFlag(args: ParsedArgs, name: string): number | undefined {
  const raw = args.get(name);
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`--${name} expects a number, got ${JSON.stringify(raw)}`);
  }
  return value;
}
