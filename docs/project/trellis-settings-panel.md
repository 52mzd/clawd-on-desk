# Trellis Settings Panel

The `trellis` Settings tab scans user-chosen directories for Trellis-enabled projects,
shows each project's installed version and configured platforms, and offers **explicit,
user-triggered** upgrade / add-platform actions. It is a self-contained subsystem: it
does not touch agent state, hooks, or the pet runtime.

This document records the durable architecture of the feature scope, and the
constraints that must not be relaxed by later changes.

## Module layout

```
src/settings-tab-trellis.js   renderer: scan roots, project table, preview, filters
        │  invoke / on
        ▼
src/preload-settings.js       trellisScan / … / onTrellisProgress
        │
        ▼
src/trellis-ipc.js            ipcMain.handle, trust gate, id whitelist, catalogs
        │
        ▼
src/trellis-runtime.js        only stateful layer: remote cache, batch queue, cancel
        ├── src/trellis-scanner.js     read-only disk scan
        ├── src/trellis-platforms.js   platform table + parsers (no I/O in parse)
        ├── src/trellis-version.js     pure version/compare/channel logic
        └── src/trellis-cli.js         external process execution (injectable)
                    │
                    ▼
             child_process.execFile
```

`scanner` / `platforms` / `version` are pure or read-only and unit-testable in isolation.
`runtime` owns every piece of mutable state; concurrency and cancellation exist in exactly
one place.

## IPC contract

All channels are `settings:trellis-*`, register through `ipcMain.handle`, and answer with
the envelope `{ status: "ok" | "cancel" | "error", ... }`.

| Channel | Payload | Result |
| --- | --- | --- |
| `settings:trellis-scan` | `{ channel? }` | `{ status, roots, channels, remote, scans, projects, global, platformCatalog, channelCatalog }` |
| `settings:trellis-pick-root` | — | `{ status:"ok", path }` / `{ status:"cancel" }` |
| `settings:trellis-set-roots` | `{ roots }` | `{ status }` (written through `settings-controller`) |
| `settings:trellis-preview` | `{ paths }` | `{ status, plan[] }` — pure computation |
| `settings:trellis-upgrade-project` | `{ path }` | `{ status, from, to }` |
| `settings:trellis-upgrade-all` | `{ paths }` | `{ status, batchId }` |
| `settings:trellis-cancel-batch` | — | `{ status }` |
| `settings:trellis-add-platform` | `{ path, platforms:[id] }` | `{ status, added }` |
| `settings:trellis-upgrade-global` | `{ channel? }` | `{ status, from, to }` |

Progress flows the other way over `settings:trellis-progress`:
`{ batchId, path, phase: "queued"|"running"|"ok"|"failed"|"cancelled", from, to, message }`
plus a terminal `{ phase: "done", summary: { total, ok, failed, cancelled } }`.

`channels` duplicates `remote.channels` for the renderer's convenience; `remote.error` is set
when the remote lookup failed, in which case both are null. `scans` is the per-root view
(`{ root, readable, projects }`) that lets the panel tell "unreadable directory" apart from
"no projects here".

Per-project shape:

```js
{ path, name, installed, current, target, channel,
  upgradable,   // true | false | null — null means UNKNOWN, never "up to date"
  platforms, staleIds, staleRecord, staleFixes }
```

The catalogs (`platformCatalog`, `channelCatalog`) are projected from main-process tables.
The renderer holds no copy of either list, so the two can never drift; `trellis-ipc.js`
remains the single place that maps a platform id to a CLI flag.

## Constraints that must not be relaxed

### 1. Every channel passes one shared trust gate

`trellis-ipc.js` refuses **all** channels unless `options.isTrustedEvent` (the very same
predicate `settings-ipc.js` uses for the Settings window) returns `true`. A missing guard
and a throwing guard both deny, answering `{ status: "error", message: "untrusted-sender" }`
before any handler body runs.

Without this, any renderer — pet window, permission bubble, dashboard — could reach a
channel that spawns a CLI and writes to disk. The gate is what makes "only an explicit user
click writes" a property of the code rather than a convention.

### 2. Two write commands, each with a frozen argv

| Action | argv | cwd |
| --- | --- | --- |
| Upgrade | `trellis update --force` | project path |
| Add platform | `trellis init --<platform> -y` | project path |

- `--force` on update is mandatory: bare `trellis update` prompts per file and hangs
  without a TTY.
- `-s` / `-f` must **never** be added to `init`. Measured behaviour: with `-y` alone the
  CLI takes its `handleReinit` incremental branch and the `.template-hashes.json` record
  becomes a **union**; with `-s` or `-f` it skips that branch, runs a full init, and
  **rebuilds the record from scratch**, dropping previously registered platforms so that
  later `trellis update` silently stops syncing them.
