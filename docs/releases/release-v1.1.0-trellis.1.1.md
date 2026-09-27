# Clawd on Desk v1.1.0-trellis.1.1

Internal trellis-customized build on top of v1.1.0, synchronized with
upstream `main` through `fa9bcaa4` (PR #1053).

## Local Changes

- **HUD trellis detail in light mode** — the expandable trellis task row in
  the Session HUD hardcoded dark-only colors, so it stayed a dark card under
  a light OS appearance. It now reuses the existing HUD theme variables
  (`--text` / `--text-muted` / `--hud-border`); the dark appearance is
  pixel-identical to before.

## Upstream Merged (since v1.1.0)

- OpenCode V2 support (dual-key plugin registration, event shape translation,
  per-core-revision state streams) (#1045, #1053)
- WSL: stop probing WSL PIDs on the Windows host; per-session automation
  unchanged for WSL sessions (#1055)
- Cursor: preserve hook delivery time after slow metadata lookup (#1056)
- Theme: mirror opted-in idle animations on the right half of the screen (#1050)
- Codex pet: dedicated juggling pose instead of reusing the working file (#1022)
- README.ko-KR.md updates (#1054)

## Version Note

This is a private fork build (`1.1.0-trellis.1.1`). The semver pre-release
suffix sorts it **before** upstream `1.1.0` in updater comparisons; it is not
published to the official release channel or winget.
