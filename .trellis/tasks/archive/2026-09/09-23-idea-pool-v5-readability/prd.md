# 创意池 v5：Trellis UI 可读性重构

## Background（用户原话痛点）

> "dashboard 中 trellis ui 感觉不方便阅读，很多很多元素都密密麻麻的，看看如何拆分一下还是怎么的，prd 打开的这些窗口也是很小，然后不能复制什么的"

开工前代码事实核查（2026-09-24）：

| 痛点 | 代码根源 | 位置 |
|---|---|---|
| PRD 窗口小 | detail card 固定 `min(420px,100%) × min(520px,100%)` | dashboard.html `.trellis-detail-card` |
| 不能复制 | `body { user-select: none }` 全局禁选；`.trellis-detail-doc`（markdown 正文）未局部放开，仅别名编辑框有 `user-select: text` | dashboard.html L59 vs L1556 |
| 元素密集 | Trellis 视图单列纵堆：roots 区 → filter chips → 任务树 → 归档树全部挤一个滚动区 | dashboard-renderer.js `trellis-view-section` 族 |

## 方案（已定，2026-09-24 brainstorm）

用户确认「思维导图模式」评估结论：现有任务结构以单层 parent/children 为主（两层），
经典思维导图收益有限；采用推荐方案——**流程列看板（phase board）**，
phase 是 `derivePhase` 派生的 5 态（plan/execute/check/finish/done），天然适合
「流程图」式呈现，且用户要求「视觉和动画效果华丽」。

两个子任务：

| 子任务 | 交付 | 依赖 |
|---|---|---|
| v5-a doc overlay 放大+可复制+入场动画 | 三种弹层卡片近全屏化，正文可复制，弹入动画 | 无 |
| v5-b phase 列看板（华丽动画） | 树/看板双模式，5 列 stagger+hover 辉光+FLIP 换列动画 | 无（与 a 并行） |

原「密密麻麻」痛点由 v5-b 的看板模式直接缓解（列分桶 + 卡片间距）；
「窗口小/不能复制」由 v5-a 直接解决。

## 待定问题（已清）

- ~~拆分方向~~ → 两子任务并行，无依赖
- ~~密度缓解形态~~ → 看板列分桶（比双列/折叠更贴合任务流转语义）

## Non-Goals（初稿）

- 不动状态机/hook 链路
- 不做 markdown 编辑（只读 + 可复制）
