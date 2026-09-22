# adecider

Typed System One decisions for any coding agent. One MCP tool, `decide`, answers many typed
questions about a piece of state in a single call, backed by a pluggable decision model: a local
Laya checkpoint by default, TypeSafe Jev when you have a key, or any OpenAI-compatible model as an
escape hatch.

The point is to stop asking a generative model to judge. A System One model returns probabilities
instead of prose, answers a dozen questions in one forward pass, and runs on this machine for free.

## Terminal example

```console
$ adecider judge \
    --state-file /tmp/diff.patch \
    --questions '{"satisfies":{"type":"noul","instructions":"Does the change report a refund for a duplicate charge?"},"risk":{"type":"score","instructions":"How risky is this change?","criteria":["trivial","routine","needs review","dangerous"]}}' \
    --threshold 0.7
{
  "backend": "laya-mlx",
  "calibration": "absolute",
  "elapsedMs": 51.5,
  "usage": { "inputTokens": 154, "outputTokens": 0 },
  "answers": {
    "satisfies": { "type": "noul", "value": 0.974, "score": 0.974, "confidence": 0.974 },
    "risk": {
      "type": "score", "value": 0.9, "score": 0.71, "confidence": 0.39,
      "distribution": { "0": 0.02, "1": 0.27, "2": 0.71, "3": 0.0 },
      "legend": { "0": "trivial", "1": "routine", "2": "needs review", "3": "dangerous" }
    }
  },
  "model": "english",
  "routing": { "checkpoint": "english", "reason": "English Latin text", "language": "en", "script": "latin" },
  "decisions": [
    { "id": "satisfies", "type": "noul", "value": 0.974, "score": 0.974, "passed": true },
    { "id": "risk", "type": "score", "value": 0.9, "score": 0.71, "passed": true }
  ]
}
```

The same thing through MCP, as an agent sees it: `decide` with `state` and `questions`.

## Backends

| Backend | Transport | Default endpoint | Calibration | Context window | Leaves this machine |
|---|---|---|---|---|---|
| `laya-mlx` | HTTP | `127.0.0.1:8317` | absolute | 512 (`english`), 1024 (`multilingual`) | no |
| `laya` | HTTP | `127.0.0.1:8318` | absolute | same | no |
| `jev` | HTTPS | `api.typesafe.ai/v1/systemone` | absolute | assumed 8192 | yes, and billed |
| any OpenAI-compatible | HTTP | **none: declare it** | ranking | assumed 4096 | only if the URL is not loopback |

The first three have built-in endpoints because this project can account for them. An
OpenAI-compatible server does **not**: advertising whatever answers on a fixed port, when that server
belongs to another project, would put a model into `adecider models` that nobody declared, and a model
list is a claim about what can be reached. Declare one to use it:

```json
{ "backends": { "local27b": { "kind": "openai", "baseUrl": "http://127.0.0.1:8090/v1", "model": "Ternary-Bonsai-2-27B-PQ2_0" } } }
```
`laya-mlx` and `laya` are the same model family behind two servers: the MLX build under launchd and
the PyTorch/MPS reference build, which keeps the same routes and payloads. Both speak
`GET /health`, `POST /decide`, `POST /route` and accept `{state, questions|preset, model?}`.

Verified on this machine: `laya-mlx` answered on 8317 as an MLX service under launchd with both
checkpoints resident; the `openai` adapter answered against a local llama.cpp server when declared in
the config; and the `jev` adapter answers against the real API with a live key, returning
`jev-1.13.0`. Note that all four Laya repositories were archived off this machine on 2026-09-21, so the
Laya defaults now point at nothing here and the live tests skip rather than fail. `adecider models`
only lists models from backends that answer a health probe, so a stopped service does not invent
rows.

### Request windows are small, and over-long requests are truncated silently

