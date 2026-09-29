# Implement — trellis-freshness-time

> 执行约定：每完成一步并跑过其对应验证命令后，立即将该步 `[ ]` 改为 `[x]`；验证失败保持未勾。

## D1 归档完成时间到时分（R1 / AC1 / AC4）

- [x] 1. `src/trellis-archive.js`：`listArchivedTasks` 的 entry 增加 `completedAtRealMs`（任务 task.json 的 `statSync().mtimeMs`，读取失败为 null）；同步更新头部 frozen contract 注释。不动 `completedAt` / `completedAtMs` 语义。
  - 验证：`node test/trellis-archive.test.js`
- [x] 2. `test/trellis-archive.test.js`：新增用例——realMs 字段存在且为 mtime 值；task.json 不可读时为 null；completedAtMs 语义不变。
  - 验证：`node test/trellis-archive.test.js`
- [x] 3. `src/dashboard-renderer.js` `trellisArchiveCompletedLabel`：优先 `completedAtRealMs` → `toLocaleDateString(lang)` + `toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })`；否则维持现有回退链（completedAt 字符串 / completedAtMs 天粒度）。
  - 验证：`node test/dashboard-trellis-panel.test.js`
- [x] 4. `test/dashboard-trellis-panel.test.js`：更新 ~1534 行附近断言——realMs 存在时显示含时:分，缺失时保持天粒度。
  - 验证：`node test/dashboard-trellis-panel.test.js`

## D2 跳转先刷新再定位（R2 / AC2）

- [x] 5. `src/dashboard-renderer.js` `onNavigateTrellis`（~5216）：`jumpToTrellisNetworkTask` 前 `await refreshTrellisActive()` + `await refreshTrellisViewArchive()`；roots 的 `rootsLoaded` 守卫与 `switchDashboardView` 内部刷新保持不动。
  - 验证：`node test/dashboard-trellis-panel.test.js`
- [x] 6. 测试：断言跳转路径中 active/archive 刷新先于 jump 定位（fake IPC 时序）。
  - 验证：`node test/dashboard-trellis-panel.test.js`

## D3 HUD 面板轮询刷新（R3 / AC3 / AC5）

- [x] 7. `src/session-hud-renderer.js`：面板打开且首次 result 就绪后启动 30s 轮询——tick 时面板仍开、cwd 匹配且无在途请求才重新 invoke `getTrellisPanel({cwd})`；应用结果用代数（generation）守卫防陈旧覆盖；`closeTrellisPanel` 清除 interval。
  - 验证：`node test/session-hud-style.test.js`
- [x] 8. 测试：轮询 tick 重拉面板数据、结果应用后面板内容更新、面板关闭后无残留 interval（实现时定位该域最合适的测试文件，必要时新增）。
  - 验证：`node test/session-hud-style.test.js` + `node test/session-renderer-behavior.test.js`（轮询用例落在 behavior）

## 收尾

- [x] 9. 全量测试：`node test/run-tests.js`
- [x] 10. 按 `.trellis/spec/frontend/quality-guidelines.md` 的检查线过一遍改动。

## 回滚点

- D1 / D2 / D3 三块互相独立，任一步失败可单独 revert 对应改动，不影响其余两块。
- [x] 11. detail 卡（概览默认 tab）完成时间补时分：readTaskDetail 透传 completedAtRealMs（task.json mtime，statQuiet 失败 null）+ appendTrellisDetailMeta 改用 trellisArchiveCompletedLabel（回退链同归档行）。验证：node test/trellis-activity.test.js（fail 0）+ node test/dashboard-trellis-panel.test.js（fail 0，新用例 detail card completed time carries HH:mm）。
