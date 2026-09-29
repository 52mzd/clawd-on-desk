# Design — trellis-freshness-time

## 现状链路（侦察结论）

- 归档数据：`src/trellis-archive.js` `listArchivedTasks` 扫描 `.trellis/tasks/archive/`，entry shape（frozen IPC 契约）：`{ name, month, dir, title, parent, hasChildren, priority, createdAt, completedAt, completedAtMs }`。`completedAt` 是 task.py 写的 `YYYY-MM-DD` 本地日期字符串；`completedAtMs = Date.parse(completedAt)`，仅当 completedAt 缺失时回退任务目录 mtime。
- 显示：`src/dashboard-renderer.js` `trellisArchiveCompletedLabel()`（~3203 行）优先直接返回 `completedAt` 字符串，否则 `completedAtMs` → `toLocaleDateString`。
- 跳转：HUD 任务行点击（`src/session-hud-renderer.js:135` `openTrellisTask`）→ `src/main.js:2923` `openTrellisTaskFromHud`（`showDashboard` + `dashboard:navigate-trellis`）→ `src/dashboard-renderer.js:5216` `onNavigateTrellis` → `switchDashboardView("trellis")`（内部 fire-and-forget `refreshTrellisView()`）→ `jumpToTrellisNetworkTask` 立即用旧缓存定位（`selectTrellisSplitTask`）。
- HUD 面板：`src/session-hud-renderer.js` `toggleTrellisPanel` 打开时一次 `getTrellisPanel` invoke；`if (!trellisPanel.result)` 守卫导致结果冻结；`closeTrellisPanel` 清 result（重开面板会重拉）。

## D1 — R1 归档完成时间到时分

- 数据层（`src/trellis-archive.js`）：entry 新增 `completedAtRealMs`（`number | null`）——任务 `task.json` 的 `statSync().mtimeMs`，读取失败为 null；同步更新头部 frozen contract 注释。
  - 不动 `completedAt` / `completedAtMs` 现有语义（`src/recap-trellis.js` 依赖 `completedAtMs` 做本地日期冻结，语义变更会引入午夜边界回归）。
  - mtime 语义：task.py 归档时写 completedAt（task.json 被改写）→ mtime ≈ 归档时刻；归档后手工再编辑 task.json 会漂移，按 PRD 约束接受。
- 显示层（`src/dashboard-renderer.js` `trellisArchiveCompletedLabel`）：`completedAtRealMs` 有效 → `toLocaleDateString(lang)` + `toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })`；否则维持现有回退链（completedAt 字符串 / completedAtMs → 天粒度日期）。
- 测试：`test/trellis-archive.test.js`（字段存在 / 失败 null）；`test/dashboard-trellis-panel.test.js:1534` 附近显示断言更新。

## D2 — R2 跳转先刷新再定位

- `src/dashboard-renderer.js` `onNavigateTrellis`（5216）：`jumpToTrellisNetworkTask` 前 `await refreshTrellisActive()` + `await refreshTrellisViewArchive()`（roots 的 `rootsLoaded` 守卫维持现状）。
- `switchDashboardView` 内部 fire-and-forget 的 `refreshTrellisView()` 不动：重复拉取幂等、读磁盘成本低，保持最小改动。

## D3 — R3 HUD 面板轮询刷新

- `src/session-hud-renderer.js`：面板打开且首次 result 就绪后启动轮询 interval（30s）；tick 时若面板仍开、cwd 匹配且无在途请求则重新 invoke `getTrellisPanel({cwd})`。
- 竞态防护：拉取用代数（generation）守卫——应用结果前确认面板仍开且 sessionId/cwd 未变；在途请求期间跳过 tick。
- 结果应用后走现有重绘入口更新面板 DOM（保持 signature 重渲染模式，实现时确认具体入口，不做全量 churn）。
- 清理：`closeTrellisPanel` 清除 interval（renderer 事件清理规范）。
- 成本：每次 IPC → 主进程 `getTrellisHudPanel` 读磁盘聚合，与 dashboard 视图切换全量刷新同级，30s 间隔可接受。

## 兼容与回滚

- `completedAtRealMs` 为新增可选字段，旧消费者忽略不受影响。
- D1/D2/D3 各自独立可回退（revert 单个改动即可），互不依赖。
