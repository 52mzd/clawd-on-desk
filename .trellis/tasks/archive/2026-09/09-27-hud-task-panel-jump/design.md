# Design：HUD trellis 任务面板 + Dashboard 跳转

## 1. 架构（HUD 自身扩展，无新窗口）

```
[HUD renderer]                      [main]                          [Dashboard renderer]
chip 点击 → toggleTrellisPanel(cwd)
  ├─ sessionHudAPI.getTrellisPanel({cwd})
  │        ──invoke session-hud:trellis-panel──▶ activity.readHudTaskPanel(cwd)
  │                                              （cwd 过 isTrustedTrellisCwd 三源信任面）
  │◀── { active:[…], archived:[…8] } ──┘
  ├─ 面板 = 原详情行内容（面板头）+ 进行中列表 + 已完成 8 条 + 「查看全部」行
  └─ 点击行 → sessionHudAPI.openTrellisTask({taskPath, cwd})
        ──send session-hud:open-trellis-task──▶ ① taskPath 过路径遏制（§4.3 双分隔符拆分）
                                                ② showDashboard()（唤起/聚焦）
                                                ③ dashboard:navigate-trellis {taskPath, cwd}
                                                   （isLoading 时挂 did-finish-load 后发）
                                                 └─▶ preload onNavigateTrellis →
                                                      switchDashboardView("trellis") +
                                                      revealTrellisTask(taskPath)（复用既有
                                                      reveal 机制：归档先开 archiveOpen/
                                                      清 collapsedPaths，3141 行同款）
```

## 2. 契约

- **`session-hud:trellis-panel`**（invoke）：payload 严格单键 `{cwd}`；未过信任面 → `{status:"missing"}`；返回条目 active=`{taskPath,title,phase,progress}`，archived=`{taskPath,title,completedAt,durationMs}`（newest-first 截 8）
- **`session-hud:open-trellis-task`**（send，无 ack）：payload 严格双键 `{taskPath, cwd}`；taskPath 必须以 `.trellis/tasks/` 开头且逐段非 `.`/`..`（平台无关拆分，同 §4.3）
- **`dashboard:navigate-trellis`**（main→renderer）：payload `{taskPath, cwd}`；renderer 无匹配任务时静默（只切视图）——数据竞态由 reveal 的既有重试/展开逻辑兜住，不新增轮询
- 数据组装在 activity 新增 `readHudTaskPanel(cwd)`：复用 readActiveList/readArchiveList 的遍历与信任面（加单 root 过滤参数或调用后按 cwd 归属过滤——实现时选侵入最小者），**禁止复制遍历逻辑**
- 只读红线：panel 数据面零写零 spawn；打开面板一次一拉（不轮询），收起不拉

## 3. HUD UI

- 面板为 HUD 内全局区块（所有会话行之后），从任一绑定会话的 chip 打开；面板头 = 原详情行三行内容（任务名/引导/指令行——信息不丢），下方两段列表
- 行形态：phase 色点（复用 .trellis-* 色）+ 标题 + active 进度 `3/7` / archived 完成日期；「查看全部」尾行跳 Dashboard trellis 视图（不选任务）
- 高度：面板计入 §4.1 实测回传（扩展 reportTrellisDetailHeight 的测量选择器到面板块）；面板区 max-height 280px + 内部 overflow-y auto（HUD 外层 overflow:hidden 不受影响）
- 替代现交互：chip 点击不再 toggle 详情行（trellis-detail 行退役，其内容上移为面板头）；ESC/再点 chip 收起

## 4. i18n

新键族 `sessionHudTrellisPanel*`（分组头「进行中/已完成」、空态、「查看全部」）×7 语言；复用 `sessionHudTrellisPhase*` 与 `sessionHudTrellisCommand`，不新开阶段键。

## 5. 风险与回滚

| 风险 | 缓解 |
|---|---|
| Dashboard 冷启动时序（窗口未建/未加载） | showDashboard 先行；navigate 指令在 did-finish-load 后发 |
| 归档任务定位依赖 reveal 既有逻辑 | 复用 3141 行 reveal（network ref 跳转同款），不新写定位 |
| HUD 高度暴涨 | 面板 max-height + 内滚；实测回传链已防抖（\|Δpx\|<2 忽略） |
| 回滚 | 单提交 revert；新通道删除不影响既有消费方 |
