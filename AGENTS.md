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
npm run check            # typecheck then the suite in one command
npm run status           # probe the chain, print health/calibration/local per backend
npm run models           # the model catalogue as a caller sees it
npm run serve            # one HTTP format over every model
node src/cli/main.ts judge --state-file /tmp/diff.patch --questions @/tmp/q.json --threshold 0.7
node src/cli/main.ts mcp-config
node src/cli/gate.ts -c "the state reports a refund" --state-file /tmp/x   # exit 0 pass, 1 fail, 2 error
pi -ne -e ./src/harness/pi/index.ts      # load the extension in a dev session
npm run smoke            # asserts the extension's three tools register in a real pi process
```

`gate` takes `-c <criteria>` and builds its own one-question judgment; it does not take `--questions`,
which is `adecider judge`'s flag. `.github/workflows/check.yml` runs `npm run check` on Node 23.6 and
26 and needs no model: the live tests skip.

Node 23.6 or newer, no build step: Node runs the TypeScript directly (23.6 is the release that
unflagged type stripping), so imports carry `.ts` extensions and `bin/*.js` are two-line shims. Zero
runtime dependencies; `node_modules` is dev-only (pi packages, typebox, typescript). Do not add a
runtime dependency, and do not add a bundler.

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
   code. `busy` exists so an overloaded backend is not reported as the caller's mistake. A rejected
   payload must name the field: Jev answers a bad request with FastAPI's `detail`, which is why
   `errorDetail()` reads `detail` as well as `error` rather than printing the status line.
5. **Privacy is a boundary, not a preference.** The automatic chain is local. Jev is nameable while
   absent from the chain; a present key is not consent to send state off the machine. `allowCloud` /
   `ADECIDER_ALLOW_CLOUD=1` are the only two switches, both off by default. A loopback URL is local.
6. **Requests are budgeted against the answering backend's window.** The Laya `english` checkpoint
   reads 512 tokens and the server truncates over-long requests silently, so an unbudgeted batched
   judgment returns confident wrong answers. The harness budgets and reports what it drops; the
   Laya adapter refuses, as a typed failure, a request whose estimate exceeds the window; and a
   payload that omits an asked id surfaces in `missing` rather than being absorbed. Dropped
   candidates must be reported, never dropped in silence.
7. **`score` and `confidence` are different axes.** `score` is the answer's strength, `confidence` is
   how concentrated the distribution is. Do not conflate them in a new feature.
8. **One judgment path.** CLI, MCP, HTTP and every pi feature call the same `judge()`; adapter-level
   rules go through `src/harness/pi/decisions.ts` so calibration discipline cannot drift feature by
   feature.
9. **One request dialect, whatever answers.** `noul.criteria` is a clarification string in the public
   type, which is Laya's dialect. Jev accepts only an object there and ignores the value (measured
   2026-09-24: a string is HTTP 422, an object is 200, and the probability is 0.67 either way), so
   `jevQuestions()` in `src/backends/jev.ts` rewrites it. A request shape this layer accepts must not
   fail on the dialect of the backend that happens to answer it; `test/jev.test.ts` pins both halves.
10. **Automatic features are off by default**, matching pi-jev. `/adecider status` reports what is on.
   Auto mode is the only feature that spends a request per prompt.
11. **The Jev endpoint is allowlisted** to the vendor host or loopback, because it is the one adapter
   that attaches a bearer key to every request; a `baseUrl` anywhere else is refused by name when the
   backend is built (`jevEndpoint()`). Hosts stay open for the other adapters, where the endpoint is
   the operator's declaration and no credential travels with it.

## Verification culture

The README's claims are all measured, and a number without a measurement is the failure mode this repo
was written against. So:

- A number you add to `README.md` or a doc comment must come from a command you actually ran, with the
  date and the machine where that matters. Prefer re-running over copying an old figure.
- Do not write counts that rot into documentation. `npm test` prints its own count, so point at the
  command; the README's own written count was 29 while the suite ran 59.
- Hermetic tests use `test/helpers/fake-laya.ts`, which replays a payload measured from `laya-mlx`
  including the fields Jev does not return, and covers both dialects plus the OpenAI-compatible routes.
  `test/conformance.test.ts` is the anti-drift net: the same numbers delivered in the Laya, Jev, and
  chat encodings must normalize to the same answers and the same verdicts, and a payload that drifts
  out of contract must fail as `bad_response` rather than be guessed at.
- Each transport has its own file for its failure modes (`test/laya.test.ts`, `test/jev.test.ts`,
  `test/openai.test.ts`); add a case there rather than a new file when a branch is missing. The pi-only
  paths live in `test/harness-wiring.test.ts` behind a fake event bus, model registry, and completion
  function, so a feature that acts on pi's state stays testable without a session.
- Wall-clock latency is a measurement, not a contract: keep the numbers in `README.md` and never assert
  a duration in a test on a shared machine. What a latency regression actually was is an adapter that
  fans one judgment out into one request per question, so that is what is asserted (a fixed round-trip
  count for 1, 5, and 12 questions).
- `test/live.test.ts` is the exception to hermeticity: it asserts the real calibration margin and the
  agreement between two running services, and **skips, never fails**, when nothing listens, because the
  Laya repos were archived off this machine on 2026-09-21 and 8317/8318 are often down.
  `ADECIDER_LIVE_URLS=name=url,...` points it at services elsewhere, which is also how its non-skipping
  branches are checked without a model.
- The MCP surface is tested end to end by spawning the server and speaking JSON-RPC to it; a change to
  `decide` needs that path covered, not just the unit. `test/cli.test.ts` does the same for the two
  CLI entry points (exit codes, stdout contract, `--fail-open`).
- Whether pi itself calls these handlers, and whether a tool the router activates really becomes
  selectable, needs a live session and is not covered by `npm test`. The logic behind it is: the three
  tools register through a fake pi API in `test/harness.test.ts`, and the event handlers, model
  registry, and completion call are driven in `test/harness-wiring.test.ts`. For the rest, verify in a
  real session with `pi -ne -e ./src/harness/pi/index.ts` and check `/adecider status` output rather
  than trusting the wiring by reading it.

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
- Skill ids are the skill's own name: pi registers the command `skill:<name>` and reports it that way
  from `getCommands()`, so `skillCatalog()` strips the prefix once. Every surface renders `/skill:<id>`,
  and a prefix left in the id renders as `/skill:skill:<name>`.
- Tool names, `/adecider` subcommands, error codes, and `src/harness/pi/rpc.ts` event strings are a
  compatibility surface with pi-jev (`jev_find_tools`, `jev_find_skill`, `jev_evaluate`). Renaming one
  breaks migration checks, so change it only with a reason that survives review.
- CLI contract: stdout carries JSON only, diagnostics go to stderr, exit `2` for a typed failure.
- CI actions are pinned to the commit each release tag points at (resolve the tag through the GitHub API
  rather than copying a SHA from a blog), with `persist-credentials: false` and `permissions: contents:
  read`. An action is the one dependency here that the lockfile does not name.
- MCP contract: a failed judgment is a tool result with `isError: true`, not a JSON-RPC error.

## Known pitfalls

- The Laya services default to `127.0.0.1:8317` (MLX) and `8318` (PyTorch/MPS reference). Restored
  2026-09-22: 8317 runs under the launchd agent `com.niehu.laya-mlx` (`RunAtLoad` plus `KeepAlive`, so
  it outlives the terminal that started it), its weights live in `/Users/niehu/llm/laya-mlx/models/hub`
  and pass `laya-mlx-local/scripts/verify_checksums.py` against the published metadata, and its venv is
  `/Users/niehu/llm/laya-mlx/.venv`. The reference build has its package installed but no weights, so
  8318 is down until `laya-local/fetch_models.sh` finishes (it needs `HF_ENDPOINT=https://hf-mirror.com`
  on this network). Absence is normal, not a bug: health failures produce no catalogue rows.
- Both upstream checkouts were gone from this machine, so the restore fetched tarballs through
  `codeload.github.com` with Node rather than `git`, whose LibreSSL handshakes this network drops.
- On this machine `/tmp` is wiped periodically and the default tmux socket lives there, so a long job
  started that way dies with it: keep work and logs under `~/.pi/agent/subagents/...` and give it a
  socket of its own. The tests must not depend on what is running here: `KNOWN_BACKENDS` joins every
  config, so a live 8317 changes any assertion over the whole catalogue (see `test/cli.test.ts`).
- Never probe a down backend in a retry loop. Health results are cached for 5 seconds for this reason.
- A `noul` question carrying `criteria` is the one place the backends disagree on request shape; see
  invariant 9 before touching `src/types.ts`, `src/judge.ts` validation, or either backend's request
  builder.
- The HTTP server holds a global lock on the accelerator, so judgements serialize; a burst of parallel
  calls queues rather than failing fast.
- `jev` health is configuration-only, so `status` reporting it as ok does not mean the API is
  reachable. When a cloud call reports `fetch failed`, read the cause code before touching the adapter:
  on a machine whose route drops Node's connections the fix is `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=...`
  (Node 24.5.0 and newer, measured 2026-09-24). The adapter now reports the cause itself.
- `npm run smoke` and any live test may be affected by whatever is running on 8317/8318 at that
  moment. Report a skip as a skip.
