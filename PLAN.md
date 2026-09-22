# adecider: Pluggable System One decisions for any coding agent

**Status:** discovery; implementation blocked on the product choices in section 1
**Audience:** maintainer (single author), building a local-first tool that serves multiple System One backends to multiple agent harnesses
**Post-read action:** answer the questionnaire with option letters, then implement the selected v1 without reopening settled product decisions

## Why this exists

`pi-jev` (local checkout at `/Users/niehu/llm/pi-jev`, 2295 lines across 15 modules) proved the shape but is locked to two things: one backend (TypeSafe Jev, reached through `@typesafe-ai/sdk` at `src/jev.ts:107`) and one harness (pi, through `ExtensionAPI` in all 15 modules). The audit of that repo produced three findings that drive this plan.

1. **The backend is a single seam.** Every semantic operation funnels through one call, `client.systemOne({state, questions, model})`, and every consumer reads only `answers[id].value` (`router.ts:107`, `skills.ts:145`, `gate.ts:157`, `tool-guard.ts:72`, `compact.ts:56`, `orchestrator.ts:38`, `agent.ts:60`, `tools.ts:170`). `distribution` is declared at `types.ts:41` and read by nobody. The swap surface is one number or one string per question id.
2. **Only two of the eight features carry their weight.** Batched typed judgment (`jev_evaluate`) and the gate CLI are the product. Tool routing is conditional (see risk R1). Skill suggestion is negative value. Tool guard, Jev compaction, and auto-model are not worth their cost.
3. **The harness lock is not necessary, but tool activation is.** An MCP server cannot activate or deactivate another server's tools. pi-jev's router works only because it runs inside pi and calls `pi.setActiveTools()` (`router.ts:132`), which is pi's documented lazy tool loading pattern (`docs/extensions.md:2400-2510`). Any harness-agnostic design must treat tool routing as a pi-native capability, not a portable one.

The backend side is the opposite of locked. Two independent System One implementations with identical primitives already exist on this machine, and a third class (any OpenAI-compatible endpoint) is already served locally by `prism-ml/serve.sh`.

## Fast answer format

Reply with option letters:

```text
Q01: A
Q02: A
Q03: A, B
```

Use `defaults` to accept every **Recommended** option, then list overrides only.

---

## 1. Decision questionnaire

### Product

#### Q01: What is v1's main job? Pick one.

- **A: Batched typed judgment (Recommended):** one tool that takes state plus N typed questions and returns N calibrated answers in one backend call. This is the only capability whose value survives a harness change, because no harness already has it.
- **B: Tool routing:** select and activate the tools a prompt needs. pi-only by construction (see R1), so it cannot be the portable core.
- **C: Pre-execution judge gate:** judge risky `bash` / `write` / `edit` calls before they run.
- **D: Context compression:** replace always-injected tool and skill catalogs with on-demand retrieval.
- **E: Suite:** ship all of the above in v1.

#### Q02: Which capability is v1's second slot, if any? Pick up to two.

- **A: Gate CLI (Recommended):** deterministic exit code over a thresholded judgment, for CI and subagent acceptance checks. Already validated in pi-jev (`gate.ts:122-170`).
- **B: Context compression (Recommended):** the measured target is 46 skills costing 18984 characters, about 5400 tokens, injected into every single request (measurement in section 6).
- **C: pi-native tool routing:** port the pi-jev router onto the new core once the core exists.
- **D: Pre-execution judge gate.**
- **E: None:** keep v1 to a single tool.

### Backends

#### Q03: Which backends ship in v1? Pick all that apply.

- **A: `laya-mlx` local HTTP (Recommended):** `http://127.0.0.1:8317`, launchd-managed, MLX, answers byte-identical to the reference service and about 1.6x faster.
- **B: `laya` local HTTP (Recommended):** `http://127.0.0.1:8318`, PyTorch/MPS reference service, stdlib-only server, same routes and payloads.
- **C: `jev` cloud:** TypeSafe HTTPS, `TYPESAFE_API_KEY`, billed per request, reports token usage.
- **D: OpenAI-compatible local:** any `/v1/chat/completions` endpoint, which is what `prism-ml/serve.sh` already provides on ports 8090 and 8091. Not calibrated, so it needs the ranking rule from Q06.

Recommendation: A plus B (the two Laya services are the same backend family behind two ports) plus C. D is the escape hatch for arbitrary models and is the cheapest to add once normalization exists, but it is the only backend whose probabilities are not trained against a strictly proper scoring rule, so it must be labeled as such.

#### Q04: How is a backend selected when more than one is reachable?

- **A: Declared chain with health probe (Recommended):** an ordered list, first healthy backend wins, `adecider status` prints what is live and what was skipped.
- **B: Explicit only:** never auto-select, one backend per invocation, error when it is down.
- **C: Per-capability default:** local for high-volume judgments, cloud for long-context or multilingual cases.

