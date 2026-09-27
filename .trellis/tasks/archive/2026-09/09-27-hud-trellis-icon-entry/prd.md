# PRD：HUD 面板入口收敛为常驻图标，行交互回归官方

## 背景

hud-click-semantics + hud-panel-entry 两轮把面板入口铺到行单击/空白点击/chip 上，
副作用：双击跳终端时第一击先闪开面板（体验别扭），入口分散语义混乱。用户决定
回归 fork 官方交互，面板（二开功能）用唯一专属入口承载。

官方原样（origin/main session-hud-renderer.js 行单击，已取证）：
清铃铛 → render → canFocus ? focusSession : 不可用反馈 → fire-and-forget ack；
无 dblclick handler、无空白点击 toggle。

## 需求

- **R1 行单击回归官方**：恢复上游逐语义——`unreadSessions.delete` →
  `render()` → `canFocus` ? `focusSession(id)` : `showSessionFeedback(不可用)`
  → fire-and-forget `ackCompletion`。不再 toggle 面板。
- **R2 删双击 handler**：行上 dblclick listener 删除（单击已跳终端）。
- **R3 删空白点击 toggle**：onHudContainerClick / hudContainerClickBound /
  isHudInteractiveTarget / HUD_INTERACTIVE_CLASS_RE 删除；
  `lastBoundExpandedSession` 保留（图标锚定用）。
- **R4 删 chip 点击入口**：trellis chip 保留渲染与 title tooltip，删 click
  listener 与 active 态类（面板开着不再给 chip 高亮）。
- **R5 删面板底部 dblclick 提示**：`.trellis-panel-hint` 及其渲染删除；
  `sessionHudTrellisPanelDblclickHint` i18n 键删除（7 语言）。
- **R6 新增常驻 trellis 图标按钮**：HUD 条底部 pin 按钮旁（同风格
  button）；单击 = `toggleTrellisPanel(lastBoundExpandedSession())`，无 cwd
  锚点时无操作；missing 自动关（现有机制）；面板开着时按钮高亮态；
  tooltip 新键 `sessionHudTrellisToggleTooltip` ×7 语言。
- **R7 数据面不变**：toggleTrellisPanel 竞态守卫、missing 关、owner 存活
  （只要求 owner 在 expanded）等 hud-panel-entry 解耦语义全部保留。

## 验收标准

1. 行单击：清铃铛 + canFocus 跳终端（不可聚焦给反馈）+ ack；面板不开。
2. 行双击无独立语义（两次单击的自然结果）。
3. HUD 空白点击、chip 点击均不再触发面板。
4. 图标单击开/再单击关面板；无 cwd 会话时点击无反应；非 trellis cwd 单击
   后无残留（missing 自动关）。
5. 面板开着时图标高亮；面板内部行为（行点击跳 dashboard、View all）不变。
6. `node test/session-renderer-behavior.test.js` / `session-hud` /
   `session-hud-style` 全绿；全量与预存基线一致；i18n 7 语言键齐。

## 约束

改动集中在 `src/session-hud-renderer.js`、`src/session-hud.html`（按钮样式，
若需）、`src/i18n.js`、`test/session-renderer-behavior.test.js`、spec
`trellis-panel-contract.md`；不动 IPC / activity / state。
