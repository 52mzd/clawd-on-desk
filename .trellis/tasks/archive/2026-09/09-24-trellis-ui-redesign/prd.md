# PRD — Dashboard Trellis UI 重设计（emil-design-eng）

## 背景

用户要求：审查 Dashboard 中 Trellis UI 的不和谐之处（字体大小、按钮等），安装并使用
[emilkowalski/skills](https://github.com/emilkowalski/skills)（`emil-design-eng`）的规则重新设计整个 UI。

## 现状审计摘要（rlm 全量审计 + emil 规则 gap 分析）

### 全局三大系统性问题

1. **排版系统失控**：`.trellis-split-row-title` 与 `.trellis-detail-title` 的字号/行高/字重与 Dashboard
   基线（14px）不一致；detail 视图 meta 文本缩到 10px 低于可读下限；标题层级靠 px 微调而非系统化 scale。
2. **动画纪律颠倒**：高频重建的 split 列表每次 rebuild 都重放入场 stagger 动画，而键盘导航（↑/↓/Enter）
   响应却缺乏即时反馈 —— 与 Emil 规则的频率框架（高频 = 即时，低频 = 才动画）完全相反。
3. **状态语言不统一**：ad-hoc unicode 字符做图标、archive/missing/P2 靠整体降灰 —— 对比度崩塌，
   图标系统不构成可信赖的一致语言。

### Gap 表 Top 项（完整表见 design.md）

| 类别 | 问题 | 提案 |
|------|------|------|
| 按钮 | `.trellis-task-detail-btn` 等无 `:active` 按压反馈 | `scale(0.97)` + 120ms ease-out |
| 按钮 | `.trellis-split-group-head` 是 div 承接点击 | handler 移到 button，`cursor:pointer` |
| 键盘 | 有键盘导航但无 `:focus-visible` 样式 | 显式 spatial feedback |
| 排版 | 10px meta 文本 < 可读下限 | ≥11px，行高放宽 |
| 对比度 | P2 徽标 1px 边框 + 低 alpha 填充 | 文本保 4.5:1，P0/P1 保留强调 |
| 对比度 | 空 `.trellis-progress-tick` 与背景 < 3:1 | 提高 tick 对比 |
| 图标 | unicode 字符（⛓/待填等）做状态图标 | 统一图标方案 |
| 禁用态 | chip-unfocusable / network-ref.is-missing 无 cursor 提示 | `cursor:not-allowed` + `aria-disabled` |

## 不可破坏的契约（trellis-panel-contract.md）

- 侧面板冻结：`.trellis-panel[hidden]` 显示规则、`__handle` 6px→10px hover 增长、`__close`、
  `#panels-body` / `ul.trellis-panel__body` / `.trellis-panel__shard`、18px/level 缩进 —— 均有静态测试守护
- Split view 结构红线：
  - `.trellis-split-section` 本身是共享圆角卡片（border + border-radius + overflow:hidden）
  - 左栏 `flex: 0 0 clamp(260px, 28%, 320px)` 定宽
  - 禁止 per-column 固定 px / vh max-height（高度只来自共享框体 + flex）
  - detail card 单一来源 `buildTrellisDetailCard`（split embed 与 overlay 复用，不得出第二份）
  - split 状态（selectedTaskPath / collapsedPaths / archiveOpen 等）只存内存不持久化
- CSS 落点：`src/dashboard.html`（154 处 trellis 匹配）+ `src/dashboard-renderer.js`

## 验收标准（草案）

1. 所有交互元素（按钮/可点击行/toggle）有 hover + active + focus-visible 三态
2. 文本不出现 <11px；对比度文本 ≥4.5:1、状态指示 ≥3:1
3. 高频路径（列表 rebuild、键盘导航）零重放动画；动画只用于低频转换
4. 字号/间距收敛到 Dashboard 基线变量体系（不再散落魔法 px）
5. 静态契约测试（`.trellis-panel[hidden]`、handle 6→10px 等）全部保持绿色
6. `npm test` 全绿

## 已决策

1. **范围**：Dashboard Trellis 视图 + 宠物旁 Trellis 侧面板（`.trellis-panel__*`）一起按新规则收敛，保持冻结契约。
2. **深度**：20 项 gap 全量落地，按 4 个 commit 分批（排版 → 交互三态 → 对比度/图标 → 动画纪律）。
3. **图标方案**：引入内联 SVG 图标体系（`iconSvg(name)` helper + `currentColor` 继承），替换 unicode 字符（⛓ 等）；跨平台渲染稳定、语义清晰。
