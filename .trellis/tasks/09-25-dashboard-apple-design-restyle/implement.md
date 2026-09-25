# Dashboard apple-design 重构 — 执行计划

前置：`design.md` §1–§8 已定稿。每步结束跑 `npm test`，红了先修再进下一步。

## P1 Token 层与排版（纯 CSS，可整体回滚）

- [ ] 1.1 在 `dashboard.html` 亮色根（L10 起）原位扩展：`--radius-*` / `--shadow-*` / `--material-*` / `--dur-*` / `--ease-*` / `--space-*` / 排版 tracking 变量；暗色根同步补齐（design §1 全表）
- [ ] 1.2 确认 electron 版本支持 `color-mix`（package.json）；不支持则在 design §5 回退方案下预写双套 rgba，并在 1.1 中直接用回退形态
- [ ] 1.3 逐节替换硬编码：header/toolbar 节 → session 卡片节 → trellis 面板节 → overlay/quick 节；每节 border-radius/box-shadow/transition 换 var；保 vendor 前缀区不动
- [ ] 1.4 排版：组标题/窗口标题加负 tracking；11px 徽标加 vibrancy 补偿（design §4）
- [ ] 验证：`npm test`；肉眼亮/暗切换抽查
- [ ] commit：`style(dashboard): P1 token scale + typography (apple-design)`

## P2 材质与深度（纯 CSS）

- [ ] 2.1 顶栏磨砂：`backdrop-filter: var(--material-bar)` + `--bar-bg` + 亮顶边；确认内容从栏下滚过的层次
- [ ] 2.2 session 卡片：边框堆叠 → `--surface` + `--shadow-2`；组标题行保持贴流不加阴影
- [ ] 2.3 badge/tint：状态色改 `color-mix` tint 底 + 全饱和文字（或回退 rgba）
- [ ] 2.4 overlay：`--radius-xl` + `--shadow-3` + scrim 分级；enter 动画准备（blur+scale 同步，class `is-entering`）
- [ ] 验证：`npm test`；`prefers-reduced-transparency` 分支：bar 退实底
- [ ] commit：`style(dashboard): P2 materials & depth (apple-design)`

## P3 动效系统（CSS + renderer 尾部小增量）

- [ ] 3.1 CSS：按压 `:active` scale(.97) `--dur-1`；hover `--dur-2`；fold 缓动换 `--ease-out-apple` `--dur-4`（机制不动）
- [ ] 3.2 overlay enter/exit 对称（enter `is-entering` / exit 既有 `is-closing`，同路径逆序，`--dur-3`）
- [ ] 3.3 renderer：`render()` 尾部加 `noteEnteringSessions()`（上次 id 集合 diff，仅新增卡加 `is-entering`，≈15 行，无 timer）
- [ ] 3.4 首屏 stagger：`--card-index` 变量 + 24ms 步进、5 档封顶（复用 `--split-group-index` 模式）
- [ ] 3.5 `@media (prefers-reduced-motion: reduce)` 统一块：全部动效 → cross-fade；确认无 smooth scroll
- [ ] 3.6 新增静态 guard 测试：reduced-motion 块存在；`backdrop-filter` 只出现在 bar/overlay 白名单选择器
- [ ] 验证：`npm test`；macOS 手动：overlay 开合、fold、新增会话卡入场、每秒重建不重播
- [ ] commit：`feat(dashboard): P3 motion system + entering cards (apple-design)`

## P4 验证与收尾

- [ ] 4.1 quick mode 往返（数字映射、opacity parking、来源恢复）macOS 手动 QA
- [ ] 4.2 Windows/Linux：截图对比 + code-review-first 差异说明（记录到任务目录 `qa-notes.md`）
- [ ] 4.3 性能抽查：每秒重建下无持续 GPU 层（无残留 will-change；动效属性仅 transform/opacity/filter）
- [ ] 4.4 spec 沉淀：renderer-guidelines 增补「动效 = CSS class 布防 + 固定时长、渲染重建不重播入场」等教训
- [ ] 4.5 wrap-up：`task.py archive`

## 回滚点

P1/P2 纯 CSS 各自整体 revert；P3 renderer 增量独立 commit，revert 后仅失入场动画，无功能损失。

## 审查门

- P1 完成后：token 表对照 design §1 逐项过
- P3 完成后：static guards 与手动动效清单过
