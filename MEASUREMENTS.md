# Measurements

The dated evidence behind `README.md`. This file is where a number lives, with the date and the machine
it came from; `README.md` stays the reference for using the tool, and `AGENTS.md` for changing it.
Nothing here is a contract: a claim keeps the tense it was measured in, and a figure that has not been
re-measured does not silently become current.

## Backend availability on this machine

Verified on this machine: `laya-mlx` answered on 8317 as an MLX service under launchd with both
checkpoints resident; the `openai` adapter answered against a local llama.cpp server when declared in
the config; and the `jev` adapter answers against the real API with a live key, returning
`jev-1.13.0`. The four Laya repositories were archived off this machine on 2026-09-21, and the MLX
deployment was rebuilt on 2026-09-22: the checkout came back from the upstream tarball, the 20 weight
files passed `verify_checksums.py` against the published metadata, and the service runs under the
launchd agent `com.niehu.laya-mlx` (`RunAtLoad` plus `KeepAlive`), so it survives the terminal or tmux
session that started it. The PyTorch/MPS reference build has its package installed but not its
weights, so 8318 is down. `adecider models` only lists models from backends that answer a health
probe, so a stopped service does not invent rows.

## Request windows: small, and an over-window request is refused, never truncated

The context window above is load-bearing. The reason is measured: a nine-candidate tool-routing
request serialized to **4608 tokens**, and the Laya `english` checkpoint reads **512**. The server
truncated the request rather than rejecting it, so the answers came back confident and wrong for
whatever fell past the token limit. The same request with descriptions omitted from the state still
measured 1762 tokens.

Three layers keep that from happening again:

- The harness budgets what it batches. Tool routing clips descriptions and asks about as many
  candidates as fit, reporting the ones it dropped, and the prompt's own cost comes out of the same
  budget. After budgeting, that routing request measures **275 tokens** and picks the right tool.
  What the budget costs is coverage: with a 512-token window, three candidates is what fits.
- Compaction carries each entry's text once, in its question, never duplicated in the state, and
  budgets its questions the same way. Entries past the budget are kept, not dropped, and the count
  appears in the summary.
- The Laya adapter is the backstop for the surfaces with no budget of their own (the CLI, MCP, the
  HTTP server): it refuses a request whose conservative token estimate exceeds the window, as a
  typed failure naming the estimate, the window, and the wider `multilingual` checkpoint. The
  refusal happens before the request is spent.

A backend payload that omits an asked question id is reported in `missing` rather than absorbed:
the caller sees which ids came back short, and a rule (threshold, top-k) only ever sees the answers
that actually arrived.

## Harness registration

`adecider mcp-config` prints ready-to-paste blocks for all three MCP clients, and all three were
registered and verified on this machine (2026-09-21): pi lists the three tools plus the `/adecider`
command in a full session, `claude mcp list` reports `adecider ... Connected`, and `codex mcp list`
lists it as `enabled`.

## What is measured, not assumed

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

A compaction this layer supplied is also marked in the transcript, because pi renders its own card as
`[compaction]` whoever wrote the summary (the label comes from `CompactionSummaryMessageComponent`,
which an extension cannot replace). A custom entry carries what pi's card cannot say, in the order the
session stores it:

```text
 [compaction]
 Compacted from 24,466 tokens (ctrl+o to expand)
 [adecider compaction] default summarizer skipped, kept 2 of 9 entries
```

There is still one compaction: the card is pi's rendering of the single compaction entry, and its
summary is the one this layer supplied, so pi's own summarizer never ran (`fromHook: true`,
`usage: None`). The marker appears below the card whenever the session is replayed. It can appear
above it during the compaction itself, because pi paints its own card after the handlers return, and
that paint order is not something an extension can set. The marker is stored as a custom entry, so it
costs no context, and it is appended only when the summary came from this layer: pi summarizing for
itself gets no marker. Expanding it shows the judged and over-budget counts and the backend that
answered.

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