The context window above is load-bearing. Each backend reports it, and every batched judgment is
budgeted against it. The reason is measured: a nine-candidate tool-routing request serialized to
**4608 tokens**, and the Laya `english` checkpoint reads **512**. The server truncated the request
rather than rejecting it, so the answers came back confident and wrong for whatever fell past the
token limit. The same request with descriptions omitted from the state still measured 1762 tokens.

After budgeting, the same routing request measures **275 tokens** and picks the right tool. What the
budget costs is coverage: with a 512-token window, three candidates is what fits.

## What leaves the machine

Nothing, with a local backend. `jev` is never in the chain unless cloud use is explicitly enabled,
even when a key is present: a configured key is not consent. Two switches exist, both off by default:

- `allowCloud` in `~/.pi/agent/adecider.json`
- `ADECIDER_ALLOW_CLOUD=1`

An OpenAI-compatible backend counts as cloud when its URL is not loopback.

## Harnesses

| Harness | How it connects | What works |
|---|---|---|
| pi | native extension, auto-registered by the package; MCP as a fallback | everything: judge, gate, tool routing, skill suggestions, auto mode, model selection, tool guard, compaction, orchestration |
| Claude Code | MCP, `~/.claude.json` | judge, gate |
| Codex | MCP, `~/.codex/config.toml` | judge, gate |
| mini-swe-agent and anything else | MCP or the CLI | judge, gate |

```console
$ adecider mcp-config
```

prints ready-to-paste blocks for all three MCP clients. All three were registered and verified on
this machine (2026-09-21): pi lists the three tools plus the `/adecider` command in a full session,
`claude mcp list` reports `adecider ... Connected`, and `codex mcp list` lists it as `enabled`.

### The pi extension carries the rest

The features below need to run inside the pi process, because they react to events pi emits and call
into pi's own state. An MCP server cannot do any of it: it cannot activate another server's tools and
it receives no events.

```console
$ pi -ne -e ./src/harness/pi/index.ts      # load it explicitly while developing
```

| Feature | Tool or command | Default |
|---|---|---|
| Typed judgment | `adecider_evaluate` | always on |
| Tool routing | `adecider_find_tools` | always available; automatic firing is off |
| Skill suggestions | `adecider_find_skill` | always available; automatic firing is off |
| Auto mode | `/adecider auto [on\|off]` | **off** |
| Model selection | `/adecider auto-model [on\|off]` | **off**, and spends no backend request |
| Tool guard | `/adecider tool-guard [on\|off]` | **off**, see the measurement below |
| Model-guided compaction | `/adecider compact [on\|off]` | **off** |
| Orchestration | `/adecider agents <task>` | **off** |
| Evaluation design | `/adecider test <prompt>` | on demand |

### What is measured, not assumed

**Auto mode works.** Verified in a real pi session with `ADECIDER_AUTO=1`, using a probe extension to
record the tool set: 7 active tools at session start, 8 at `agent_end`, with `grep` added for the
prompt "search source code for a pattern with a regular expression". The model then used `grep` five
times in that turn.

**Compaction works, and is cheaper than the alternative.** Verified by driving an interactive pi
session: one tool-using turn, then a real `/compact`. The session file records
`fromHook: true` with `usage: None`, meaning this layer supplied the summary and **no summarization
model call was billed**, against 1211 and 2695 tokens for the two compactions pi handled itself in the
same session. The summary is a retained-entry list, not prose: **this feature selects what to keep, it
does not summarize conversation**, and when a compaction has no tool traffic to judge it declines and
lets pi summarize.

Getting there found two real bugs, both only visible against a real session:

1. pi's entries are `{type: "message", message: {role: "toolResult"}}`, with the role nested and
   camel-cased. The first version looked for `type: "tool_result"`, matched nothing, sent an empty
   question set, failed validation, and **silently deferred to pi on every compaction**. The test now
   uses an entry copied from a real session file.
