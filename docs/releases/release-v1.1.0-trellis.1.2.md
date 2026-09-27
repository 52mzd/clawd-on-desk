# Clawd on Desk v1.1.0-trellis.1.2

Internal trellis-customized build on top of v1.1.0. No upstream sync in
this cycle — purely local trellis-integration work.

## Local Changes

- **Multi-project HUD trellis panel** — the Session HUD task panel now
  covers every known project root (up to 5), one section per project
  (active tasks plus the 3 newest archived), so switching between projects
  no longer loses sight of the other one. Row jumps resolve through the
  owning section's cwd, and a jump switches the dashboard project chip to
  the owning root.
- **Process-level trace restored with a tail ladder** — the HUD detail
  line again shows the latest trellis command / workflow step for a bound
  claude-code session. The workflow-state hook block is the only reliable
  signal source; the tail window widens 512KB → 8MB in steps until a
  signal is found, surviving tool-output-heavy rounds.
- **Project lists ordered newest-touched first** — HUD panel, dashboard
  task grouping and the Settings trellis scan all list the most recently
  touched project first. The recency key is `max(pointer last_seen_at,
  sessions-dir mtime)` because the trellis CLI empties `.runtime/sessions`
  when a session ends — the directory mtime is the surviving trace.
- Renderer behavior-test hardening for the above (FakeElement
  `childElementCount` stub, ws-only third-line coverage).

## Version Note

This is a private fork build (`1.1.0-trellis.1.2`). The semver pre-release
suffix sorts it **before** upstream `1.1.0` in updater comparisons; it is not
published to the official release channel or winget.
