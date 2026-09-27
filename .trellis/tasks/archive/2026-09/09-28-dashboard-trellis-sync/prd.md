# Dashboard trellis 同步修复：HUD 跳转切项目 chip + roots 自动发现与刷新

## Goal

修复两个同步缺陷：① HUD trellis 条目点击跳转后 Dashboard 停留在『所有项目』合并视图，应按 payload.cwd 解析 owning root 并切对应项目 chip；② Dashboard 项目 chips 为注册制且无刷新（one-shot 读 + 设置端变更无广播），新项目在设置扫描可见但 Dashboard 永远不出现——补 activity 解析 root 的自动注册 + roots 变更广播刷新。

## Background / 根因（2026-09-28 诊断）

- **Bug 2**：`jumpToTrellisNetworkTask`（dashboard-renderer.js:3319）切 root 只认
  `trellisNetwork.root`（网络总览面板上下文），HUD 跳转场景为 null/陈旧 →
  `selectedRoot` 保持 null（"All projects" 合并视图）。HUD 的 payload.cwd 未被
  用于解析 owning root（现成工具 `trellisTaskOwningRoot(cwd, roots)`）。
- **Bug 1a**：dashboard roots 是 one-shot 读（仅视图切换拉取，spec 口径
  "never a poll"）；设置端 / dashboard 端 add/remove root 后无广播。
- **Bug 1b**：HUD trellis 面板按 session cwd 向上解析 .trellis（不管注册），
  dashboard chips 只列注册 roots——跑过会话的新项目 HUD 可见、Dashboard 缺席
  （设置的 trellis 标签页是扫描制，所以"设置里看到了，dashboard 没有"）。

## Requirements

- **R1（Bug 2）**：HUD 条目跳转落地 Dashboard 时，按 payload.cwd 经
  `trellisTaskOwningRoot(cwd, trellisView.roots)` 解析 owning root；命中注册
  root 则切 `selectedRoot` 到该 chip 并展开定位条目。未命中（未注册项目）保持
  现状（合并视图选中正确条目）。冷启动（roots 未加载）时序必须处理：等 roots
  就绪后再解析，不能静默丢失。
- **R2（Bug 1b）**：activity 侧解析 session cwd 得到 root 时自动注册进
  rootsStore（幂等 add + `syncTrellisPersistedRoots`），使跑过会话的新项目
  自动出现在 Dashboard chips。自动注册只收 activity 已解析的 session root，
  不给 pick 流程引入向上爬。
- **R3（Bug 1a）**：roots 集合变更（自动注册 / 手动 add / remove）后通知已打开
  的 dashboard 渲染器，收到后刷新 roots（及 active 列表）。事件驱动推送，不是
  轮询——与 spec "never a poll" 口径相容。

## Acceptance Criteria

- [ ] AC1: HUD 点击条目跳转，cwd 归属已注册 root 时，Dashboard 自动选中该
      root 的 chip，条目在过滤视图中可见且被选中。
- [ ] AC2: 未注册 root 的跳转行为不回归（合并视图选中正确条目）。
- [ ] AC3: 新项目目录跑一个会话后（HUD 面板可解析到），Dashboard chips 自动
      出现该项目，无需手动 add。
- [ ] AC4: 手动 add/remove root 后，已打开的 Dashboard chips 同步更新。
- [ ] AC5: R1/R2/R3 各有回归测试；全量测试零失败。
- [ ] AC6: trellis-panel-contract.md 同步更新（跳转切 chip 行为、roots 事件
      推送口径）。

## Constraints

- 最小修改：复用 `trellisTaskOwningRoot` / rootsStore.add / 既有 IPC 模式，
  不新建抽象。
- 自动注册写入点收敛在 activity 解析处一处，避免多处 add 漂移。
