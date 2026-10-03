# PRD: 更新器指向 fork 仓库

## 背景

fork（52mzd/clawd-on-desk-trellis）构建的 Clawd 安装包，其"检查更新"功能全部指向官方仓库
（rullerzhou-afk/clawd-on-desk）。由于 `1.2.0-trellis.x` 在 semver 中是 pre-release、小于官方
`1.2.0`，已装 fork 版的用户点"检查更新"会被引导安装官方构建并丢失 Trellis 定制功能。

## 目标

fork 构建的更新检查只检查 fork 自己的 releases，不再考虑官方渠道。

## 需求

1. electron-updater feed（打包安装路径）：`package.json` → `build.publish` 的
   `owner`/`repo` 改为 `52mzd` / `clawd-on-desk-trellis`。
2. 更新发现链路（`src/updater.js`）三处硬编码同步指向 fork：
   - `RELEASES_LATEST_URL` 常量
   - `fetchLatestReleaseViaRedirect` 的 HTML redirect path
   - `fetchLatestReleaseFromApi` 的 GitHub API path
   三处收敛为单一 repo 常量派生，避免后续上游同步漂移。
3. `test/updater.test.js` 中所有官方 repo host/path 断言同步替换。
4. 版本号语义不变（仍为 `1.2.0-trellis.x` pre-release 线）。
5. CI `verify-updater-metadata.js` 只校验文件名形状/version/sha512，不涉及 repo URL，
   预期无需改动（已确认）。

## 非目标

- 不改 `src/settings-ipc.js` About 页 repoUrl、Discord RPC 素材 URL、Telegram 文档链接、
  winget 脚本（与更新器无关）。
- 不改 Git 模式的 `git pull origin`（走本地 remote，由 clone 决定）。
- 不处理"已误装官方版的用户拉回 fork"场景。

## 验收标准

- [x] `npm test` 全绿（updater 相关断言指向 fork repo）。
- [x] `node scripts/verify-updater-metadata.js` 行为不受影响（无 repo 硬编码）。
- [x] 新构建的 app 内 `app-update.yml` 指向 fork 仓库（已从 v1.2.0-trellis.1.3 arm64 dmg 实证：owner 52mzd / repo clawd-on-desk-trellis）。

## 生效说明

改动只对下一版安装包生效（`1.2.0-trellis.1.3+`）；已发布的 `1.2.0-trellis.1.2`
安装包内嵌 feed 仍指官方，用户需手动安装一次新版完成切换。