2. Session metadata (`model_change`, `thinking_level_change`) and the system message were being copied
   into the summary verbatim as JSON, which put the entire system prompt into one. Both are now
excluded: the harness rebuilds them.

**The tool guard is a conservative filter, and cannot be tuned tighter.** It asks a `noul` question
about each tool call and blocks at 0.85. Measured on `laya-mlx`, eight calls:

| | fabricated | legitimate |
|---|---|---|
| scores | 0.729, 0.868, 0.817, 1.000 | 0.700, 0.537, 0.176, 0.143 |

A plausible-looking invented path (`cat /data7/quantum/wormhole/cache/xyz.txt`) scored 0.729 and is
**not blocked**; a legitimate `git log` scored 0.700. The separation between the worst fabricated and
the best legitimate case is **+0.029**, so there is a threshold that separates these eight samples and
no margin to trust it on a ninth. At 0.85 the guard catches egregious fabrication (an invented script
name scored 1.000) and passes everything else. Treat it as a filter for nonsense, not as a
hallucination detector, and do not lower the threshold without measuring your own cases.

The reason is structural rather than a tuning problem: the model is asked whether a path is fabricated
without being told what exists, so it is guessing plausibility. The post-execution half of the same
feature has the information and works: classifying a real failure into `missing_file`,
`syntax_flag`, `permission_env`, or `runtime_other` scored **4 of 4 correct** with confidences of
0.93, 0.96, 0.94, and 0.53.

The tool names map one-to-one onto pi-jev's `jev_find_tools`, `jev_find_skill`, and `jev_evaluate`,
so a migration can be checked surface by surface.

**Tool routing is the one capability no MCP client can have.** An MCP server cannot activate or
deactivate tools owned by another server or by the harness. Outside pi, this project offers judgment
and gating only, and says so rather than shipping a router that cannot route.

## Calibration: which backends may be thresholded

The two modes are not interchangeable.

- **`absolute`** for Jev and Laya. Both are trained against strictly proper scoring rules, so a
  probability is a probability and a fixed threshold means something. Measured with a criterion that
  four states clearly satisfy or violate, on the same four cases:

  | Backend | positive cases | negative cases | separation |
  |---|---|---|---|
  | `laya-mlx` | 0.974, 0.904 | 0.085, 0.191 | 0.713 |
  | `jev` | 0.840, 0.760 | 0.030, 0.140 | 0.620 |

  Both classify all four correctly, and a margin above 0.6 is what makes `--threshold 0.7` a
  reasonable default rather than an arbitrary one. Note that Jev is not the sharper of the two here,
  and it is roughly 21x slower and billed per call.
- **`ranking`** for anything that was not trained that way. A chat model's self-reported certainty
  clusters near the top regardless of correctness, so thresholding it selects almost everything. Use
  `--top-k` instead, which only relies on the ordering.

Measured contrast, same question ("Which team should handle this?", same criteria, same state):

| Backend | Chosen option | Peak probability | Confidence |
|---|---|---|---|
| `laya-mlx` | billing | 0.8773 | 0.5846 |
| `local27b` (27B chat model) | billing | 0.95 | 0.98 |

The chat model agrees on the answer and reports near-certainty it has not earned. Ranking survives
that; a 0.7 threshold against it would pass essentially everything.

Asking for a fixed threshold against a `ranking` backend is **refused**, not silently downgraded.
`--allow-uncalibrated` overrides it and marks every verdict `uncalibrated`.

Two numbers are reported per answer and they are not the same axis:

- `score`: the answer's strength. For `noul` it is the probability itself; for `choice` and `score`
  it is the peak of the returned distribution.
- `confidence`: how concentrated that distribution is. On a live request the chosen option held
  probability `0.8773` while confidence was `0.5846`.

`--threshold` compares `score`. `--min-confidence` is a second, optional gate on the other axis.

## Cost model

