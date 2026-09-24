# Design — Dashboard Trellis UI 重设计

## 1. 设计原则（emil-design-eng 落地规则）

1. **状态三态**：所有交互元素 hover / active / focus-visible 缺一不可；按压反馈 `scale(0.97)` + 120ms。
2. **频率框架**：高频路径（列表 rebuild、键盘导航）零动画、即时响应；动画只留给低频转换（视图首次进入、overlay 出现）。
3. **排版即层级**：字号/字重/颜色构成一致 scale，不靠散落魔法 px 微调。
4. **对比度红线**：正文文本 ≥4.5:1，状态指示（dot/tick/badge）≥3:1；"弱化"只作用于装饰元素，永不吞掉文本可读性。
5. **图标是语言**：统一内联 SVG（`currentColor` 继承），替换所有 unicode 字符图标；尺寸对齐光学栅格。

## 2. Design tokens

### 现有全局变量（复用，不新增重复语义）

`--accent / --accent-hover / --bg / --border / --muted / --subtle / --surface / --surface-alt / --text / --row-border / --scroll-thumb(-hover) / --done / --idle / --interrupted / --running`

### Trellis 局部 token（新增于 `src/dashboard.html` trellis CSS 块顶部）

```css
:root {
  --trellis-font-title: 600 13px/1.45 var(--font); /* 行标题基线 */
  --trellis-font-sub: 400 12px/1.5 var(--font);    /* 次行 65% 前景 */
  --trellis-font-meta: 500 11px/1.4 var(--font);   /* 时间/计数，tabular-nums */
  --trellis-radius: 6px;                            /* 行内小件 */
  --trellis-press: transform 120ms cubic-bezier(0.23,1,0.32,1);
}
```

### Typography scale（收敛目标）

| 元素 | 现状 | 目标 |
|---|---|---|
| split 行标题 | 不定 | 13px/600 |
| split 行副文本 | 不定 | 12px/400, muted |
| 行侧时间 `d/t` | 10px | 11px/500, `font-variant-numeric: tabular-nums` |
| group 标题/计数 | 不定 | 12px/600 / 11px/500 tabular-nums |
| detail h2 | 不定 | 16px/600（badges 11px/500 让位） |
| 所有 meta/chip | 10px | ≥11px（硬下限） |

## 3. 分批改动明细（4 批 = 4 commits）

### Batch A — 排版收敛（`src/dashboard.html` trellis CSS）

- 新增 trellis 局部 token；上表 6 类元素全部改到 scale
- 删除散落 magic px（10px → 11px；行高统一 1.4–1.5）

### Batch B — 交互三态（CSS + `src/dashboard-renderer.js`）

- `.trellis-task-detail-btn` / `.trellis-split-caret` / `.trellis-split-refresh` / `.trellis-split-foot-btn` / `.trellis-filter-manage`：补 `:active` scale(0.97) + `:focus-visible` outline
- `.trellis-split-group-head`：click handler 从 div 移到 `.trellis-split-group-toggle` button（保留 stopPropagation 防双触发）
- `.trellis-session-chip-unfocusable` / `.trellis-network-ref.is-missing`：`cursor: not-allowed` + `aria-disabled`
- split 列表键盘导航行：` :focus-visible` 显式 spatial feedback

### Batch C — 对比度 + SVG 图标（CSS + renderer.js）

- `is-archived` / `is-missing`：只 dim dot/tags/badges 至 50%，标题文本保 ≥4.5:1
- `pri-p2`：去低 alpha 填充，改 1px border + 4.5:1 文本；P0/P1 强调保留
- 空 `.trellis-progress-tick`：1px stroke 30% 前景色（≥3:1）
- 新增 `iconSvg(name)` helper（内联 SVG, `currentColor`）；替换 ⛓ 等 unicode 图标；caret 改 12px SVG 居中于 16px slot，phase dot 8px 居中

### Batch D — 动画纪律（renderer.js + CSS）

- split 列表 rebuild：入场 stagger 动画只在首次挂载播放，后续 rebuild 零重放
- 键盘导航选中：改用即时类切换（无 transition）
- 保留低频动画：detail overlay 出现、视图首次进入

## 4. 契约红线（不可破坏，静态测试守护）

- 侧面板：`.trellis-panel[hidden]`、`__handle` 6px→10px hover、`__close`、`#panels-body` / `ul.trellis-panel__body` / `.trellis-panel__shard`、18px/level 缩进
- Split 结构：`.trellis-split-section` 共享圆角卡片（border + radius + overflow:hidden）；左栏 `flex: 0 0 clamp(260px, 28%, 320px)`；禁止 per-column 固定 px/vh max-height；detail card 单一来源 `buildTrellisDetailCard`；split 状态只存内存

## 5. 风险与回滚

- **平台字体渲染差异**：11px 下限在 Windows/macOS/Linux 需手动 QA（Linux 无真机则 code-review-first 说明）
- **静态测试**：改动前先跑 `npx node --test test/ -g trellis` 获取基线，任何 selector 重命名必须同步测试
- **回滚**：4 个独立 commit，任一批次出问题单独 revert，不牵连其他批次
