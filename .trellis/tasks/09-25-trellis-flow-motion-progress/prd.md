# Trellis 流程动画与进度显示排查

## 背景（brainstorm 研究结论，2026-09-25）

### A. 动画：折叠类动效全数失效

行为表（行号属 src/dashboard-renderer.js / dashboard.html）：

| 交互 | 现状 | 期望 |
|---|---|---|
| phase 卡折叠 | 改 collapsedPhases → 整树 replaceChildren 重建 | caret 旋转过渡 + 行收纳动画 |
| 月份头折叠 | 同上 | 同上 |
| 子树折叠 | 改 collapsedPaths → 同上 | 行展开/收纳动画 |
| 选中行 | 局部 classList 路径（renderTrellisSplitSelectionOnly） | ✅ 已有动画，作为参照实现 |
| 入场 is-entering/is-first-frame | 一次性 class + animation | ✅ 正常 |

根因：折叠=整树重建，新元素生来终态，CSS transition 无 from→to。选中路径证明局部更新可行。

### B. 进度 0/11：链路已验证是通的

sessions/<id>.json → readTaskInfo（implement.md checkbox 计数，无则 prd.md 兜底）→ trellisInfoEqual（含 progress 比较，L~940）→ 变化推送 snapshot → renderer。

0/11 不变 = **checkbox 无人勾选**（执行 agent 不维护 implement.md），显示即文件真相。待确认用户所指任务所在 root 及其 implement.md 实际勾选状态。

## 需求（待用户确认后收敛）

- R1 折叠动画修复（方案 A）：折叠改局部 DOM——行预渲染 + `.is-folded` 收纳，caret 局部 toggle；参照既有 renderTrellisSplitSelectionOnly 模式
- R2 进度：**搁置观察**（用户确认 0/11 已自然结束；wallpaper 10/47 证明 checkbox→进度链路在工作，无需改动）
- R3 reduced-motion：折叠动画在 prefers-reduced-motion 下退化为直接显隐

## 非目标

- 不改 trellis CLI / 轮询架构 / IPC
- 不引入 JS 动画引擎（保持 CSS class 记账模式）

## 验收标准

- A1 折叠/展开 caret 有旋转过渡、行有收纳动画；整树重建路径仅在数据变化时触发
- A2 选中行动画不回归；is-entering 不受影响
- A3 npm test 与存量基线一致；折叠键盘导航/选中回归通过
- A4（若选 R2）进度显示与文件状态一致的行为有明确定义并有测试