#### Q05: What happens when the selected backend is unreachable?

- **A: Typed unavailability, fail closed (Recommended):** return a structured error naming the backend and the reason, never a silent substitute.
- **B: Silent fallback down the chain.**
- **C: Silent fallback to cloud**, which means code leaves the machine without an explicit decision.

### Decision semantics

#### Q06: How is the decision rule chosen across backends with different calibration?

- **A: Declared calibration mode per backend (Recommended):** `absolute` for RLCD-trained backends (Jev, Laya: probabilities are statistically meaningful, so a fixed threshold is valid) and `ranking` for everything else (rank candidates and take the top-k, which is immune to uncalibrated scores).
- **B: Ranking everywhere:** uniform but throws away the calibration that the local backends actually provide.
- **C: Absolute everywhere:** makes the threshold meaningless for the OpenAI-compatible path (typical self-reported confidence clusters at 0.9 to 1.0, so a 0.65 cutoff activates nearly everything).

### Harness adapters

#### Q07: Which adapter ships first?

- **A: MCP server, stdio (Recommended):** one artifact that covers pi, Claude Code, Codex, and anything else that speaks MCP. This is the only path that satisfies "any agent" without per-harness code.
- **B: pi native extension:** richer hooks (`before_agent_start`, `tool_call`, `session_before_compact`) and the only place tool activation is possible, but pi-only.
- **C: CLI only:** the agent shells out. Smallest surface, most glue per harness.
- **D: Claude Code hooks plus skills:** `PreToolUse` interception without MCP.

#### Q08: How is the core implemented and where does it run?

- **A: TypeScript core, HTTP backends (Recommended):** the core speaks HTTP to Laya services and HTTPS to Jev, so it needs no Python at runtime and can run as an MCP stdio server or a CLI binary. One language for core, MCP, and the pi adapter.
- **B: Python core:** can call `laya.Router.predict` in-process, no HTTP hop for Laya, but then the MCP server, the pi adapter, and the CLI all need a Python runtime and a venv path.
- **C: Both:** TS core plus a Python sidecar for in-process Laya. Two runtimes to keep in sync.

#### Q09: How many tools does the MCP server expose?

- **A: One `decide` (Recommended):** a single tool with a typed `questions` map. MCP clients inject every exposed tool's full schema into context, so each additional tool is a permanent tax on every request, on every harness.
- **B: Two: judge plus gate.**
- **C: Three or more:** judge, gate, and catalog search.

### Identity and delivery

#### Q10: Naming.

- **A (Recommended, decided):** package and MCP server name `adecider`, tool name `decide`, CLI `adecider-gate`.
- **B:** keep a vendor-flavored tool name such as `jev_judge`.
- **C:** `agent-adecider`.

Decided 2026-09-21 by the maintainer: A. `adecider` reads as "a decider" and as "agent decider", which names the role instead of the mechanism.

Two constraints hold behind the split between the two names. Do not prefix with `agent-`: the prefix carries no information in this space and the role is already implied. Keep the role name on the package and the capability name on the tool: the client renders `mcp__<server>__<tool>`, so naming both `adecider` would produce `mcp__adecider__adecider_decide`, and `decide` is the part that survives a backend swap, since a tool named after the mechanism would have to be renamed the moment an uncalibrated backend becomes primary.

#### Q11: Relationship to `pi-jev`.

- **A: New independent repo, `pi-jev` untouched (Recommended):** the new core is clean, and `pi-jev` keeps working for its current users.
- **B: Extract, then migrate:** the new core becomes a dependency of `pi-jev`, whose eight features are reduced to the two that carry weight.
- **C: Fork and rewrite `pi-jev` in place.**

#### Q12: Privacy default.

- **A: Local-only unless cloud is explicitly enabled (Recommended):** with a local backend selected, nothing leaves the machine, and this is verified by a test that fails if any outbound connection is attempted.
- **B: Cloud permitted whenever it is configured.**

#### Q13: Publication timing.

- **A: Local and private first (Recommended):** build and dogfood against the two local Laya services and pi, publish only after the backend conformance suite passes.
- **B: Public from the first commit.**

---

## 2. Recommended v1

Read this as the default if the answers are `defaults`.

**Job:** one batched typed-judgment tool, exposed once as an MCP server, backed by a pluggable backend layer whose first two entries are the Laya services already running on this machine and TypeSafe Jev.

**Deliverables:**

1. `adecider` core: request and response types, backend normalization, backend selection, calibration-aware decision rules.
2. Three backend adapters: `laya` (HTTP, both ports), `jev` (cloud), `openai-compat` (any `/v1/chat/completions`, ranking mode).
3. One MCP stdio server exposing `decide`.
4. `adecider-gate` CLI with the same thresholded judgment semantics as `gate.ts:122-170`.
5. A conformance test suite that runs the same questions against every reachable backend and asserts that the normalized responses are structurally identical.

