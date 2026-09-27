# PRD：HUD 面板入口与活动任务绑定解耦

## 背景

hud-click-semantics 落地后用户实测"单击不展开"。根因：面板入口（行单击 toggle、
空白点击锚定、面板存活判定）全部依赖 `session.trellis` 绑定，而绑定只在活动任务
存在时才有（pointer 由 trellis hook 写，任务归档即清空——实测
`.trellis/.runtime/sessions/` 已空）。任务间隙面板完全无入口。但面板数据
`readHudTaskPanel(cwd)` 本就不依赖活动任务（active 空照样返回归档 8 条）。

## 需求

- **R1 行单击**：任何有 `cwd` 的会话行单击即 `toggleTrellisPanel(session)`，
  不再要求 `session.trellis` 绑定（清铃铛 + ack 语义不变）。
- **R2 非 trellis 项目自动关**：toggle 发起的 fetch 返回
  `status === "missing"`（cwd 无 .trellis root / 不可信）时自动
  `closeTrellisPanel()` 并重绘——非 trellis 项目的行单击无可见残留。
- **R3 面板存活**：render() 的 owner 判定从 `owner && owner.trellis` 放宽为
  `owner` 仍在 expanded 中即可（快照更新不再因无绑定误关面板）。
- **R4 空白点击锚定**：`lastBoundExpandedSession` 同步放宽为 expanded 中
  第一个有 cwd 的会话；`hasTrellisBinding` 若再无消费点则删除（不留死代码）。
- **R5 chip 显示逻辑不变**：行上 trellis 徽标仍只在有绑定时渲染。

## 验收标准

1. 无活动任务但项目有 .trellis：单击行 → 面板开，显示归档任务列表。
2. 非 trellis 项目行单击：fetch 发起，返回 missing 后面板不残留（无可见面板）。
3. 面板开着时快照更新（owner 无绑定）→ 面板不再被误关。
4. 空白点击在无绑定会话场景下仍能锚定第一个有 cwd 的会话开面板。
5. `node test/session-renderer-behavior.test.js` 等定向全绿；全量与预存基线一致。

## 约束

改动集中在 `src/session-hud-renderer.js` + `test/session-renderer-behavior.test.js`
+ spec「整面触发」段；不动 i18n / IPC / activity。
