# Cross-Layer Thinking Guide

> **Purpose**: Think through data flow across layers before implementing.

---

## The Problem

**Most bugs happen at layer boundaries**, not within layers.

Common cross-layer bugs:

- API returns format A, frontend expects format B
- Database stores X, service transforms to Y, but loses data
- Multiple layers implement the same logic differently

---

## Before Implementing Cross-Layer Features

### Step 1: Map the Data Flow

Draw out how data moves:

```
Source → Transform → Store → Retrieve → Transform → Display
```

For each arrow, ask:

- What format is the data in?
- What could go wrong?
- Who is responsible for validation?

### Step 2: Identify Boundaries

| Boundary              | Common Issues                     |
| --------------------- | --------------------------------- |
| API ↔ Service         | Type mismatches, missing fields   |
| Service ↔ Database    | Format conversions, null handling |
| Backend ↔ Frontend    | Serialization, date formats       |
| Component ↔ Component | Props shape changes               |

### Step 3: Define Contracts

For each boundary:

- What is the exact input format?
- What is the exact output format?
- What errors can occur?

---

## Common Cross-Layer Mistakes

### Mistake 5: Polling Assumes Transitional States Persist

### Mistake 7: Authoritative Input Routed Through Heuristic Resolution

When a resolver built for INFERRING context (e.g. walk up from a session
cwd to the nearest `.trellis`) is reused for EXPLICIT user input (a
directory the user just picked), the heuristic silently overrides the
user's intent. Real case: picking `~/Downloads/codes` climbed to a stray
`~/.trellis` and registered the entire `$HOME` as a project root
(aeba090e).

Rules:

- Explicit picks get a direct predicate (`isDirectProjectRoot`) that
  checks ONLY the input itself; heuristic resolvers stay reserved for
  auto-inferred paths (session cwds, file-derived guesses)
- Name the distinction: `resolveProjectRoot` (inference) vs
  `isDirectProjectRoot` (authority). If a pick handler calls anything
  that walks up, that's the bug
- Same trap in styling: selectors written against IMAGINED class names
  (`.trellis-tree-row`) match nothing when rows render as
  `.trellis-task-row` — always grep the `className =` site before
  writing CSS against it

**Check yourself**: "Does this code path receive user-explicit input?
Then every helper it calls must terminate at the input, never beyond."

### Mistake 6: Measurement Feeds The Layout It Measured

When the renderer measures a DOM element (`offsetHeight` and friends) and
reports the value back to the main process, which then resizes the very
window hosting that element, the measurement joins a feedback loop. If the
measured element can shrink (flex children in an `overflow:hidden` column
flexbox), the loop runs away: small window → compressed element → smaller
reported value → smaller window. Symptom: UI gets *smaller* on every update,
which looks nothing like a sizing bug.

Rules:

- Measured elements must opt out of flex shrink (`flex: 0 0 auto`) so the
  reported value is the natural height, never the compressed one
- Measure after layout settles (post-rAF), with a sync fallback for test
  harnesses that have no frame loop
- Damp tiny deltas (ignore `|Δ| < 2px`) so sub-pixel jitter cannot loop
- Fixed constants are fine only for rows whose height is itself fixed;
  wrapped/elastic content must be measured

**Real-world example**: the HUD trellis detail row (see
`trellis-panel-contract.md` §4.1) first used a hardcoded 44px (truncated on
wrap), then measured `offsetHeight` without `flex: 0 0 auto` — the HUD
shrank on every click until the row vanished. The fix was all three rules
at once.

**Bad**: 庆祝/告警逻辑挂在「轮询周期内能观察到中间状态」上（如 status 翻转为 done）

**Good**: 先验证生产方是否原子变更（删指针+移目录同一次提交）——中间态可能根本不落盘。检测事件要考虑负空间：绑定消失 + 归档副本出现 = 完成；无副本的消失 = 静默。案例：trellis 归档庆祝首版永不触发（ffb0d21f）

### Mistake 1: Implicit Format Assumptions

**Bad**: Assuming date format without checking

**Good**: Explicit format conversion at boundaries

### Mistake 2: Scattered Validation

**Bad**: Validating the same thing in multiple layers

**Good**: Validate once at the entry point

### Mistake 3: Leaky Abstractions

**Bad**: Component knows about database schema

**Good**: Each layer only knows its neighbors

### Mistake 4: Every Consumer Parses The Same Payload