### User flow

```text
1. curl -s localhost:8317/health        # confirm a Laya service is live
2. adecider status                    # prints backends, health, calibration mode, cost model
3. agent calls decide with state + N typed questions
4. core picks the first healthy backend, normalizes the call, normalizes the response
5. agent receives one answer per question id, each with value, confidence, and which backend answered
```

### Deliberately excluded from recommended v1

- Harness-specific tool activation outside pi. Not possible over MCP (R1).
- Pre-execution judge gates wired into any harness. The CLI exists, the interception does not.
- Context compression. Measured as the largest real cost (section 6), but it needs its own design pass and is not required to prove the backend architecture.
- Any per-prompt automatic mode. Nothing runs unless the agent or the user asks.
- Telemetry, accounts, or a hosted service.

## 3. Implementation plan

### Milestone 0: Lock scope and record answers

- Record the answered questionnaire in section 8 of this file.
- Confirm the backend list against live services (`/health` on 8317 and 8318, Jev key resolution).
- Freeze the v1 tool surface at the number of tools chosen in Q09.

**Exit:** section 8 is filled in, the live backend list is recorded with the commands that verified it.

### Milestone 1: Bootstrap the repo

- `/Users/niehu/llm/adecider/` layout: `src/`, `test/`, `bin/`, `fixtures/`, `README.md`, `PLAN.md`.
- TypeScript, Node >= 20, ESM. `npm run typecheck`, `npm test` (`node --test --import tsx`), `npm run smoke`.
- Runtime dependencies: none beyond Node built-ins (`fetch` is native). `@modelcontextprotocol/sdk` for the MCP server, `@typesafe-ai/sdk` only if the Jev adapter needs it.
- No install scripts, no postinstall, lockfile committed.

**Exit:** empty core typechecks, tests run, package has zero runtime dependencies except the two named above.

### Milestone 2: Core types and normalization

- `SystemOneRequest`: `{state, questions, backend?, model?, preset?, timeoutMs?}`.
- `SystemOneResponse`: `{answers, backend, model, elapsedMs, cost}` where `cost` is a tagged union, because the two backend families meter differently: Jev reports `usage.totalTokens`, Laya reports forward passes and wall time (Laya has no token accounting at all).
- `answers[id]`: `{type, value, confidence?, raw}`. Accept the four observed key spellings when reading a backend payload: `[primitive]`, `value`, `probability`, `noul`. Evidence that all four occur: `src/jev.ts:126-140` in pi-jev reads `choice ?? value` and `noul ?? probability ?? value`, while Laya documents `answers[id]["choice"]` and `answers[id]["noul"]`.
- Fixtures captured from live backends, one directory per backend, including error payloads (400 and 500 shapes differ between the two Laya servers only in the error text).

**Exit:** golden fixture suite passes; a normalized response is structurally identical across `laya-mlx`, `laya`, and `jev` for the same three-primitive question set.

### Milestone 3: Backend adapters and selection

- `laya`: `POST /decide` on a configured port, `GET /health` for probing, supports `preset` (the shipped presets are `triage`, `email`, `guard`, `moderation`, `router`) and `model` (checkpoints present are `english` and `multilingual`; `typed-decisions` is deliberately not downloaded, and `laya_local.py:44-56` shows the failure mode when it is forced).
- `jev`: `systemOne` over HTTPS. Model id is a parameter, never hardcoded (`jev-latest` is only a default).
- `openai-compat`: one JSON-schema-constrained call that answers all question ids in a single response. Never one call per question: the Jev and Laya paths both batch up to 10 to 12 questions in one round trip (`router.ts:90-110`, `skills.ts:135`), and a naive per-question adapter would turn one request into twelve. Calibration mode is `ranking`.
- Selection: ordered chain from Q04, health probe result cached for a short interval, explicit `backend` always wins over the chain.
- Serialization: the Laya servers hold a global lock because the accelerator is shared (`laya_server.py:20-21`), so concurrent calls from an agent loop queue rather than fail. Enforce a client-side timeout and report queueing time separately from inference time.

**Exit:** each adapter answers a live request; `adecider status` reports health, calibration mode, and cost model per backend; a down backend produces the typed unavailability error from Q05, verified by pointing an adapter at a closed port.

### Milestone 4: MCP server

- stdio server exposing the tool set frozen in Q09.
- Tool description states the contract, not the vendor: state plus typed questions in, one calibrated answer per question out. This text is what the agent routes on, so it carries the same weight as the name.
- Include `promptSnippet`-equivalent phrasing in the description for harnesses that surface one line only.
- Verify against three clients: pi (`~/.pi/agent/mcp.json`, same shape as the existing `asta` and `brightdata` entries), Claude Code (`~/.claude.json` `mcpServers`, which already holds four servers), and Codex (MCP config plus an `AGENTS.md` note).

