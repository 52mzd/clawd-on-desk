# PRD — Trellis split view 交互打磨

## 背景

UI 重设计（09-24-trellis-ui-redesign）落地后用户实测反馈三个"不跟手"问题。

## 问题与修法

### 1. selection-only 变化不重建左栏（核心）

`selectTrellisSplitTask()` 每次选中变化都 `renderTrellisViewBody()` 全量重建左栏 DOM —— 点击右栏引用时左栏闪烁、滚动跳转、focus ring 跳走。

修法：当 root/group 折叠/归档/filters 均未变化（仅 selectedTaskPath 变）时走轻量路径：
- 旧选中行移除 `is-selected`、新行加上
- 只更新右栏 detail（仍走 `buildTrellisDetailCard` 单一来源）
- 目标行不在视口时才 `scrollIntoView({ block: "nearest" })`
- 结构性变化（root 切换、折叠、归档开关、filter）仍走全量 rebuild

### 2. 左栏文字截断

- 左栏 `clamp(260px, 28%, 320px)` → `clamp(280px, 30%, 344px)`
- 标题加原生 `title` 属性（悬停显示全名）
- origin tag 从标题行降级到 sub 行，释放标题空间

### 3. 树形层级感

- 缩进处加 1px 弱竖线 guide（child 行左侧，`--border` 色）
- child 行与 parent 的对比拉开：child 13px/400 + muted 色递进（替换现 12px/400）
- 缩进量 14px → 16px

## 验收标准

1. 点击右栏 detail 内引用：左栏无闪烁、无 DOM 重建（仅 class 切换）；目标行可见时不滚动
2. 键盘 ↑/↓ 导航同样走轻量路径，focus ring 平滑跟随
3. hover 截断标题可见全名（title tooltip）
4. 层级一眼可辨（guide line + 字重/颜色递进）
5. 冻结契约全部保持：split-section 卡片、clamp 结构、`buildTrellisDetailCard` 单一来源、split 状态仅内存
6. `npm test` 与基线一致（11045/10979/20，零新增失败）

## 范围外

- 动画/对比度/图标系统（上一任务已完成）
- 右栏 detail 文档内容渲染