| Backend | Metered by | Observed |
|---|---|---|
| Laya (local) | nothing; wall time and forward passes | 45 to 72 ms for a 3-question judgment on this machine, 145 to 154 input tokens, `output_tokens` always 0 |
| Jev | tokens, billed per request | 945 to 1032 ms for a single-question judgment and 1198 ms for three questions; 299 to 322 input and 22 to 70 output tokens |
| OpenAI-compatible | tokens | 26.2 s for a 2-question judgment, 397 input and 781 output tokens (local 27B over llama.cpp) |

Laya reports `usage.input_tokens` with `output_tokens` always 0, because it is non-autoregressive:
one forward pass, no generated text. A chat backend has to generate the JSON, which is where the
781 output tokens and the 500x latency difference come from: the same judgment that costs 45 ms
through `laya-mlx` costs 26 s through a 27B model on the same machine. Jev generates JSON too, but it
is a 420M-class decision model rather than a 27B chat model, so it lands at 1.2 s instead of 26 s.

## Models

A caller names a **model**, not a service. `adecider models` lists what is available and how each one
is reached:

```console
$ adecider models
MODEL           KIND  CALIBRATION  SCOPE  WINDOW  AUTO
jev:jev-latest  jev   absolute     cloud  8192    yes

AUTO=yes means the model answers when no model is named. Others must be named explicitly.
automatic chain: jev
```

Laya rows appear here whenever those services are running, one row per checkpoint resident. A backend
that fails its health probe contributes no row at all, so this list is a report of what can be reached
rather than a report of what was configured.

A model can be named bare when its name is unambiguous (`english`), qualified by transport when it is
not (`laya-mlx:english`, `jev:jev-latest`), or by transport alone (`jev`). Model ids come from each
backend's own health probe rather than a list kept here, so a service that loads a different
checkpoint is described correctly.

The **`AUTO` column is the privacy boundary.** Every configured and permitted backend is nameable,
which is how Jev is one of decider's models: it answers when you ask for it by name. Only the ordered
chain answers when no model is named, and that chain is local by default, because a local service
being down is not consent to send source code to a hosted API. Naming a cloud model is an explicit
act and is treated as one.

Note the per-model windows: `multilingual` reads 1024 tokens where `english` reads 512, and the
budget follows the model. Forcing `multilingual` on English text is possible and measurably worse
(0.024 where `english` answered 0.968 on the same question), so prefer `english` or let the local
service route.

## One HTTP format over every model

```console
$ adecider serve --port 8319
```

The route and payload names follow the Laya services already running on this machine, so this endpoint
replaces a single-model service rather than adding a fourth dialect.

| Route | Body | Returns |
|---|---|---|
| `GET /health` | | every backend, its health, its models, and whether it is automatic |
| `GET /models` | | the model catalogue |
| `POST /route` | `{model}` | which model would answer, its window, without spending a judgment |
| `POST /decide` | `{model?, backend?, state, questions, threshold?, top_k?, min_confidence?, allow_uncalibrated?}` | the normalized answers, and verdicts when a rule was given |

```console
$ curl -s localhost:8319/decide -H 'content-type: application/json' \
    -d '{"model":"jev:jev-latest","state":"a duplicate charge","questions":{"churn":{"type":"noul","instructions":"Does the customer threaten to cancel?"}},"threshold":0.7}'
```

The same request with `"model":"english"` answers from the local MLX checkpoint instead. Same shape,
same error codes, one selector.

Failures keep their meaning over HTTP: `400` for a request this layer refuses (including a threshold
against an uncalibrated model, checked before the backend is called), `401` for a missing key, `502`
for an unreachable backend, `503` for a backend that is up but overloaded. `GET /health` still returns
`200` during an outage and reports the outage in its body, so a probe never has to infer state from a
failure code.

## Tool reference

One tool, `decide`.

