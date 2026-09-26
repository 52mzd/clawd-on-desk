# Thinking Guides

> **Purpose**: Expand your thinking to catch things you might not have considered.

---

## Why Thinking Guides?

**Most bugs and tech debt come from "didn't think of that"**, not from lack of skill:

- Didn't think about what happens at layer boundaries → cross-layer bugs
- Didn't think about code patterns repeating → duplicated code everywhere
- Didn't think about edge cases → runtime errors
- Didn't think about future maintainers → unreadable code

These guides help you **ask the right questions before coding**.

---

## Available Guides

| Guide | Purpose | When to Use |
|-------|---------|-------------|
| [Code Reuse Thinking Guide](./code-reuse-thinking-guide.md) | Identify patterns and reduce duplication | When you notice repeated patterns |
| [Cross-Layer Thinking Guide](./cross-layer-thinking-guide.md) | Think through data flow across layers | Features spanning multiple layers |
| [Trellis Panel Contract](./trellis-panel-contract.md) | External-process contract: frozen argv, IPC trust gate, output-parsing identity, GUI-launch PATH overlay | When spawning a CLI, parsing its output, or wiring a spawn call site |
| [Repository Export & Sync Guide](./repository-sync-guide.md) | Silent upstream rollback (`checkout <branch> -- <paths>`), check blind spots, baseline choice, dual-form policy values | When exporting a branch, syncing with upstream, or building a fork/release tree |
| [Fork Release Guide](./fork-release-guide.md) | Upstream release-contract tests, `docs/**` whitelist, contributor triple-consistency, semver `previousTag`, GUI PATH, pre-release visibility | When publishing a fork release, building installers, or touching release notes / contributor lists |

---

## Quick Reference: Thinking Triggers

### When to Think About Cross-Layer Issues

- [ ] Feature touches 3+ layers (API, Service, Component, Database)
- [ ] Data format changes between layers
- [ ] Multiple consumers need the same data
- [ ] You're not sure where to put some logic
- [ ] You are adding an event kind, JSONL record, RPC payload, or config field
- [ ] UI / command code starts casting raw payload fields directly

→ Read [Cross-Layer Thinking Guide](./cross-layer-thinking-guide.md)

### When to Think About Code Reuse

- [ ] You're writing similar code to something that exists
- [ ] You see the same pattern repeated 3+ times
- [ ] You're adding a new field to multiple places
- [ ] **You're modifying any constant or config**
- [ ] **You're creating a new utility/helper function** ← Search first!
- [ ] Two files read the same untyped payload field with local casts
- [ ] Multiple branches update the same derived state from `kind` / `action`

→ Read [Code Reuse Thinking Guide](./code-reuse-thinking-guide.md)

### When Verifying AI Cross-Review Results

- [ ] Reviewer claims "user input can be malicious" → Check the actual data source (internal manifest? user config? external API?)
- [ ] Reviewer flags "missing validation" → Is the data from a trusted internal source?
- [ ] Reviewer says "behavior change" → Read the code comments — is it intentional design?
- [ ] Reviewer identifies a "bug" in test → Mentally delete the feature being tested — does the test still pass? If yes → tautological test

**Common AI reviewer false-positive patterns**:
1. **Trust boundary confusion**: Treating internal data (bundled JSON manifests) as untrusted external input
2. **Ignoring design comments**: Flagging intentional behavior documented in code comments as bugs
3. **Variable misreading**: Not tracing a variable to its actual definition (e.g., Map keyed by path vs name)

**Verification rule**: Every CRITICAL/WARNING finding must be verified against the actual code before prioritizing. Budget ~35% false-positive rate for AI reviews.

---

### When Spawning An External CLI

- [ ] You're building argv for a command that writes to disk
- [ ] You're adding an IPC channel reachable from a renderer
- [ ] You're letting renderer-supplied values influence argv
- [ ] You're parsing a tool's stdout/stderr for a value
- [ ] A tool's output could contain numbers about more than one subject

→ Read [Trellis Panel Contract](./trellis-panel-contract.md)

---

### When Exporting Or Syncing A Branch

- [ ] You're building a tree from another branch (`checkout <branch> -- <paths>`)
- [ ] You're syncing with upstream and need to prove nothing was lost
- [ ] You're choosing a baseline for "did my change regress anything?"
- [ ] A policy/threshold file legitimately holds different values in dev vs release form
- [ ] You're about to claim "zero new failures" or "upstream fully included"

→ Read [Repository Export & Sync Guide](./repository-sync-guide.md)

---

### When Publishing A Fork Release

- [ ] You're creating or updating a GitHub Release
- [ ] You're adding a `docs/releases/release-v*.md`
- [ ] You're touching `src/settings-i18n.js` CONTRIBUTORS or any README contributor list
- [ ] You're changing `package.json` version
- [ ] A packaged build reports a CLI missing that a terminal run finds
- [ ] The Releases page shows "Create a new release" despite a created release

→ Read [Fork Release Guide](./fork-release-guide.md)

---

## Pre-Modification Rule (CRITICAL)

> **Before changing ANY value, ALWAYS search first!**

```bash
# Search for the value you're about to change
grep -r "value_to_change" .
```

This single habit prevents most "forgot to update X" bugs.

---

## How to Use This Directory

1. **Before coding**: Skim the relevant thinking guide
2. **During coding**: If something feels repetitive or complex, check the guides
3. **After bugs**: Add new insights to the relevant guide (learn from mistakes)

---

## Contributing

Found a new "didn't think of that" moment? Add it to the relevant guide.

---

**Core Principle**: 30 minutes of thinking saves 3 hours of debugging.
