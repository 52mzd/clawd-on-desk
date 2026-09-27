# HUD trellis 任务面板 + Dashboard 跳转

## Goal（用户 2026-09-27 原话）

"只要是目前的会话是在 trellis 工作流的，只要点击 HUD 只能打开 HUD 下面的窗口，窗口就要显示目前已经完成和正在执行的任务，点击任务跳转到 Dashboard 相应的流程中显示详细内容。"

即：把现在"点 chip 展开单任务详情行"升级为"任务列表面板（进行中 + 已完成）→ 点击任务跳 Dashboard 的 Trellis 视图定位详情"。

## 已确认事实（取证）

- **现状交互**：chip 点击 → `toggleTrellisDetail` → 会话行下插入 `.trellis-detail` 单任务行（任务名+引导+指令行）
- **HUD 高度**：§4.1 弹性回传契约（rAF 实测 → `session-hud:set-trellis-detail-height` IPC → `computeHudHeight`）——HUD 窗口可长高容纳面板，机制现成
- **数据源现成**：activity 的 `readActiveList`（进行中，含 taskPath/phase/progress/cwd）与 `readArchiveList`（已完成，newest-first 含 completedAt/durationMs）——Dashboard 独立视图已在消费，HUD 侧需新增拉取通道（session-ipc 域，trusted sender 门禁同既有）
- **Dashboard 唤起**：`showDashboard(options)`（dashboard.js:672）可显示/恢复/聚焦窗口；但 **renderer 无 main→renderer 定位指令通道**（无 command/select 监听，只有 snapshot 广播与 quick-mode）——"切 Trellis 视图 + `selectTrellisSplitTask`"需要新建一条指令通道（含窗口未创建/未加载完成的时序处理）
- HUD renderer 现有 `window.sessionHudAPI`（preload 桥）可扩展

## Requirements（草案）

1. 会话有 trellis 绑定时，点击 HUD（chip）打开"HUD 下面的窗口"= 任务面板，替代现单任务详情行交互
2. 面板内容：该会话项目的进行中任务（phase/进度）+ 近期已完成任务（归档，newest-first 截断）
3. 点击面板任务 → Dashboard 窗口唤起/聚焦 → 切 Trellis 视图 → 选中该任务（split 右栏显示详情卡）
4. 无绑定会话时 HUD 行为与现状一致

## Key Decisions（2026-09-27 用户确认）

1. **面板形态 = HUD 自身向下扩展**（a）：复用 §4.1 弹性高度契约，零新窗口管理；面板区 max-height 280px + 内部滚动
2. **数据范围 = 仅当前会话所属项目**（与绑定语义一致）
3. **已完成显示最近 8 条** + 「查看全部」尾行（跳 Dashboard trellis 视图不选任务）
4. **替代现单任务详情行**（用户原话"只能打开"）：原三行内容上移为面板头，信息不丢

## Out of Scope

- Dashboard 侧任何 UI 改动（只加定位指令通道）
- 归档浏览/筛选等 Dashboard 既有能力