**Bad**: A command reads JSONL events and casts fields inline:

```typescript
const thread = (ev as { thread?: string }).thread;
const labels = (ev as { labels?: string[] }).labels;
```

This looks local, but it means every consumer owns a private version of the
event contract. The next field change will update one command and miss another.

**Good**: Decode once at the event boundary, then export typed projections:

```typescript
if (!isThreadEvent(ev)) return false;
return ev.thread === filter.thread;
```

**Rule**: For append-only logs, JSON streams, RPC payloads, or config files,
create one owner for:

- event / payload type definitions
- type guards and normalization from `unknown`
- metadata projections used by UI commands
- reducers that replay state from the source of truth

Rendering code may format fields, but it must not redefine the payload contract.

---

### Mistake 8: Derived Bookkeeping Shorter-Lived Than Its Authoritative Store

When the authoritative data is persisted (e.g. project roots in
`~/.clawd/trellis-roots.json`) but bookkeeping ABOUT that data — the
basis of a user-visible behavior like "one removable row per picked
folder" — lives in a process-local Map, the feature silently
degrades after every relaunch. Real case: pick rows worked until
restart, then the UI regressed to per-root removal (f853b513).

Rules:

- Bookkeeping that a user-visible operation depends on must live at
  least as long as the data it describes — i.e. in the SAME store,
  persisted in the SAME atomic write, not a parallel process-local
  structure
- Loading legacy on-disk data that lacks the bookkeeping may INFER it
  (one pick per distinct parent directory) — inference is legal on
  persisted data at load time; it stays illegal on explicit user
  input (Mistake 7)
- Any "survives a restart" UI promise needs a reload smoke assertion:
  create a fresh store over the same file and assert the bookkeeping
  is still there

**Check yourself**: "If the process died right now and restarted,
would the user still see this behavior?" If the answer depends on a
Map in main, move it into the persisted store.

### Mistake 9: Writing Callers Against Unverified Contract Guesses

Real case (v4-b readTaskNetwork): the test + implementation went
through SIX red-green round trips, each one exposing a single
unverified assumption about the module being called — a harness
helper that did not exist, a return field name (`absTaskDir` vs
`absDir`), which of two path constants the trust surface actually
used, a `{ok, value}` wrapper treated as a bare object, and an
off-by-one slice offset. None of these were exotic; all of them
were written down in the module's own existing tests, unread.

Rules:

- Before writing ANY caller of an in-repo helper, read two things:
  the helper's actual return statement and ONE existing test that
  exercises it (10 seconds). Guessing contract details and letting
  the test runner refute them one at a time is the slowest possible
  discovery loop.
- When a fix corrects one assumption, immediately audit the
  remaining code you wrote for OTHER assumptions of the same kind —
  do not wait for the next red.
- Bulk edits via string replace must anchor on a multi-line block
  (3+ lines of context), never a bare single-line pattern — an
  unanchored `replace('setPersistedRoots([CWD])', ...)` once leaked
  into an unrelated trust-surface test and sent debugging in the
  wrong direction.

**Check yourself**: "Am I about to name a helper, field, or wrapper
shape I have not seen with my own eyes?" If yes, look it up first.

## Checklist for Cross-Layer Features

Before implementation:

- [ ] Mapped the complete data flow
- [ ] Identified all layer boundaries
- [ ] Defined format at each boundary
- [ ] Decided where validation happens

After implementation:

- [ ] Tested with edge cases (null, empty, invalid)
- [ ] Verified error handling at each boundary
- [ ] Checked data survives round-trip
- [ ] Checked that consumers import shared decoders / projections instead of
      casting payload fields locally
- [ ] If any measured size is reported across layers: confirmed the measured
      element cannot be shrunk by the layout that consumes the measurement
      (Mistake 6)
- [ ] Checked that derived state points back to the source event identifier
      (`seq`, `id`, `version`) instead of inventing a second cursor

---

## Cross-Platform Template Consistency

In Trellis, command templates (e.g., `record-session.md`) exist in **multiple platforms** with identical or near-identical content. This is a cross-layer boundary.

### Checklist: After Modifying Any Command Template