**Exit:** all three clients list the tool and complete one live judgment against a local backend; the server starts in under 500 ms; no tool schema beyond the frozen set is injected.

### Milestone 5: Gate CLI

- `adecider-gate`: take criteria, read state from a file, a diff, or stdin, judge with the `noul` primitive, exit 0 above threshold and 1 below. Mirror `--criteria`, `--threshold`, `--fail-open` and the exit semantics of `gate.ts:36-80`.
- Default threshold inherits the gate default 0.7, not the routing threshold 0.65. Both are present in pi-jev (`gate.ts:124`, `skills.ts:8`) and the difference is deliberate: gates should be stricter than routing.

**Exit:** usable as a CI step and as a subagent acceptance check; a failing judgment exits non-zero and prints the probability.

### Milestone 6: pi native adapter (only if Q02 selects C)

- Reuse the core, do not fork it. The pi adapter is a consumer of the same normalized response type.
- Tool routing is possible here and only here: `pi.setActiveTools()` plus pi's lazy tool loading means an inactive tool costs zero context (`dist/core/agent-session.js:777-784` renders snippets only for selected tools). Keep pi-jev's additive-only semantics and its refusal to activate unjudged tools.
- Do not establish the inactive set for other extensions' tools. pi-jev never deactivates anything, so its candidate pool is whatever pi and the other extensions left inactive (verified in pi-jev: `setActiveTools` appears only at `router.ts:132`, `commands.ts:245`, `commands.ts:251`). That pool is **not** empty in a stock session: pi 0.86.1 registers `grep`, `find`, `ls`, and `powershell` as inactive builtins, so the router has four real candidates before any other extension is loaded. See fact 11 in section 8.

**Exit:** routing finds and activates at least one tool in a session that has a non-empty inactive pool, and reports `candidates: []` honestly when the pool is empty instead of spending a request.

### Milestone 7: Verification

- **Conformance:** same questions, every reachable backend, structurally identical normalized output. This is the regression net for backend API drift.
- **Agreement:** where two backends answer the same question, record agreement rate on a fixed fixture set. This is the only cheap calibration signal available without labels.
- **Latency budget:** p50 and p95 per backend for 1, 5, and 12 questions. The documented reference numbers are 33 ms single and 7.2 ms per question batched on a T4, and 32.8 ms per request with `preload=True` on GPU versus 193 to 464 ms on CPU (`laya` README), so a local MLX batch should land in the low tens of milliseconds.
- **Fail-closed:** backend down, malformed payload, timeout, and unknown criterion set all produce typed errors, never a default verdict.
- **No leaked traffic:** with a local backend selected, assert that no outbound connection is attempted. Use an injected fetch stub plus, for the CLI, an unreachable proxy to prove the negative.

**Exit:** all five suites pass, results recorded in the README with the machine they were measured on.

### Milestone 8: Documentation and optional publication

README sections:

1. One-line value and a terminal example
2. Backend matrix: what is local, what is cloud, what leaves the machine
3. Harness matrix: what works over MCP, what additionally works with the pi adapter, what cannot work anywhere
4. Calibration: which backends may be thresholded and which must be ranked, and why
5. Cost model per backend: tokens versus forward passes
6. Tool reference and the decision rule for the default threshold
7. Failure behavior
8. Development and verification commands

Publish only when Milestone 7 is green. If published, no authorship credit to any AI tool in commits, tags, or releases.

**Exit:** a reader can pick a backend, wire one harness, and understand what does and does not leave the machine without asking the maintainer.

## 4. Acceptance criteria

| Criterion | Target |
|---|---|
| Portable tool surface | 1 to 2 MCP tools, frozen for v1 |
| Backends in v1 | at least `laya-mlx`, `laya`, `jev` |
| Harness coverage without per-harness code | pi, Claude Code, Codex, all over one MCP server |
| Normalized response identity | byte-identical structure across backends for the same question set |
| Local batch latency | p50 under 150 ms for 5 questions through `laya-mlx` |
| Cold start, MCP server | under 500 ms to first tool list |
| Runtime dependencies | at most `@modelcontextprotocol/sdk` plus the Jev SDK |
| Leaked traffic with a local backend | zero in the injected-fetch test |
| Failure mode | typed error, never a default verdict and never a silent backend substitution |
| Context cost of the tool surface | one tool schema, no per-question or per-backend tools |

## 5. Risks and controls

**R1: MCP cannot route tools (structural, blocks a whole feature class).** An MCP server cannot activate or deactivate tools owned by another server or by the harness. Resolved by building the pi adapter (`src/harness/pi/`): routing, skill discovery, model switching, and orchestration live there, and the MCP surface deliberately offers judgment and gating only. Do not promise portable tool routing in the README.

