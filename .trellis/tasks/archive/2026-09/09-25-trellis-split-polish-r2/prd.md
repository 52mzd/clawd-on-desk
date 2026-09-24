# PRD — Trellis split polish R2（左栏深度自查）

## 背景

用户实测 R1 后反馈"还是一样不跟手"，要求自查 + 排查左栏其他不合理之处。用户睡觉去了，交付需自主完成。

## 自查发现与修法

### 1. 左栏滚动位置在结构性 rebuild 后丢失（scroll jump-to-top）

`renderTrellisViewBody()` 全量重建后新 DOM scrollTop=0。折叠其他分组、数据刷新、归档展开都会把视口甩回顶部。

修法：rebuild 前保存 `.trellis-split-list` scrollTop，重建后恢复（clamp 到新 maxScroll）；selection 变化引发的结构 rebuild 后再 `findTrellisSelectedRow().scrollIntoView({block:"nearest"})` 揭示新选中行。

### 2. spec 文档加载态触发整树重建

`fetchTrellisSpecDoc()` 的 loading→result 两个阶段各自 `lastTrellisSpecSignature = null; renderTrellisSpec()`——右栏内容变化却重建左栏，闪烁。

修法：doc 加载态只走 `renderTrellisSplitSelectionOnly()`（右 pane 替换，左栏 class 幂等 no-op）；pane 不存在时回退全量。

### 3. 键盘导航在 sessions 视图下劫持方向键

document 级 keydown 未检查 `activeView`，在 Sessions 视图按 ↑/↓ 也会移动隐藏的 trellis 选择（并有 focus ring 跳走风险）。

修法：`activeView !== "trellis"` 直接 return。

### 4. 行 hover 位移动画造成"文字游走"感

`.trellis-split-row:hover` 的 `translateX(2px)` + `transform` transition 让标题在 hover 时横移——截断标题 hover 变化时更明显，加重"不跟手"。

修法：删除所有行级 translateX/transform transition；hover 只用背景色 tint（120ms）。

### 5. 分组头不随滚动

长列表滚动后看不到当前分组名。

修法：`.trellis-split-group-head` / `.trellis-split-month-head` sticky top:0 + 不透明 surface 背景。

### 6. spec/network 行标题截断无 tooltip

补 `title` 属性（与 task 行一致）。

## 验收标准

1. 折叠/刷新/归档展开后左栏滚动位置保持
2. spec 文档加载中左栏零重建
3. Sessions 视图下 ↑/↓ 无 trellis 副作用
4. 行 hover 无位移
5. `node --test test/dashboard-trellis-panel.test.js` 63/63；`npm test` 11045/10979/20 零回归
