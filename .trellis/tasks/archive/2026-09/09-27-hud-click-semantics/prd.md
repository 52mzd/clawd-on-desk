# PRD：HUD 单击/双击统一语义

## 背景

上一轮（hud-panel-readability）的"空白点击 toggle"实际无可点区域——会话行铺满
HUD 全宽、行间无空隙，可点空白仅剩边缘 2-3px padding，用户点击 HUD 几乎总是
落在行上 → 跳终端。用户拍板统一语义，本任务修正。

## 需求

- **R1 单击任意会话行 = toggle trellis 面板**，锚定该行会话（须有 trellis
  绑定）；**无绑定行单击 = 无操作**（不跳终端、不弹反馈、零 fetch）。
- **R2 双击任意会话行 = 跳终端（focusSession）**，这是 HUD 跳终端的**唯一
  入口**（不分有无绑定）；跳转时顺手关闭面板（若开着）。`canFocus=false`
  的行双击显示不可用反馈（原 showSessionFeedback 语义）。
- **R3 未读清理保留在单击**（用户修正）：原单击行里的 `unreadSessions.delete`
  + `ackCompletion` 保留在单击——单击即"注意到了"，铃铛随手清，与开面板
  不冲突。双击跳终端时不重复处理（单击已先触发）。
- **R4 折叠行**（"其他 N 个会话"）保留单击 openDashboard，不参与本语义。
- **R5 面板底部加 hint**：`sessionHudTrellisPanelDblclickHint`（"双击会话行
  跳转终端"）×7 语言，唯一消费点为面板底部 hint 行。键序对齐断言须过。
- **R6 空白点击 toggle**（上一轮实现）语义不变（锚定最近活跃绑定会话）。

## 验收标准

1. 单击绑定行 → 面板开；再单击同行 → 面板关；单击无绑定行 → 零操作零 fetch。
2. 双击行 → focusSession 被调；面板若开着则同帧关闭；ackCompletion 已随单击触发，
   双击不重复（断言 ack 次数不增长）。
3. unfocusable 行：双击 → 不可用反馈文案；单击（无绑定）→ 无操作。
4. i18n 7 语言新键到位、键序对齐断言全绿。
5. `node test/session-renderer-behavior.test.js` + `node test/session-hud.test.js`
   + i18n 相关测试全绿；全量与预存基线一致（仅 readme 贡献者红）。
6. 无新增 console.log / innerHTML；CSS 类定义↔引用双向存在。

## 约束

- 改动集中在 `src/session-hud-renderer.js`（行点击分发）+ `src/i18n.js`（一键
  ×7）+ 面板底部 hint 元素；`src/session-hud.html` 最多加 hint 样式类。
- spec `.trellis/spec/guides/trellis-panel-contract.md` 的"整面触发"段随语义
  更新（单击行为变更 + 双击入口）。