- [ ] Find all platforms with the same command: `find src/templates/*/commands/trellis/ -name "<command>.*"`
- [ ] Update all platform copies (Markdown `.md` and TOML `.toml`)
- [ ] For Gemini TOML: adapt line continuations (`\\` vs `\`) and triple-quoted strings
- [ ] Run `/trellis:check-cross-layer` to verify nothing was missed

**Real-world example**: Updated `record-session.md` in Claude to use `--mode record`, but forgot iFlow, Kilo, OpenCode, and Gemini — caught by cross-layer check.

---

## Generated Runtime Template Upgrade Consistency

Some generated files are both documentation and runtime input. In Trellis,
`.trellis/workflow.md` is parsed by `get_context.py`, `workflow_phase.py`,
SessionStart filters, and per-turn hooks. Template changes must be validated
against both fresh init and upgrade paths.

### Checklist: After Modifying A Runtime-Parsed Template

- [ ] Identify every runtime parser that reads the template, not just the file
      writer that installs it
- [ ] Check whether relevant syntax lives outside obvious managed regions
      such as tag blocks
- [ ] Verify fresh `init` output and a versioned `update` scenario that writes
      the older `.trellis/.version`
- [ ] Add an upgrade regression using an older pristine template fixture, then
      assert the installed file reaches the current packaged shape
- [ ] Update the backend spec that owns the runtime contract

---

## Versioned Documentation Boundary

Versioned documentation is a cross-layer boundary: source paths, `docs.json`
version routing, and the rendered version selector must all describe the same
release line.

### Checklist: Before Editing Versioned Docs

- [ ] Identify the target release line: stable, beta, or RC
- [ ] Verify the edited MDX path matches that line:
  - stable: `docs-site/{start,advanced,...}` and `docs-site/zh/{start,advanced,...}`
  - beta: `docs-site/beta/**` and `docs-site/zh/beta/**`
  - RC: `docs-site/rc/**` and `docs-site/zh/rc/**`
- [ ] Verify `docs.json` navigation points the version label to the same paths
- [ ] Grep the opposite tree for release-line-specific terms before committing
- [ ] Treat beta content appearing under root release paths as a source-path bug,
      not a rendering bug

**Real-world example**: A beta-only task workflow change documented
`prd.md` + `design.md` + `implement.md`, task-creation consent, and Codex
mode banners under root `start/` and `advanced/` paths. The docs site then
served 0.6 beta behavior under the Release selector. The fix was to restore root
release docs, move the 0.6 content to `beta/` and `zh/beta/`, and add a grep
audit for beta markers against the root release tree.

**Real-world example**: Codex inline mode changed workflow platform markers from
`[Codex]` / `[Kilo, Antigravity, Windsurf]` to `[codex-sub-agent]` /
`[codex-inline, Kilo, Antigravity, Windsurf]`. Fresh init was correct, but
`trellis update` only merged `[workflow-state:*]` blocks and preserved stale
markers outside those blocks. Result: upgraded projects got new hook scripts
but old workflow routing, so `get_context.py --mode phase --platform codex`
could return empty Phase 2.1 detail.

---

## Internal-ID vs External-ID Boundary Checklist

When internal state assigns its own identifier to an entity that ALSO has an
external id (session keys vs agent-reported session ids, internal user ids vs
provider ids, canonical names vs display names), the two id spaces never mix:

- [ ] Before passing an id to an external system (or matching against files
      the external system wrote), ask: **is this MY id or THEIR id?**
- [ ] If it is an internal scoped/encoded key, decode to the external raw id
      at the boundary (e.g. `parseSessionKey()` before reading trellis pointer
      files named after raw session ids)
- [ ] A match that silently never fires (null/empty/0 hits) is the signature
      of this bug class — suspect id-space mismatch before business logic
- [ ] Add a round-trip test (encode → decode → equals) plus an end-to-end
      binding test that consumes the external artifact (real pointer file
      name as fixture)

**Real-world example**: Clawd's session HUD consumed snapshot entries whose
`id` is a scoped key (`s1.<b64-profile>.<b64-raw>`), while trellis pointer
files on disk are named after the raw session id (`pi_<uuid>.json`). Pointer
matching always missed; the HUD showed the session row but no trellis badge
(chips = 0) with zero errors logged. Fix: decode the scoped key at the
`getLiveSessions` boundary before constructing the pointer filename.

---

## Mode-Detection Probe Checklist

When a CLI auto-detects a mode by probing a remote resource (e.g., checking if `index.json` exists to decide marketplace vs direct download):

### Before implementing:

- [ ] Probe runs in **ALL** code paths that use the result (interactive, `-y`, `--flag` combos)
- [ ] 404 vs transient error are distinguished — don't treat both as "not found"
- [ ] Transient errors **abort or retry**, never silently switch modes
- [ ] Shared state (caches, prefetched data) is **reset** when context changes (e.g., user switches source)
- [ ] **Shortcut paths** (e.g., `--template` skipping picker) must have the same error-handling quality as the probed path — check that downstream functions don't call catch-all wrappers

### After implementing:

- [ ] Trace every path from probe result to the mode-decision branch — no fallthrough
- [ ] External format contracts (giget URI, raw URLs) are tested or at least documented as comments
- [ ] Metadata reads consume a complete response or use a streaming parser — never parse a fixed-size prefix as full JSON
- [ ] When reconstructing a composite identifier from parsed parts, verify **all** fields are included and in the **correct position** (e.g., `provider:repo/path#ref` not `provider:repo#ref/path`)
- [ ] Verify that **action functions** called after a shortcut don't internally use the old catch-all fetch — they must use the probe-quality variant when error distinction matters
- [ ] When parsing a tool's human-facing output, identify **which subject** each number refers to before trusting it, and anchor the parse on an unambiguous shape rather than on position

**Real-world example**: Custom registry flow had 8 bugs across 3 review rounds: (1) probe only ran in interactive mode, (2) transient errors fell through to wrong mode, (3) giget URI had `#ref` in wrong position, (4) prefetched templates leaked across source switches, (5) `--template` shortcut bypassed probe but `downloadTemplateById` internally used catch-all `fetchTemplateIndex`, turning timeouts into "Template not found".

**Real-world example**: Agent-session update hints fetched npm `latest` metadata with `response.read(4096)` and then parsed it as complete JSON. The `@mindfoldhq/trellis` package metadata exceeded 4 KB, so the JSON was truncated, parse failed silently, and the first session injection showed no update hint. Fix: read the complete response before parsing, and add a regression where `version` is followed by an 8 KB metadata tail.

**Real-world example**: A panel read the installed CLI version by taking the first version-shaped token from `trellis --version`. That token was the **project's** version from the CLI's startup banner (`⚠️ Trellis update available: 0.7.0-beta.3 → 0.7.0-beta.4`), which the CLI prepends whenever its cwd contains a `.trellis/` directory - the right-hand side was the CLI's own version. Upgrading a project silently changed the reported "installed CLI version". Fix: take the line that is nothing but a version, and pin the byte-exact banner in a test. Note the same output also made `--version` cwd-dependent, so "installed version" is only meaningful with a cwd the tool cannot find a project in.

---

## Cross-Platform Template Consistency

In Trellis, command templates (e.g., `record-session.md`) exist in **multiple platforms** with identical or near-identical content. This is a cross-layer boundary.

### Checklist: After Modifying Any Command Template

- [ ] Find all platforms with the same command: `find src/templates/*/commands/trellis/ -name "<command>.*"`
- [ ] Update all platform copies (Markdown `.md` and TOML `.toml`)
- [ ] For Gemini TOML: adapt line continuations (`\\` vs `\`) and triple-quoted strings
- [ ] Run `/trellis:check-cross-layer` to verify nothing was missed

**Real-world example**: Updated `record-session.md` in Claude to use `--mode record`, but forgot iFlow, Kilo, OpenCode, and Gemini — caught by cross-layer check.

---

## Generated Runtime Template Upgrade Consistency

Some generated files are both documentation and runtime input. In Trellis,
`.trellis/workflow.md` is parsed by `get_context.py`, `workflow_phase.py`,
SessionStart filters, and per-turn hooks. Template changes must be validated
against both fresh init and upgrade paths.

### Checklist: After Modifying A Runtime-Parsed Template

- [ ] Identify every runtime parser that reads the template, not just the file
  writer that installs it
- [ ] Check whether relevant syntax lives outside obvious managed regions
  such as tag blocks
- [ ] Verify fresh `init` output and a versioned `update` scenario that writes
  the older `.trellis/.version`
- [ ] Add an upgrade regression using an older pristine template fixture, then
  assert the installed file reaches the current packaged shape
- [ ] Update the backend spec that owns the runtime contract

**Real-world example**: Codex inline mode changed workflow platform markers from
`[Codex]` / `[Kilo, Antigravity, Windsurf]` to `[codex-sub-agent]` /
`[codex-inline, Kilo, Antigravity, Windsurf]`. Fresh init was correct, but
`trellis update` only merged `[workflow-state:*]` blocks and preserved stale
markers outside those blocks. Result: upgraded projects got new hook scripts
but old workflow routing, so `get_context.py --mode phase --platform codex`
could return empty Phase 2.1 detail.

---

## Mode-Detection Probe Checklist

When a CLI auto-detects a mode by probing a remote resource (e.g., checking if `index.json` exists to decide marketplace vs direct download):

### Before implementing:
- [ ] Probe runs in **ALL** code paths that use the result (interactive, `-y`, `--flag` combos)
- [ ] 404 vs transient error are distinguished — don't treat both as "not found"
- [ ] Transient errors **abort or retry**, never silently switch modes
- [ ] Shared state (caches, prefetched data) is **reset** when context changes (e.g., user switches source)
- [ ] **Shortcut paths** (e.g., `--template` skipping picker) must have the same error-handling quality as the probed path — check that downstream functions don't call catch-all wrappers

### After implementing:
- [ ] Trace every path from probe result to the mode-decision branch — no fallthrough
- [ ] External format contracts (giget URI, raw URLs) are tested or at least documented as comments
- [ ] Metadata reads consume a complete response or use a streaming parser — never parse a fixed-size prefix as full JSON
- [ ] When reconstructing a composite identifier from parsed parts, verify **all** fields are included and in the **correct position** (e.g., `provider:repo/path#ref` not `provider:repo#ref/path`)
- [ ] Verify that **action functions** called after a shortcut don't internally use the old catch-all fetch — they must use the probe-quality variant when error distinction matters
- [ ] When parsing a tool's human-facing output, identify **which subject** each number refers to before trusting it, and anchor the parse on an unambiguous shape rather than on position

**Real-world example**: Custom registry flow had 8 bugs across 3 review rounds: (1) probe only ran in interactive mode, (2) transient errors fell through to wrong mode, (3) giget URI had `#ref` in wrong position, (4) prefetched templates leaked across source switches, (5) `--template` shortcut bypassed probe but `downloadTemplateById` internally used catch-all `fetchTemplateIndex`, turning timeouts into "Template not found".

**Real-world example**: Agent-session update hints fetched npm `latest` metadata with `response.read(4096)` and then parsed it as complete JSON. The `@mindfoldhq/trellis` package metadata exceeded 4 KB, so the JSON was truncated, parse failed silently, and the first session injection showed no update hint. Fix: read the complete response before parsing, and add a regression where `version` is followed by an 8 KB metadata tail.

**Real-world example**: A panel read the installed CLI version by taking the first version-shaped token from `trellis --version`. That token was the **project's** version from the CLI's startup banner (`⚠️ Trellis update available: 0.7.0-beta.3 → 0.7.0-beta.4`), which the CLI prepends whenever its cwd contains a `.trellis/` directory - the right-hand side was the CLI's own version. Upgrading a project silently changed the reported "installed CLI version". Fix: take the line that is nothing but a version, and pin the byte-exact banner in a test. Note the same output also made `--version` cwd-dependent, so "installed version" is only meaningful with a cwd the tool cannot find a project in.

---

## When to Create Flow Documentation

Create detailed flow docs when:

- Feature spans 3+ layers
- Multiple teams are involved
- Data format is complex
- Feature has caused bugs before

---

## Event Log / Projection Boundary

Append-only logs are cross-layer contracts. A single event travels through:

```
CLI input → event writer → events.jsonl → reader → filter → reducer → display
```

### Checklist: After Adding A New Event Kind Or Field

- [ ] Add the event kind to the central event taxonomy
- [ ] Add a typed event variant or type guard at the event layer
- [ ] Add normalization helpers for array/object fields that come from
      user input or JSON
- [ ] Keep `seq` / `id` assignment in the event writer only
- [ ] Make filters and reducers consume the typed event guard, not local casts
- [ ] Make display code consume reducer output or typed events, not raw JSON
- [ ] Add at least one regression that proves history replay and live filtering
      use the same filter model

**Real-world example**: Thread channels added `kind: "thread"`, `description`,
`context`, labels, and `lastSeq`. The first implementation replayed thread
state correctly, but several commands still re-parsed event payload fields with
local casts. The fix was to make the core event layer own `ThreadChannelEvent`
and `isThreadEvent`, make `reduceChannelMetadata` the only channel metadata
projection, and make `reduceThreads` the only thread replay reducer.
