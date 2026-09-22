# 创意池 v4：任务关联视图对齐 trellis-card

## Background

对齐 https://github.com/czm15053/trellis-card 的能力盘点结论：v1–v3 已覆盖其全部单任务能力（任务卡、进度、checklist、气泡、文档渲染、归档树、多项目 roots）。剩余缺口集中在**任务之间 / 任务与规范之间**的关联呈现，共三件，各自独立可验收，按依赖排序为 a → (b ∥ c)。

## 任务地图

| 子任务 | 交付 | 依赖 |
|---|---|---|
| v4-a 规范地图 | Trellis 视图 overlay 内浏览 `.trellis/spec/`：侧栏 index + 白名单 GFM 渲染 + 源项目标注 | 无（复用 v3 overlay 与 GFM 渲染器） |
| v4-b 关联网络 | 任务列表行内「关联」入口 → overlay 显示任务间结构化关联（parent/children/subtasks）与 commit/shared-files 协作线 | v4-a 的 overlay 容器 |
| v4-c 小件打包 | ① planning 阶段 waiting 视觉态 ② 详情文档区默认折叠可展开 ③ 进度徽标加刻度条形态 | 无 |

## 跨子任务验收标准

1. 三件交付全部只在 Dashboard Trellis 视图/overlay 内，不触碰桌宠主窗口、状态机、hook 链路
2. 复用 v3 已有资产：GFM 白名单渲染器、overlay 容器、月度归档树——不新建平行实现
3. 每件独立走 implement → check → commit → archive（老规矩）
4. 新增跨层通道（若有）必须按 trellis-panel-contract.md 的 7 段式补 spec

## Non-Goals

- 不做 spec 编辑/保存（只读浏览）
- 不做会话 jsonl 内容挖掘（本仓库任务目录实测无 implement.jsonl/check.jsonl，证据源不可靠）
- 不做任务关系的人工编辑（只读呈现已有结构化字段）