**R2: Calibration does not transfer across backends.** Jev and Laya are trained against strictly proper scoring rules, so their probabilities are usable as thresholds. A generic OpenAI-compatible endpoint's self-reported confidence is not, and it typically clusters near the top of the range, which makes any fixed cutoff permissive. Control: declared calibration mode per backend (Q06) plus a ranking rule for the uncalibrated path.

**R3: Backend API drift.** The two Laya servers are independent implementations (PyTorch/MPS and MLX) that deliberately keep the same routes and payload shapes, and Jev's response shape already differs enough that pi-jev reads four alternative key spellings. Control: golden fixtures per backend plus the conformance suite in Milestone 7.

**R4: Shared-accelerator serialization.** `laya_server.py` holds a global lock because the device is a single shared accelerator, so an agent that judges on every tool call will queue behind itself. Control: client-side queue with an explicit timeout, report queueing separately from inference, and keep automatic per-tool-call judging out of v1.

**R5: The local services are not always running.** The MLX service runs under launchd and the reference service runs only when started. Control: health probe with a short cache, a clear `adecider status` output, and a typed error rather than a fallback to cloud.

**R6: Cloud leakage by configuration accident.** A cloud backend configured but not intended is one chain entry away from receiving source code. Control: local-only default, explicit enablement for cloud, and the no-leaked-traffic test.

**R7: Context tax of the tool surface itself.** Every MCP tool ships its full schema into every request on every harness. Control: freeze the tool count, keep descriptions short, and never expose one tool per backend or per primitive.

**R11: Silent truncation of a batched request (realized, then fixed).** A request over the answering backend's context window is truncated by the server rather than rejected, so the judgment returns confident answers computed on partial input. Realized in practice: 4608 tokens against a 512-token window, and it was the root cause of the bad routing measurements. Control: `Backend.contextTokens` is part of the interface, every batched judgment is budgeted to 75 percent of it, candidates that do not fit are reported rather than skipped silently, and `estimateTokens` over-estimates on purpose. Residual risk: the Jev and OpenAI-compatible windows are assumed rather than measured, so a wrong assumption there would reintroduce truncation.

**R12: A leading question produces a confident false positive.** The noul form "does X help with this task" invites agreement, so an irrelevant candidate can score 0.85 or more. Control: a recall floor in the shortlist, so a candidate with no discriminating term match is never offered; `maxSelections` caps blast radius; and routing stays additive so a false positive costs context, not correctness. Residual risk: a single generic term match still admits a wrong candidate, with a measured example in fact 15.

**R8: Harness API drift.** The pi extension API changes with pi versions. Control: MCP is the stable surface; the pi adapter is optional and versioned against the pi peer dependency, as `pi-jev` already does.

**R9: Uncalibrated local replacement.** If a non-RLCD model is used as a primary backend, thresholds from this project's own defaults become meaningless. Control: refuse to honor an absolute threshold for a backend declared `ranking`, and say so in the error rather than silently ranking.

**R10: Scope creep back to eight features.** The audited repo has eight features and two of them carry weight. Control: section 2's exclusions list is part of the plan, and adding any of them requires a new milestone plus a measured justification.

## 6. Local infrastructure and measurements

### Backends present on this machine

| Backend | Transport | Port or endpoint | Notes |
|---|---|---|---|
| `laya-mlx` | HTTP | `127.0.0.1:8317` | launchd `com.niehu.laya-mlx.plist`, MLX, about 1.6x faster than the reference service, byte-identical answers |
| `laya` | HTTP | `127.0.0.1:8318` | PyTorch/MPS reference, stdlib-only server, moved off 8317 on 2026-09-21 |
| `jev` | HTTPS | TypeSafe cloud | `TYPESAFE_API_KEY` or `~/.pi/agent/secrets/typesafe_api_key`, reports token usage |
| any OpenAI-compatible model | HTTP | `127.0.0.1:8090`, `127.0.0.1:8091` | managed by `prism-ml/serve.sh`, llama.cpp, `Ternary-Bonsai-2-27B` PQ2_0 and PTQ1_0, 131072 token context |

Both Laya services expose `GET /health`, `POST /decide`, `POST /route`, and accept `{state, questions|preset, model?, task?, lang?}`. `/route` returns the routing decision without a forward pass. Laya additionally routes between `english` and `multilingual` checkpoints by script detection in under 0.5 ms, which is a capability Jev does not have and the unified response type must carry through rather than discard.

### Measured context cost that v1 does not fix