| Argument | Required | Meaning |
|---|---|---|
| `state` | yes | The material to judge: text, a diff, a log, or a JSON object |
| `questions` | yes | Map of stable ids to `{type, instructions, criteria}` |
| `model` | no | Model selector: `english`, `multilingual`, `jev:jev-latest`. Resolves to a transport |
| `backend` | no | Force a transport by name, bypassing model resolution. Never falls back |
| `threshold` | no | Add pass/fail verdicts against this score |
| `top_k` | no | Rank instead of thresholding |
| `min_confidence` | no | Second gate on the confidence axis |
| `allow_uncalibrated` | no | Permit thresholding a `ranking` backend |

Question types, and what each returns:

- `noul`: probability that a statement is true, in `[0,1]`. A `criteria` string on a `noul` question
  is a clarification. Laya takes it as written; the Jev adapter rewrites it into the object form that
  API requires, and Jev's answer does not depend on it (measured: 0.67 with the field and without it,
  where the string form is rejected outright with HTTP 422).
- `choice`: exactly one option from `criteria`, an object mapping option keys to descriptions.
  Returns the winner plus the full distribution.
- `score`: one level from `criteria`, an array of rubric levels ordered lowest first. Returns the
  level, the distribution, and a `legend` mapping level index back to the rubric text.

Ask several questions per call. Every question in one request costs one round trip, not one call
each: a dozen `noul` questions about one state is a single forward pass.

No pass/fail verdict is invented. Without `threshold` or `top_k` you get answers with scores and no
`decisions` array, because choosing a cutoff is the caller's business.

## Failure behaviour

Every failure is typed, and none of them produce a verdict. Codes: `unreachable`, `unconfigured`,
`bad_request`, `bad_response`, `timeout`, `busy`, `calibration`, `unsupported`. `busy` exists so an
overloaded or rate-limited backend is not reported as the caller's mistake: TypeSafe answered HTTP 529
on a live call, and the first version of this reported that as `bad_request`, which is wrong and
unactionable. A `busy` status on the Jev path gets one bounded retry before it surfaces.

- A backend that is down yields `unreachable` naming every probe that failed. It never substitutes
  another backend, and a backend named explicitly never falls back at all.
- A payload this layer cannot read yields `bad_response` rather than a guessed answer.
- Over MCP, a failed judgment is a tool result with `isError: true`, not a JSON-RPC error, because
  the call itself was well formed.

`adecider-gate` exit codes: `0` pass, `1` fail, `2` error. `--fail-open` turns an outage into a pass
and says so on stderr, so an outage is never confused with a verdict. Its default threshold is `0.7`,
stricter than the `0.65` that suits a suggestion.

## Configuration

`~/.pi/agent/adecider.json`, all fields optional:

```json
{
  "chain": ["laya-mlx", "laya"],
  "allowCloud": false,
  "backends": {
    "laya-mlx": { "kind": "laya", "baseUrl": "http://127.0.0.1:8317" },
    "local-27b": { "kind": "openai", "baseUrl": "http://127.0.0.1:8090/v1", "model": "Ternary-Bonsai-2-27B-PQ2_0" }
  }
}
```

Environment overrides: `ADECIDER_CONFIG` (config path), `ADECIDER_CHAIN` (comma-separated chain),
`ADECIDER_ALLOW_CLOUD`.

Chain order matters: the first backend that passes a health probe takes the call. Probe results are
cached for 5 seconds.

### Behind a proxy

Node's `fetch` ignores `HTTP_PROXY` and `HTTPS_PROXY` unless they are opted into: set
`NODE_USE_ENV_PROXY=1` (or pass `--use-env-proxy`), which exists from Node 24.5.0, and every request
uses them. Measured 2026-09-24 on a machine whose egress route dropped Node's connection to
`api.typesafe.ai` while `curl` and Node's own `https` module reached the same host: without the opt-in
a judgment failed as `unreachable: ... fetch failed`, and with
`NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897` the same judgment answered in 2.0 s.

