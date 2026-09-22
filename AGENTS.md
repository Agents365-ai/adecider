# AGENTS.md

Operating guide for coding agents working in this repo. `README.md` is the user-facing reference,
`PLAN.md` is the design record that produced it. Neither is a spec to extend: this file tells you what
may be changed without breaking the thing.

## What this repo is

`adecider` gives any coding agent typed System One decisions: one call sends a piece of state plus a
map of typed questions (`noul`, `choice`, `score`) and gets back probabilities, not prose. Backends are
pluggable: local Laya checkpoints by default, TypeSafe Jev when a key is present, any OpenAI-compatible
model as an explicit escape hatch.

The repo has one argument and everything in it serves that argument: a generative model should not be
asked to judge, and a model that returns probabilities can be thresholded where a chat model cannot.
Changes that soften that claim, or that add a verdict the backend did not earn, are wrong even when
they are convenient.

## Layout

Portable core, reachable from every harness (CLI, MCP, HTTP):

| Path | Role |
| --- | --- |
| `src/types.ts` | Public request/answer types. One dialect for all backends |
| `src/errors.ts` | Typed failure codes: `unreachable`, `unconfigured`, `bad_request`, `bad_response`, `timeout`, `busy`, `calibration`, `unsupported` |
| `src/config.ts` | Config resolution: `~/.pi/agent/adecider.json`, `ADECIDER_*` env, built-in local backends |
| `src/backends/` | `laya.ts` (local HTTP), `jev.ts` (hosted HTTPS), `openai.ts` (chat escape hatch, `ranking`), `index.ts` (selection + health cache) |
| `src/normalize.ts` | Backend payload to `Answer`. Refuses what it cannot read |
| `src/judge.ts` | The one entry point every surface calls: validate, select, normalize, decide |
| `src/policy.ts` | `score` vs `confidence`, threshold / top-k / min-confidence, the calibration gate |
| `src/models.ts` | One model namespace over every transport; ids come from health probes, not a list |
| `src/mcp/server.ts` | Hand-rolled stdio MCP server, one tool `decide` |
| `src/server/http.ts` | `GET /health`, `GET /models`, `POST /route`, `POST /decide` |
| `src/cli/` | `main.ts` (`adecider`), `gate.ts` (`adecider-gate`), `args.ts`, `io.ts` |

Non-portable half, only meaningful inside the pi process (`src/harness/pi/`): `index.ts` wires it,
`tools.ts` registers `adecider_find_tools` / `adecider_find_skill` / `adecider_evaluate`, `commands.ts`
registers `/adecider`, and the features are `auto.ts`, `router.ts`, `skills.ts`, `tool-guard.ts`,
`compact.ts`, `model-router.ts`, `orchestrator.ts`, `agent.ts`, `rpc.ts`, `decisions.ts`, `designer.ts`,
`budget.ts`, `catalog.ts`. An MCP server cannot activate another server's tools or receive pi's events,
which is the whole reason routing, gating, compaction and orchestration live here and not in the core.

`fixtures/laya-mlx/` holds wire payloads recorded from the live service with curl. They are test
evidence, not samples: do not hand-edit them, re-record instead.

## Commands

```console
npm run typecheck        # tsc --noEmit, strict; run this before claiming a change works
npm test                 # node --test test/*.test.ts; hermetic except live.test.ts
npm run status           # probe the chain, print health/calibration/local per backend
npm run models           # the model catalogue as a caller sees it
npm run serve            # one HTTP format over every model
node src/cli/main.ts judge --state-file /tmp/diff.patch --questions @/tmp/q.json --threshold 0.7
node src/cli/main.ts mcp-config
node src/cli/gate.ts --state-file /tmp/x --questions @/tmp/q.json   # exit 0 pass, 1 fail, 2 error
pi -ne -e ./src/harness/pi/index.ts      # load the extension in a dev session
npm run smoke            # asserts the extension's three tools register in a real pi process
```

Node 23 or newer, no build step: Node runs the TypeScript directly, so imports carry `.ts` extensions
and `bin/*.js` are two-line shims. Zero runtime dependencies; `node_modules` is dev-only (pi packages,
typebox, typescript). Do not add a runtime dependency, and do not add a bundler.

## Invariants

Break one of these and the project stops meaning what it says. Each is enforced by a test; extend the
test, do not delete it.

1. **Calibration gates thresholding.** `ranking` backends (OpenAI-compatible) refuse `--threshold`
   with `calibration` and are only rankable with `--top-k`. `--allow-uncalibrated` overrides and marks
   every verdict `uncalibrated`. Never silently downgrade a threshold to a ranking.