- The two argv prefixes and the `["-y"]` suffix are separate constants on purpose.

### 3. The global CLI upgrades to a chosen channel, and the panel reports the installed version

`settings:trellis-upgrade-global` takes an optional `channel`. Empty means **automatic**:
`trellis upgrade` with no argument, which lets the CLI infer the channel from the
prerelease marker on its own installed version. A non-empty channel must be one of
`latest` / `beta` / `rc`, whitelisted in `trellis-ipc.js` **and** `trellis-cli.js`, and
becomes `trellis upgrade <channel>`. An unknown value fails closed without spawning.

The channel picker shows each tag next to the version the remote currently publishes for
it, so "upgrade to beta" is a decision the user can make from the panel rather than a
guess.

`trellis --version` writes to stdout, but the version is not necessarily the first
version-shaped token there. When the process' *cwd* contains a `.trellis/` directory the
CLI prefixes a startup banner to every command:

```
⚠️  Trellis update available: 0.7.0-beta.3 → 0.7.0-beta.4
   Run: trellis update

0.7.0-beta.4
```

The left-hand side is `<cwd>/.trellis/.version` and the right-hand side is the CLI's own
version. Measured with the CLI at `0.7.0-beta.4`: from a project stamped `0.7.0-beta.3`
the output is exactly the above, and with `cwd=/tmp` (no project) it is just
`0.7.0-beta.4`. So a naive first-match reports a *project* version - one that moves
whenever a project is upgraded, independently of the CLI.

`parseVersionOutput` in `trellis-cli.js` therefore anchors on the one unambiguous shape,
a line consisting of nothing but a version, and skips the banner. `test/trellis-cli.test.js`
pins the byte-exact banner above. Switching to `stderr` would be worse, not better: the
banner is on stdout, so that would yield an empty string.

### 4. Preview never writes

`trellis update --dry-run` is **not** read-only: when a project's `.version` differs from
the CLI version it rewrites `.trellis/.version`. Measured with `0.6.0` and `0.5.0`, both
became `0.7.0-beta.3`. Preview is therefore pure computation over the last scan snapshot,
and nothing exposes `--dry-run`.

### 5. Nothing schedules Trellis work

No timer, no watcher, no startup task, no auto-refresh. `trellis-ipc.js` and
`trellis-runtime.js` contain no scheduling primitives, and the renderer refreshes only when
the user asks.

### Other invariants

- Paths are used as `cwd` only; they never enter argv, and no command is built as a shell
  string.
- Platform ids travel as ids and are whitelisted against `PLATFORMS` in `trellis-ipc.js`
  **and** `trellis-cli.js`; an unknown id fails closed without building an argv.
- `trellis-set-roots` writes through `settings-controller.js`; no Trellis module writes
  prefs directly.
- Clawd never writes `.trellis/.template-hashes.json`. It is Trellis's own record.
- Platforms are read from that record, not guessed from directory names. Unknown prefixes
  surface as `Unknown (<prefix>)` instead of being dropped or mapped.

## Platform table

`src/trellis-platforms.js` holds 21 entries `{ dirPrefix, id, cliFlag, label }`, derived
from the CLI's own `AI_TOOLS[].configDir` first path segment. Multi-segment config dirs
(`.kiro/skills`, `.github/copilot`, `.agent/workflows`, `.devin/workflows`, `.snow/skills`)
normalize to that first segment, which is also the `hashes` key prefix.

`test/trellis-platforms.test.js` asserts every entry in both directions, so a CLI structure
change fails a test instead of silently misreporting platforms.

## Tests

| File | Covers |
| --- | --- |
| `test/trellis-version.test.js` | channel inference, comparison boundaries, unknown → `null` |
| `test/trellis-platforms.test.js` | all 21 mappings, ignored prefixes, unknown retention, `staleIdsOf` |
| `test/trellis-scanner.test.js` | direct-child scan, symlink skip, spacings, `staleIds`, unreadable roots |
| `test/trellis-cli.test.js` | argv shape, `--force` / `-y` presence, whitelist fail-closed, win32 `shell`, update-banner version parsing |
| `test/trellis-runtime.test.js` | single remote fetch, TTL cache, concurrency ≤ 3, failure isolation, cancel |
| `test/trellis-ipc.test.js` | envelope, trust gate (missing and throwing), catalogs, `staleFixes` |
| `test/settings-tab-trellis.test.js` | tab rendering, filtering drives batch scope, unreadable roots |

Note: this repo's suite has a pre-existing environment baseline (no Electron installed),
so "the whole suite is green" is not achievable locally. Compare the *set* of failing test
files before and after a change instead of the absolute count.
