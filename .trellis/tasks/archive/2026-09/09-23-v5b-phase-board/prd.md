# v5-b Phase 流程列看板（华丽动画）

## Problem

Trellis 视图任务树 + 归档树单列纵堆，元素密集难读（用户痛点"密密麻麻"）。任务天然带
5 个 phase（plan/execute/check/finish/done，`derivePhase` 真相源），流程列看板比树
更适合"一眼看清全局进度"。

## Requirements

- **R1 列看板**：Trellis 视图新增「看板」展示模式（与现有「树」切换）：5 列 = 
  计划 / 执行 / 检查 / 完成 / 已归档，列内任务卡（标题 + phase 徽标 + progress
  刻度条 + 项目小字），树模式原样保留
- **R2 华丽动画**：
  - 列入场：5 列 stagger 依次滑入（translateX + fade，每列延迟 60ms）
  - 卡片 hover：升起（translateY(-2px)）+ 辉光边框 + 阴影加深
  - phase 变化（数据刷新发现任务换列）：卡片平滑飞到新列（FLIP 动画：
  记录旧位置→DOM 移动→transform 反演→过渡归零）
  - 列头计数徽标数字变化时 pop 动画
- **R3 交互保留**：卡片点击 = 打开详情 overlay（v5-a 大卡）；「⛓ 关联」入口保留；
  filter chips（项目过滤）作用于看板
- **R4 降级**：reduced-motion 跳过 FLIP/stagger；任务 >30 时关闭 hover 辉光
  （性能护栏）；窗口 <1100px 宽时看板模式隐藏列动画只留横向滚动
- **R5 数据零新增**：复用现有 readActiveList/readArchiveList 数据面，纯渲染层重构，
  不加 IPC 通道

## Acceptance Criteria

- [x] filter 区新增模式切换按钮（tree⇄board），localStorage 缓存 trellisViewMode
- [x] 列 stagger 60ms×5（translateX+fade）、hover translateY(-2px)+蓝辉光边框、计数徽标 pop（cubic-bezier 回弹）
- [x] FLIP：重建前 snapshot 卡片 rect→replaceChildren 后 diff→card.animate(260ms) 平移补间；reduced-motion/无 rAF 环境降级直接重建
- [x] done 列卡带 completedAt 右对齐小字；⛓/ⓘ 按钮与整卡点击均保留
- [x] reduced-motion 全关；<1100px 列动画关+定宽横滚；单列>30 卡 hover 辉光关（.trellis-board-heavy）
- [x] 全量与基线 diff=0；panel 套件 69 pass（新增 board 分桶纯函数 2 用例）

## Non-Goals

- 不做拖拽改 phase（phase 是派生值，不可手改）
- 不做跨列 WIP 限制