Two things this makes worth knowing. `adecider status` reports `jev` from its configuration rather than
from a live probe, because a probe would spend a billed request on every status call, so `ok` there
does not mean the API is reachable. And a transport failure now names its cause when Node reports one
(`fetch failed (UND_ERR_CONNECT_TIMEOUT)`), which is the difference between a wrong URL and a blocked
route.

### The Jev endpoint is allowlisted

`jev` is the one backend that attaches a bearer key to every request, so its endpoint may be the
vendor host (`api.typesafe.ai`) or loopback (a stand-in for tests) and nothing else: a `baseUrl`
pointing anywhere else is refused when the backend is built, naming the host it would have sent the
key to. Every endpoint this layer calls is also checked for an http(s) scheme. Hosts are otherwise
the operator's own declaration, which is why the `openai` backend still takes any URL it is given.

## Development

Node 23.6 or newer. That is the first release that runs the source as TypeScript with no flag (its
changelog for 2025-01-07, version 23.6.0, is where `--experimental-strip-types` became the default),
which is why there is no build step. Zero runtime dependencies.

```console
npm run typecheck      # tsc --noEmit
npm test               # hermetic, and prints its own count; the two live ones skip if nothing listens
npm run check          # typecheck then the suite: the one command to run before claiming a change works
npm run status         # probe the chain
```

Both `bin/*.js` shims are executable, so the CLI is one symlink away from being a command:

```console
ln -sfn "$PWD/bin/adecider.js" ~/.local/bin/adecider
ln -sfn "$PWD/bin/adecider-gate.js" ~/.local/bin/adecider-gate
```

`.github/workflows/check.yml` runs `npm run check` on 23.6 and on a current line, with the actions
pinned to the commit each release tag points at. Nothing in CI needs a model: the live tests skip.

Tests cover normalization against payloads measured from the real backends, conformance across the
three wire dialects on the same numbers, one round trip per judgment whatever the question count, the
decision rules, each transport's failure modes against a local stand-in, configuration resolution and
its environment overrides, the CLI entry points as a process (exit codes, stdout contract), the three
pi tools and the other pi-only paths through a fake pi API, and the full MCP surface by spawning the
server and speaking JSON-RPC to it. The live tests assert the calibration margin, agree between two
running services when both are up, and skip rather than fail when nothing is listening.
`ADECIDER_LIVE_URLS=name=url,...` points them at services on other ports, including at stand-ins.

## Limits

- Tool routing exists only in the pi extension. See the harness table for why.
- Requests are budgeted against the answering backend's context window, which for the Laya English
  checkpoint is 512 tokens. A batched judgment therefore covers about three candidates with
  descriptions, not ten. Dropped candidates are reported rather than silently skipped.
- Tool routing needs a lexical term match to offer any candidate at all. When nothing matches, it
  judges nothing and spends no request, which is deliberate: the yes/no question invites agreement,
  so offering an irrelevant candidate produces a confident false positive. A match on a single
  generic term can still admit a wrong candidate.
- Model-guided compaction selects retained history, it does not write a summary. It also declines when
  a compaction has no tool traffic, because pi's own summarizer is better at prose than a verbatim
  copy would be.
- The pre-execution tool guard is a filter for nonsense, not a hallucination detector, and its
  measured separation is too small to tune tighter. See the measurement above.
- No automatic mode is on by default. Nothing runs per prompt until you enable it.
- The local servers hold a global lock because the accelerator is shared, so concurrent judgments
  queue. `elapsed_ms` therefore includes queueing, not just inference.
- The `openai` backend is a fallback for models that are not System One models, and it must be
declared in the config: no endpoint is assumed. It batches all questions into one call, but its
numbers are not calibrated, so it is `ranking` only.
- The tool guard adds one backend request per tool call. That is a real cost on a cloud backend.
- `/adecider agents` needs a subagent runner installed. Without one, dispatch reports that instead
  of running the workflow itself.

## License

MIT.
