# Trellis 感知深化：HUD 过程级 + 关联修剪

## Background

2026-09-27 整合探索链路：官方文档 + 注入原理盘点 → channel 可视化因本机无真实使用被搁置（[[09-27-trellis-channel-visibility]]，取证留存）→ 历史会话挖掘因"沉淀已制度化、过程数据冗余"被否 → 收敛到两个有真实价值且互相独立的交付：HUD 过程级感知 + Dashboard 关联分组修剪。备选（mem 入口 / 任务写操作）记入 [[09-27-idea-pool-v6]]。

## 任务地图

| 子任务 | 交付 | 依赖 |
|---|---|---|
| 09-27-hud-process-awareness | HUD 详情行升级为过程级：正在执行的 trellis 指令（command-name）+ 当前步骤（workflow-state Next-Action），数据源为活跃会话 jsonl 尾部扫描 | 无 |
| 09-27-links-group-trim | 关联分组去纵向冗余、补回成员截断提示、修正"共享 PRD"文案 | 无 |

## 跨子任务验收标准

1. 两者均保持只读红线（零写 / 零 spawn / 零网络），新数据流按 7 段式补 spec（trellis-panel-contract.md）
2. 各自独立走 implement → check → commit → archive；无相互依赖，可并行
3. 复用既有机制：trellis-activity 轮询节律、Dashboard 分组模式、签名防抖——不新建平行实现

## Non-Goals

- channel 可视化（On Hold，见 channel 任务 prd）
- trellis mem / 历史会话挖掘（已否决：沉淀已制度化）
- 任务写操作 D（pool v6）
- HUD 动作层（tool_use 实时流，二期评估）
