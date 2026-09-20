# 创意池 v1：阶段化身 + Dashboard 任务页 + 日报（父任务）

## 来源

2026-09-20 会话：用户确认把创意池剩余项全部实施（R3 / R3.1 / R5 /
日报），按依赖排序分三个子任务交付。

## 任务地图

| 子任务 | 内容 | 依赖 |
| --- | --- | --- |
| avatar-animations | R3 阶段配件（wizard-hat）+ R3.1 并行 juggling | 无（R1 数据层已就绪） |
| dashboard-page | R5 Dashboard Trellis 只读面板 + 行点击聚焦会话 | 无（与 avatar 并行可行，但串行降风险） |
| recap-report | 日报 Trellis 段（新建/完成计数，继承 recap 红线） | 建议最后（数据面稳定后收口） |

## 跨子任务验收

- 每个子任务独立走 implement → check → commit → archive
- 全部完成后：真机 `npm start` 冒烟，确认宠物配件、Dashboard 面板、
  小结 Trellis 段三者同屏正常
- 红线：R4 零开销（无 Trellis 数据时零新增轮询/渲染负担）贯穿三个子任务

## 顺序

1. avatar-animations（渲染层消费已就绪的 trellis 数据，最小闭环）
2. dashboard-page（UI 面）
3. recap-report（数据沉淀收口）