2. **No verdict without a rule.** No threshold and no top-k means answers with no `decisions` array.
   Never invent a pass/fail.
3. **A named backend never falls back.** `--backend` is a hard constraint. An outage is `unreachable`,
   reported with the probes that failed, never another backend's answer.
4. **Failure is typed, never a default.** Every path that cannot answer returns a `SystemOneError`
   code. `busy` exists so an overloaded backend is not reported as the caller's mistake.
5. **Privacy is a boundary, not a preference.** The automatic chain is local. Jev is nameable while
   absent from the chain; a present key is not consent to send state off the machine. `allowCloud` /
   `ADECIDER_ALLOW_CLOUD=1` are the only two switches, both off by default. A loopback URL is local.
6. **Requests are budgeted against the answering backend's window.** The Laya `english` checkpoint
   reads 512 tokens and the server truncates over-long requests silently, so an unbudgeted batched
   judgment returns confident wrong answers. Dropped candidates must be reported, never dropped in
   silence.
7. **`score` and `confidence` are different axes.** `score` is the answer's strength, `confidence` is
   how concentrated the distribution is. Do not conflate them in a new feature.
8. **One judgment path.** CLI, MCP, HTTP and every pi feature call the same `judge()`; adapter-level
   rules go through `src/harness/pi/decisions.ts` so calibration discipline cannot drift feature by
   feature.
9. **Automatic features are off by default**, matching pi-jev. `/adecider status` reports what is on.
   Auto mode is the only feature that spends a request per prompt.

## Verification culture

The README's claims are all measured, and a number without a measurement is the failure mode this repo
was written against. So:

- A number you add to `README.md` or a doc comment must come from a command you actually ran, with the
  date and the machine where that matters. Prefer re-running over copying an old figure.
- Do not write counts that rot into documentation (the README's "29 tests" is already stale). Point at
  the command instead.
- Hermetic tests use `test/helpers/fake-laya.ts`, which replays a payload measured from `laya-mlx`
  including the fields Jev does not return. `test/live.test.ts` is the exception: it asserts the real
  calibration margin and **skips, never fails**, when nothing listens, because the Laya repos were
  archived off this machine on 2026-09-21 and 8317/8318 are often down.
- The MCP surface is tested end to end by spawning the server and speaking JSON-RPC to it; a change to
  `decide` needs that path covered, not just the unit.
- pi-adapter behaviour that needs a live process (tool activation, model switching, event wiring) is
  not covered by `npm test`. Verify it in a real session with `pi -ne -e ./src/harness/pi/index.ts`,
  and check `/adecider status` output rather than trusting the wiring by reading it.

## Conventions

- Comments: every file opens with a doc comment stating its role and the measured reason it exists.
  Extend that style; keep comments English; no non-English text anywhere in the repo.
- No em dashes anywhere (code, comments, commits, docs). Use a comma, colon, parentheses, or split the
  sentence.
- Minimal change is the default. No speculative abstraction, no new config knob, no dependency, no
  error handling for impossible cases. Mention an unrelated improvement in chat instead of making it.
- TypeScript is strict with `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules` and
  `erasableSyntaxOnly`: use `import type` for types, no enums or parameter properties, and index
  `process.env` with brackets.
- Tool names, `/adecider` subcommands, error codes, and `src/harness/pi/rpc.ts` event strings are a
  compatibility surface with pi-jev (`jev_find_tools`, `jev_find_skill`, `jev_evaluate`). Renaming one
  breaks migration checks, so change it only with a reason that survives review.
- CLI contract: stdout carries JSON only, diagnostics go to stderr, exit `2` for a typed failure.
- MCP contract: a failed judgment is a tool result with `isError: true`, not a JSON-RPC error.

## Known pitfalls

- The Laya services default to `127.0.0.1:8317` (MLX, launchd) and `8318` (PyTorch/MPS, on demand).
  Both are often absent, and absence is normal, not a bug: health failures produce no catalogue rows.
- Never probe a down backend in a retry loop. Health results are cached for 5 seconds for this reason.
- `src/harness/pi/index.ts` says the portable half lives in `src/core`. There is no `src/core`; the
  portable half is `src/` top level plus `src/backends`, `src/mcp`, `src/server`, `src/cli`. Treat the
  comment as stale, do not create the directory to satisfy it.
- The HTTP server holds a global lock on the accelerator, so judgements serialize; a burst of parallel
  calls queues rather than failing fast.
- `npm run smoke` and any live test may be affected by whatever is running on 8317/8318 at that
  moment. Report a skip as a skip.