pi injects every skill's name and description into the system prompt unconditionally (`dist/core/agent-session.js:791` passes `skills: loadedSkills`). Measured on this machine: 46 skills, 18984 characters in name plus description lines, about 5400 tokens, on every request. `pi-jev`'s skill router does not remove any of it and only appends a suggestion, which is why Q02 offers context compression as the second slot.

### Harness reality

| Harness | Integration surface | Limits |
|---|---|---|
| pi | MCP plus native TS extension | only harness where tool activation is possible |
| Claude Code | MCP (`~/.claude.json` `mcpServers`), hooks, skills | no programmatic tool activation from MCP |
| Codex | MCP plus `AGENTS.md` | same |
| mini-swe-agent | MCP or CLI | already targeted by `prism-ml/serve.sh` |

## 7. Source references

Local:

- `/Users/niehu/llm/pi-jev/src/jev.ts:107` the single backend call; `:14-38` key resolution
- `/Users/niehu/llm/pi-jev/PLAN.md:518-528` ecosystem snapshot
- `/Users/niehu/llm/laya-local/laya_server.py:20-21,60-72` global lock, routes
- `/Users/niehu/llm/laya-local/laya_local.py:35-56` served checkpoints and preset table
- `/Users/niehu/llm/laya-mlx-local/laya_mlx_server.py:5` same routes and payloads as `laya-local`
- `/Users/niehu/llm/laya-mlx-local/launchd/com.niehu.laya-mlx.plist:16` launchd port
- `/Users/niehu/llm/prism-ml/serve.sh` local OpenAI-compatible providers; `deepseek-harness-provider.md` verified server properties
- pi docs: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:2400-2510` dynamic tool loading, `:1404-1430` `registerTool` and `promptSnippet`, `:566` prompt patch and cache behavior
- pi runtime: `dist/core/agent-session.js:777-784` snippets rendered for selected tools only
- `/Users/niehu/.pi/agent/mcp.json`, `/Users/niehu/.claude.json` existing MCP client config shapes

External:

- Laya: <https://github.com/NandhaKishorM/laya>, <https://huggingface.co/convaiinnovations/laya>, <https://huggingface.co/convaiinnovations/laya-multilingual>
- TypeSafe: <https://docs.typesafe.ai/llms.txt>, <https://docs.typesafe.ai/primitives>, <https://docs.typesafe.ai/confidence>
- MCP: <https://modelcontextprotocol.io>

## 8. Answer record

Answered 2026-09-21 with `defaults`.

```text
Q01: A   batched typed judgment is v1's job
Q02: A, B   gate CLI and context compression
Q03: A, B, C   laya-mlx, laya, jev (D, OpenAI-compatible, deferred to the normalization milestone)
Q04: A   declared chain with health probe
Q05: A   typed unavailability, fail closed
Q06: A   declared calibration mode per backend
Q07: A   MCP stdio server first
Q08: A   TypeScript core over HTTP, no Python at runtime
Q09: A   one tool
Q10: A   adecider / decide / adecider-gate
Q11: A   new independent repo, pi-jev untouched
Q12: A   local-only unless cloud is explicitly enabled
Q13: A   local and private first
```

### Facts measured while starting M0, which amend the body of this plan

Corrected against the live services and the TypeSafe docs on 2026-09-21:

1. **Jev and Laya return the same payload shape.** Both put the answer under a key named after its primitive (`choice`, `noul`, `score`) and both report `probabilities`, `legend`, `confidence`, and `usage.{input_tokens,output_tokens}`. Milestone 2 therefore needs one normalizer for both, not four tolerated key spellings: pi-jev's defensive reads (`choice ?? value`, `noul ?? probability ?? value`) guard a case neither live backend produces.
2. **Laya does report token usage.** `usage.input_tokens` is present, with `output_tokens` always 0 because the model is non-autoregressive. The earlier claim that Laya has no token accounting was wrong.
3. **Laya adds two things Jev has no equivalent for:** `action.act_probability` per answer (an act/abstain head) and top-level `routing` (checkpoint choice, script and language detection, and a reason string). Carried through the normalized response rather than discarded.4. **`confidence` is not the answer probability.** TypeSafe documents it as a measure of how the distribution is spread. On a live Laya request the chosen option held probability 0.8773 while confidence was 0.5846, so a decision rule must state which number it thresholds on. `policy.ts` thresholds the peak of the distribution and treats confidence as a second gate.
5. **Only `laya-mlx` is live on this machine.** `GET 127.0.0.1:8317/health` answers under launchd (`runtime mlx`, device gpu, both checkpoints loaded). `8318` refuses connections, and there is no TypeSafe key in either location, so the Jev adapter is implemented but unverified until a key exists.
6. **The official MCP SDK was rejected.** `@modelcontextprotocol/sdk` 1.30.0 carries 16 transitive dependencies (express, hono, jose, cors, ajv, ...) for a stdio server that needs four JSON-RPC methods. The server is hand-rolled instead, which keeps the runtime dependency count at zero.
7. **Node 26 runs TypeScript directly**, so the repo has no build step and no loader flag: `node src/cli/main.ts` works, and the bins are two-line shims.
8. **The OpenAI-compatible path is verified too, and it confirms R2.** Against the local llama.cpp server on `127.0.0.1:8090/v1` (`Ternary-Bonsai-2-27B-PQ2_0`) the adapter works end to end, but the same 2-question judgment cost **26.2 s and 781 output tokens** against `laya-mlx`'s **51.5 ms and 0 output tokens**, and the chat model reported `confidence 0.98` with `probability 0.95` on a question where `laya-mlx` reported `confidence 0.5846`. The uncalibrated self-report clustered at the top exactly as R2 predicted, which is the empirical case for the `ranking` mode and for refusing a fixed threshold on that backend.
9. **Live calibration margin, measured.** On `laya-mlx`, four states that clearly satisfy or violate one criterion scored `0.974` and `0.904` against `0.085` and `0.191`, a gap of 0.71. This is the Milestone 7 signal, and it is what makes the `0.7` gate default meaningful rather than arbitrary. It is asserted in `test/live.test.ts`, which skips instead of failing when no service is up.
10. **The pi adapter shipped, so R1 is a boundary rather than a gap.** Replicating pi-jev's surface needed a harness adapter, and it is `src/harness/pi/` (12 modules): routing, skill suggestions, auto mode, model selection, tool guard, compaction, orchestration, evaluation design, and the `/adecider` command. Tool routing, skill discovery, model switching, and agent dispatch are unchanged in behaviour from pi-jev, with one deliberate change forced by the calibration rule: a `ranking` backend can never block a tool call, because a self-reported number is not grounds for stopping correct work.
11. **CORRECTION to an earlier claim in this plan.** The claim that a stock pi session has an empty inactive-tool pool, and that pi-jev's router is therefore a no-op there, is **wrong**. Measured with pi 0.86.1 loaded with no other extensions, the router found four inactive builtins: `grep`, `find`, `ls`, and `powershell`. Running the real tool in pi activated three of them in 167.6 ms through `laya-mlx` (`powershell` 0.845, `grep` 0.800, `find` 0.767, `ls` 0.692). The feature has real work to do in a stock session, and pi-jev's router was never a no-op.
12. **Measured routing quality is imperfect, and this is the honest caveat.** For the query "search code patterns structurally" the highest-scoring candidate was `powershell` at 0.845, which is a false positive; `grep` and `find` were defensible. A four-candidate pool of builtins with terse descriptions is a thin basis for a semantic judgment, and no threshold fixes a misranking. Anyone enabling automatic routing should expect this rate of error and treat activation as additive rather than authoritative.
13. **R1 is worse than a boundary: over-long requests were silently truncated.** The nine-candidate routing request serialized to **4608 tokens against Laya's 512-token window**. The server truncated rather than rejected, so the answers were computed on the surviving prefix, and this is the real cause of the bad routing quality in fact 12, not a shortage of semantic skill. Two independent framings of the same three tools scored the correct tool at 0.805 and 0.416, and the same nine-candidate input scored `lsp_navigation` 0.551 in one run and 0.242 in another with only the question order changed: the input was being cut differently each time.
14. **The fix was a budget, a recall floor, and an estimator.** `Backend.contextTokens` is now part of the interface (512 for the Laya English checkpoint, 1024 for multilingual, 8192 assumed for Jev, 4096 for OpenAI-compatible); requests are budgeted to 75 percent of it. Candidate descriptions are clipped to 160 characters and sent once instead of twice. `shortlist` now filters stopwords and requires at least one discriminating term to match. Measured after the fix, on the same real nine-tool pool: the routing request dropped from 4608 to **275 tokens**, `find` scored 0.915 for "find code definitions and references" and was activated, `grep` scored 0.842 for "search source code for a pattern" and was activated, and "draw an architecture diagram", which nothing in the pool matches, spent no request at all. The stopword filter alone fixed a degenerate ranking: `and`, `the`, and `across` were matching every long description, so the top candidates were the wordiest ones rather than the relevant ones.
15. **Remaining known false positive, with its numbers.** "refactor a large repo with parallel agents" matched one candidate on the single term `repo` and the model scored it 0.873, above the 0.65 cutoff, activating `lens_diagnostic_mark` for a task it does not serve. A recall floor cannot fix this: the candidate did share a term. Fixing it needs a stricter match rule or a non-leading question form, and neither is implemented.
16. **Jev verified against the live API.** With a key at `~/.pi/agent/secrets/typesafe_api_key`, the adapter returns `jev-1.13.0`: 945 to 1032 ms and 299 to 322 input plus 22 output tokens per single-question judgment, 1198 ms and 391 plus 70 for three questions. On the four-case discrimination set it classified all four correctly with a separation of 0.620, against Laya's 0.713 on the same cases: Jev is not the sharper backend here, and it is about 21x slower and billed.
17. **The pi adapter shipped, so R1 became a boundary rather than a gap.** Replicating the pi-jev surface needed a harness adapter, and it is `src/harness/pi/` (15 modules): routing, skill suggestions, auto mode, model selection, tool guard, compaction, orchestration, evaluation design, and the `/adecider` command. Behaviour is unchanged from pi-jev except where the calibration rule forces a change: a `ranking` backend can never block a tool call, and compaction declines rather than guessing.
18. **Auto mode verified in a real session.** With `ADECIDER_AUTO=1` and a probe extension recording the tool set, a session went from 7 active tools to 8, adding `grep` for the prompt "search source code for a pattern with a regular expression", and the model then used `grep` five times in that turn. The activation happens before the turn, so the tool is available when the model needs it rather than one round trip later.
19. **The tool guard cannot be tuned into a reliable filter, and this is measured rather than argued.** Eight calls through `laya-mlx`: fabricated scored 0.729, 0.868, 0.817, 1.000; legitimate scored 0.700, 0.537, 0.176, 0.143. The separation between the worst fabricated and the best legitimate case is **+0.029**. At the inherited 0.85 threshold it catches egregious fabrication and passes a plausible-looking invented path. The cause is structural: the question asks whether a path is fabricated without telling the model what exists, so it judges plausibility. The post-execution half of the same feature is sound for the opposite reason, since the real error text is in the state: failure classification scored **4 of 4** with confidences 0.93, 0.96, 0.94, 0.53.
20. **Everything verified, and what is not.** Verified live: the judge path through the CLI, MCP, and the pi extension; the model catalogue; the HTTP format; auto mode; the failure classifier; Jev via API key; and all three harness registrations (pi in a full session, `claude mcp list` reporting Connected, `codex mcp list` reporting enabled).
21. **Compaction: verified, after two bugs that only a real session could expose.** Driving an interactive pi session (one tool-using turn, then a real `/compact`) produced a session entry with `fromHook: true` and `usage: None`: this layer supplied the summary and **no summarization model call was billed**, against 1211 and 2695 tokens for pi's own compactions in the same session. Two defects had to be fixed first, and both were invisible to the hermetic tests because those tests encoded the same wrong assumption as the code:
    - pi's real entry shape is `{type: "message", message: {role: "toolResult"}}`, with the role nested and camel-cased. The first version matched on `type === "tool_result"`, so **every compaction silently deferred to pi** while reporting nothing. The regression test now uses an entry copied out of a real session file.
    - Session metadata (`model_change`, `thinking_level_change`) and the system message were copied into the summary as raw JSON, which put the entire system prompt into one. Both are now excluded.
    The feature is also narrower than its name: it selects what to retain, it does not summarize conversation, and it declines when a compaction has no tool traffic to judge. That is deliberate, since pi's summarizer writes better prose than a verbatim copy.
22. **The verification harness needed its own fix, and it is not the code's problem.** A tmux server on this machine was started from a directory that no longer exists, so every pane it forks aborts on `process.cwd()` before running anything; tmux's `-c` did not override it, and the same server hosts about twenty of the user's long-running jobs, so restarting it was not an option. A second server on a separate socket works, which is how the compaction run was done. Recorded because it will bite again: use a dedicated socket, and note that `=name` exact-match targets are rejected for pane targets by tmux 3.7c even though they work for session targets.
23. **Every Laya measurement in this document is now historical.** All four Laya repositories (`laya`, `laya-local`, `laya-mlx`, `laya-mlx-local`) were archived off this machine on 2026-09-21 into `~/llm/laya-archive-20260921.tar.gz`, and the launchd job for the MLX service was removed with them. Facts 8 through 19 were measured against those services while they ran and are not reproducible here until they are restored; `adecider models` now lists only `jev:jev-latest`, and the two live tests in `test/live.test.ts` skip with the reason that no local service is listening. The built-in `laya-mlx` and `laya` endpoints are deliberately left in place rather than deleted with the services: they are the project's local-first premise, they cost nothing while nothing answers on their ports, and the catalogue only lists models from backends that pass a health probe, so a stopped service cannot invent a row.
24. **A hardcoded default was advertising another project's server.** `openai` was a built-in backend pointing at `http://127.0.0.1:8090/v1`, so `adecider models` listed `openai:Ternary-Bonsai-2-27B-PQ2_0` on this machine without anyone declaring it. Removed from the defaults: an OpenAI-compatible endpoint must now be declared in the config. The reasoning that applied to cloud consent applies to a model list too, since a list of reachable models is a claim, and claiming a server that this project does not manage is not this project's to claim.

