# Implement：Trellis CLI 发现修复三连

前置：`git status` 确认工作区（.trellis/.pi 脏文件是常态，不动）；本任务改动全部在
`src/` + `test/`，与 `.worktrees/pr-session-*` 两个上游 PR 分支无关。

## 步骤

- [x] 1. `src/trellis-cli.js`：`augmentedCliPath` 扩充
  - 固定目录 `~/.npm-global/bin`、`~/.bun/bin`、`~/Library/pnpm`、`~/.volta/bin`
    （POSIX 分支，追加在 `~/.local/bin` 之后）
  - nvm 枚举 `~/.nvm/versions/node/<v>/bin`（`options.fs` 注入；numeric 倒序）
  - 验证：`node -e 'const m=require("./src/trellis-cli");console.log(m.augmentedCliPath("/usr/bin:/bin"))'`
    —— 输出尾部含四个固定目录；win32 分支用
    `node -e '... augmentedCliPath("/c/Windows",{platform:"win32"})'` 确认不变
- [x] 2. `src/trellis-cli.js`：`resolveTrellisBinPath` + `readGlobalVersion` 加
  `path` 字段（同文件导出新函数）
  - 验证：`node --check src/trellis-cli.js`
- [x] 3. `src/trellis-roots.js`：`registerScanRoots(paths)` 批量幂等注册
  - 验证：`node --check src/trellis-roots.js`
- [x] 4. `src/trellis-ipc.js`：`options.syncScanRoots` 注入点；`settings:trellis-set-roots`
  handler `applyUpdate` 成功后调用（try/catch，异常只 warn）
  - 验证：`node --check src/trellis-ipc.js`
- [x] 5. `src/main.js`：`syncScanRootsToDashboard` 组装（scanRoots → filter
  installed → store.registerScanRoots → 有新增推送 roots-changed）；注册进
  `registerTrellisIpc` 的 `syncScanRoots`；启动存量同步一次（不推送）
  - 验证：`node --check src/main.js`
- [x] 6. `src/settings-tab-trellis.js` + `src/settings.css`：全局 CLI 卡片版本行
  追加 `trellis-cli-path` span（有 `global.path` 才渲染）；CSS 追加在
  `.trellis-version` 规则附近
  - 验证：`node --check src/settings-tab-trellis.js`
- [x] 7. 测试：`test/trellis-cli.test.js`（PATH 扩充/nvm/resolveTrellisBinPath/
  readGlobalVersion.path）、`test/trellis-roots.test.js`（registerScanRoots）、
  `test/trellis-ipc.test.js`（set-roots → syncScanRoots 回调）、
  `test/settings-tab-trellis.test.js`（路径 span 渲染）
  - 验证：`node --test test/trellis-cli.test.js test/trellis-roots.test.js
    test/trellis-ipc.test.js test/settings-tab-trellis.test.js`
- [x] 8. 全量回归：`npm test`
- [x] 9. 实机冒烟（主工作区）：重启 Clawd → Settings → Trellis：版本行出现
  `/usr/local/bin/trellis` 路径（本机命中项）；Dashboard Trellis 视图项目数 ≥ 1
  （存量 `trellisScanRoots` 已同步）
- [x] 10. spec 更新：`.trellis/spec/guides/trellis-panel-contract.md` 补记——
  PATH 补偿目录清单（含 nvm 枚举）、`readGlobalVersion.path` 契约、
  set-roots → rootsStore 单向同步语义（不级联删除）
  - 验证：`grep -n "npm-global" .trellis/spec/guides/trellis-panel-contract.md`

## 收尾

- 提交：单 commit `fix(trellis): CLI 发现修复三连——PATH 扩充、亮出实际路径、扫描目录同步 Dashboard`（中文，Co-Authored-By 尾行；只 add 本任务的 src/test/spec 路径，
  提交前核对 `git diff --cached --stat`）
- 注意 `.trellis/` 与 `.pi/` 的既有脏文件不入提交（memory: trellis-dirty-files-stay-local）
- 完成后 `/trellis:finish-work` 归档 + journal

## 回滚点

- 每步独立可回退；最坏情况 revert 单 commit，无存储迁移
