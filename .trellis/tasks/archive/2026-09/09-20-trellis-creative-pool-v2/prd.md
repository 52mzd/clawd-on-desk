# 创意池 v2：气泡具体化 + 等待态 + 详情视图 + 归档分组（父任务）

## 来源

2026-09-20 会话。用户审阅 trellis-card 对照后确认：创意池清单 1-6 项全做
（v1 已交付 3 项：R3/R3.1/R5/recap），v2 收口剩余 4 项，并允许整合交付。

## 任务地图

| 子任务 | 来源项 | 内容 | 依赖 |
| --- | --- | --- | --- |
| bubble-next-step | ①+④ | 气泡显示 implement.md 下一未勾步 + check 阶段"跑测试中"文案 | 无 |
| waiting-auth-state | ② | 等待授权/输入时桌宠等待态（复用既有 wait 动画，无新状态） | 无 |
| task-detail-view | ③ | HUD 详情行 → Dashboard 面板行点击打开任务详情（PRD/进度/阶段史） | dashboard 面板（v1 已交付） |
| archive-group-view | ⑤+⑥ | Dashboard 归档任务浏览 + 父子任务分组视图 | task-detail-view 同批可行 |

## 整合原则

- 4 个子任务共享 trellis 数据层（scanner/phase/activity），先做数据面的
  子任务（bubble-next-step），后做纯 UI 的
- 详情视图与归档分组可以合并冲刺：同改 dashboard-renderer + trellis-panel
- 等待授权态独立（动 state.js 显示层 + permission 桥）

## 跨子任务验收

- 每子任务独立 implement → check → commit → archive
- 全部完成后真机冒烟：气泡内容、等待态、详情、归档四者同屏
- R4 零开销红线贯穿：无 trellis 数据时零新增轮询/渲染负担
