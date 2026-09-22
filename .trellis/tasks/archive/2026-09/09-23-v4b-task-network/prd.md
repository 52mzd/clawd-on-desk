# v4-b 关联网络（Task Network）

## Problem

任务间的结构化关联（parent/children/subtasks、共享 commit、共享文件）已经躺在每个 task.json 里，但 UI 只在树视图里体现 parent 层级。trellis-card 的「同族任务」「关联网络」呈现缺失——用户看不出两个任务是否同批、是否改过同一批文件。

## Requirements

- **R1 入口**：任务列表每行（活跃 + 归档）加「关联」入口，仅当该任务确有关联数据时出现
- **R2 结构化关联**：overlay 显示 parent、children、subtasks（名称 + 状态 chip + 点击跳转该任务详情）
- **R3 协作线**：从 roots 内全部任务（含归档）聚合 `commit` 与 `relatedFiles`，呈现「共享文件的兄弟任务」「相邻 commit 的同批任务」两组线索，只读
- **R4 证据源边界**：只信 task.json 结构化字段；jsonl 上下文（implement.jsonl/check.jsonl）本仓库任务目录实测不存在，明确不作为证据源
- **R5 规模上限**：单任务关联渲染上限 20 条；聚合扫描 roots 全量任务时有总上限（如 500 任务），超限截断并标注

## Acceptance Criteria

- [ ] 09-23-idea-pool-v4-linkage 父任务行点「关联」能看到 3 个子任务及各自状态
- [ ] 子任务行能看到 parent 回链
- [ ] 共享 relatedFiles 的两个任务互相出现在对方的「共享文件兄弟」组
- [ ] 无关联数据的任务不渲染入口（不出现空 overlay）
- [ ] 超限场景有明确截断标注
- [ ] 新跨层通道按 7 段式补 spec

## Non-Goals

- 不做关系编辑（加/删 parent）
- 不做图形化力导向网络（首版列表分组足够，视觉网络留给未来）
