# 创意池 v3：独立 Trellis 视图 + 多项目 + 文档阅读 + 任务树 + 生命周期感知（父任务）

## 来源

2026-09-21 会话。用户反馈：归档浏览寄生在会话面板里（无活跃会话时不可达），
对照 trellis-card 还有生命周期感知 / 任务树 / 多项目筛选 / 文档阅读（GFM）
缺口，确认全做。

## 任务地图（按依赖排序）

| # | 子任务 | 内容 | 依赖 |
| --- | --- | --- | --- |
| 1 | trellis-workspace | 独立 Trellis 视图（Dashboard 独立 tab），roots 持久化 + 手动管理，不依赖活跃会话 | 无（地基） |
| 2 | project-filter | 多项目 chip 筛选（按 root basename 区分/合并/单选） | #1 |
| 3 | doc-reader | 文档视图：PRD/DESIGN/IMPLEMENT/验收/research 全可读，自写受限 GFM 子集渲染 | #1 |
| 4 | task-tree | 活跃+归档统一树形（parent 嵌套跨域） | #1 #2 |
| 5 | lifecycle-feedback | 阶段切换即时视觉反馈（过渡动画/气泡） | 可与 #2-4 并行 |

## 红线（贯穿）

- recap 持久层零变化：文档阅读是 ephemeral 渲染，不落盘任何任务内容
- GFM 渲染：白名单标签 + createElement（禁 innerHTML），代码块纯转义
- 无新常驻轮询：roots 持久化走 prefs 低频写；文档按需单读
- R4 零开销：无 trellis 数据时零新增负担
- 每件独立 implement → check → commit → archive

## 跨子任务验收

- 全部完成后真机冒烟：无任何活跃会话时打开独立视图可见归档；多项目切换；
  读一篇带表格/checklist 的 PRD；树形展开；阶段切换动画
