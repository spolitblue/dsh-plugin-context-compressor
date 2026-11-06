# dsh-plugin-context-compressor

English | [中文](README.zh.md)

Model-facing context compression for DeepSeek Harness.

## Why this exists

DSH already condenses a long conversation. `@deepseek-ai/dsh-compaction-basic`
condenses automatically as token pressure builds, and `@deepseek-ai/dsh-command-compact`
gives the human a `/compact` command. Both are mounted in the shipped `dsh-base` bundle.

What the Harness does **not** ship is any way for the *model* to notice context
pressure and act on it. The compaction package states this as a known limitation:

> **Human command, not a model tool** — condensation is triggered by the `/compact`
> command and by automatic pressure; no model-facing compaction tool is registered.

So a long agentic task can only wait for the automatic step-pressure threshold to be
crossed. This plugin registers that missing model-facing surface: two tools that let
an agent measure its own context and free it deliberately.

## The two tools

### `context_status` — read-only, parallel-safe

Measures the live conversation surface and reports how much of it could be
condensed right now:

- total surface tokens, split into the system prompt and messages;
- whether a compaction backend is mounted;
- the exact span `context_compress` would replace, and how much of the tail it
  would keep verbatim;
- optionally, the individual surface items (`seq`, `kind`, `tokens`) so the model
  can see what dominates the context.

Use it before a long stretch of reading or searching to decide whether to free
context first.

### `context_compress` — exclusive

Replaces the oldest safe span of the conversation with a single summary
checkpoint through the mounted `ctx.compaction` backend, keeping a recent tail
verbatim. Supports `dryRun` to preview without changing anything.

## How it works

Everything goes through the backend-independent compaction seam
(`ctx.compaction`), so this plugin works with any backend and never appends
session events itself.

The interesting part is *which* operation to call. The seam has two entry points
and they have opposite preconditions:

| Operation | Precondition | Usable from a tool call? |
|---|---|---|
| `compactNow(agent, …)` | the agent must be **idle** (`agent.runMaintenance`) | **No** — a tool call runs inside a turn, so this always fails `busy` |
| `compactRegion(start, end, agent, signal)` | the session must have an **open turn** | **Yes** — a tool call is enclosed in the turn |

A model-facing compressor therefore has to be built on `compactRegion`, with the
span chosen so that it cannot split a step's assistant tool-call / tool-result
pair. This plugin selects that span with the same retention and tool-pairing
rules the automatic path uses, reusing the public
`toolPairingBalancedBefore` helper from `@deepseek-ai/dsh-compaction` rather
than reimplementing the balance fold.

`context_compress` is also declared **not** concurrency-safe, so the tool
registry runs it exclusively and it can never race a sibling tool call for the
same surface.

## Configuration

The plugin's `Config` is validated at activation, so these values live in your
own patch layer (`$DSH_PROFILE_DIR/cordis.patch.yml`) and survive upgrades:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Register the tools at all. Off leaves the plugin mounted but inert. |
| `keepRecentTokens` | `20000` | Default recent tail kept verbatim by `context_compress`, in tokens. |
| `minCompactTokens` | `2000` | Refuse a span smaller than this, so a summary call is not spent to save a few hundred tokens. |
| `maxNodesListed` | `60` | Row cap for the optional surface listing in `context_status`. |

Both `keepRecentTokens` and the `dryRun` flag can be overridden per call by the
model.

## Install

Through the Plugin Manager page in the Harness Web UI, pointing at this package
directory, or from the CLI:

```
dsh plugin --profile desktop add <absolute path to this directory>
```

Installing a bundle adds it to the profile's `dsh.profile.bundles`, which is
what makes its `cordis.patch.yml` layer apply. A newly installed bundle can
activate through HMR; replacing an already-installed package needs a restart.

### Compatibility

`peerDependencies` on `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-compaction`
are checked against the single running DSH runtime version, and a mismatch makes
the harness **skip the bundle**. They are pinned to `^0.2.0-rc.2`, the runtime
this plugin was built and verified against. Widen them on a DSH upgrade.

These peers are also what makes the plugin's bare imports resolve: DSH routes a
linked profile package's imports to the runtime table only for names the linked
package declares as peers.

## Tests

```
node --test "tests/*.test.js"
```

20 unit tests cover the pure layers — span selection (leading system prompt is
never condensed, the retention budget is honoured, a tool call is never split
from its result, alignment failures degrade to no-op) and the reporting
arithmetic and wording. They need no Harness session.

## Verified behaviour

Verified end to end against `dsh --profile cct-test` (a throwaway profile created
from the shipped `headless` template) with an overlay that lowers the retention
budget so a short test conversation has something to compress:

- `context_status` with the default 20000-token tail reported `no-safe-range` for
  a short conversation, and `compressible` with a span and token count once the
  tail was lowered — the intended behaviour in both directions.
- `context_compress` with `dryRun` previewed accurately and changed nothing.
- `context_compress` committed a real checkpoint:
  `Compressed 5 history items (~1,159 tokens) into one summary checkpoint (seq 28).
  The conversation surface is now ~1,616 tokens.`
- The plugin activates with no startup warnings and the run exits 0.

## Known limitations

- **A very small span may not summarize.** The shipped backend rejects a
  summarization that yields no text, and an almost-empty input can do that. The
  default `minCompactTokens: 2000` keeps the tool away from that case, and the
  plugin reports the failure as a model-readable outcome instead of corrupting
  the session.
- **Compression cannot help the current step.** Freeing context takes effect for
  the *next* request; it does not shrink the request already being assembled.
- **The summarization call costs tokens.** It reuses the conversation's own
  prefix for KV-cache reuse, but it is still a model call.
- **No range argument.** Unlike the programmatic `compactRegion`, the tools
  accept only a retention budget, not explicit surface sequences. An explicit
  range is a reasonable follow-up if a model ever needs to target a specific span.

## Layout

| Path | Role |
|---|---|
| [`index.js`](index.js) | Plugin entry: `apply`/`inject`/`Config`, both tool definitions, surface reading, span planning |
| [`src/selection.js`](src/selection.js) | Pure span selection and token pricing |
| [`src/report.js`](src/report.js) | Pure composition arithmetic and model-facing wording |
| [`cordis.patch.yml`](cordis.patch.yml) | Bundle layer that inserts the plugin row |
| [`tests/selection.test.js`](tests/selection.test.js) | Span-selection tests |
| [`tests/report.test.js`](tests/report.test.js) | Reporting tests |