**A third of the calls reached a backend.** Measured 2026-09-25 on this machine, 16 pi sessions in the
adecider checkout, driven by `pi -p` with the extension loaded, auto mode off, and a fixed state file
naming a change to `normalize.ts`. Two backends, four sessions per cell, and a `judge` prompt ("should
this be reviewed before it ships") versus a `code` prompt that needs no probability at all:

| Backend in `chain` | Prompt | `adecider_evaluate` intents | Reached a backend |
|---|---|---|---|
| `laya-mlx` | judge | 11 | 4 |
| `laya-mlx` | code | 12 | 4 |
| `jev` | judge | 16 | 5 |
| `jev` | judge, without the extra guideline below | 11 | 4 |

The failures were not the backend's: 39 of 60 calls never reached one, and every one of them was the
model building an unusable payload. Three classes, all reported by the tool as
`Validation failed ... questions.<id>.instructions: must have required property`,
`Validation failed ... questions: must be object`, or
`Evaluation failed: bad_request: choice question "<id>" needs a non-empty criteria object`. The last
class is this layer refusing the call, which is why it arrives as a `200`-shaped tool result rather
than as `isError`: the tool ran and answered that the request was unusable. Latency and price are the
backend's business (`jev` took 1511 to 5558 ms per call, `laya-mlx` 55 to 86 ms); payload
construction is not, and a description that states the shape is the only lever the measurement
supports. `adecider_evaluate`'s description now carries the payload example, the required
`instructions`, and what `choice` and `score` need in `criteria`; the parameter schema carries the same
shape at the field the model fills in, `criteria` included. Re-measured the same day, four more `jev`
sessions with the fix in place and nothing else changed: **5 intents, 4 reached a backend (80%)**, against
9 of 27 (33%) before it. The one failure left was the same class, a question object missing
`instructions`. Note what else moved: intents per session fell from 2.75 and 4.00 in the two earlier
`jev` cells down to **1.25**, so
most of the earlier "failures" were the model retrying a payload it had built wrong, which an accurate
description removes by getting the first call right.

The same sessions tested a second hypothesis and rejected it. Adding a guideline that names the
trigger ("when you catch yourself about to estimate a probability or a confidence, pick between
alternatives, or rate something on a rubric, run adecider_evaluate instead") changed nothing on the
judge prompt (2.50 versus 2.75 intents per session, n=4 each) and induced calls on the code prompt
that otherwise made none (3.00 versus 0.00, n=4 each). The lever is whether the task is a judgment,
not whether the prompt lists a rule, so the bullet was not kept. What the sessions did show is that
a judgment-shaped prompt gets the tool called several times per session without any rule at all.

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
| Laya (local) | nothing; wall time and forward passes | 19 to 33 ms for a 3-question judgment on this machine (6 runs, 2026-09-22, warm service); 45 to 72 ms on 2026-09-21; 145 to 154 input tokens, `output_tokens` always 0 |
| Jev | tokens, billed per request | 945 to 1032 ms for a single-question judgment and 1198 ms for three questions; 299 to 322 input and 22 to 70 output tokens |
| OpenAI-compatible | tokens | 26.2 s for a 2-question judgment, 397 input and 781 output tokens (local 27B over llama.cpp) |

Laya reports `usage.input_tokens` with `output_tokens` always 0, because it is non-autoregressive:
one forward pass, no generated text. A chat backend has to generate the JSON, which is where the
781 output tokens and the 500x latency difference come from: the same judgment that costs 45 ms
through `laya-mlx` costs 26 s through a 27B model on the same machine. Jev generates JSON too, but it
is a 420M-class decision model rather than a 27B chat model, so it lands at 1.2 s instead of 26 s.

## Per-model windows

The windows differ per checkpoint and the budget follows the model. Forcing `multilingual` on English text is possible and measurably worse: 0.024 where `english` answered 0.968 on the same question (2026-09-22).

## Behind a proxy

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
