# Renderer Guidelines

> 原生 DOM。外来内容 createElement-only；自家静态常量模板豁免。signature 防重渲染。

---

## DOM 构建红线

**外来/动态内容（agent 上报文本、task/spec markdown、文件路径、session 数据）必须
`createElement` + `createTextNode`，禁止拼进 `innerHTML`：**

```js
// ✓ 正确（dashboard-renderer.js 全文件 0 innerHTML，399 个 trellis 文案键全部此形态）
const btn = document.createElement("button");
btn.appendChild(document.createTextNode(ref.title || ref.taskPath));

// ✗ 错误——title 来自磁盘上的 task.json，恶意 `<img onerror>` 会执行
btn.innerHTML = `<span>${task.title}</span>`;
```

**豁免：自家静态常量模板**（`src/session-hud-renderer.js` 的 `bell.innerHTML = BELL_SVG`、
`settings-renderer.js` 的 `getTabIcon()` 图标）。这些字符串写死在代码里、不含运行时变量，
属可接受形态。判据：模板串里若插值了任何运行时来源（`task.`/`payload.`/文件读出），回到 createElement。

markdown 渲染统一走 `src/trellis-doc-renderer.js` 白名单构建器
（`renderMarkdownDoc(trellisDocBuilder, content)`），script/onerror/javascript: 全惰性文本化。
不要在 renderer 里另写 markdown 解析。

## Signature 防重渲染

高频刷新的 UI 区块用签名短路，避免每 tick 重建 DOM（`dashboard-renderer.js` 既有形态，
Trellis 面板/HUD/quota 全在用）：

```js
let lastTrellisPanelSignature = null;

function renderTrellisPanel() {
  const signature = JSON.stringify([deps..., state...]);
  if (signature === lastTrellisPanelSignature) return;
  lastTrellisPanelSignature = signature;
  root.replaceChildren(buildPanel());
}
// 任何改状态的地方先置 lastXxxSignature = null; 再触发 render
```

规则：签名必须覆盖渲染输入的全部字段（loading/data/selected/truncated…）；漏一个就会
“数据变了界面不动”。

**同一根因的变体（v6.1 连环 bug 实录）**：改的是“签名没覆盖的那个状态”时，界面同样不动。
典型案例 `setTrellisViewMode()`：只写 `trellisView.mode = x` + `renderTrellisView()`，
但 view/panel 两个签名都没包含 mode，重渲染被短路 →“点按钮没反应”。修复形态是
统一走 `renderTrellisViewBody()`（先置空 view 签名再渲染）。规则：**任何 view-state
变更（mode/selection/fold/open）后，要么该状态进签名，要么变更处显式置空签名**；
新增强相关的状态时优先包一个 invalidate+render 入口函数，禁止裸赋值后直接调 render。

## Overlay 状态对象模式

模态浮层（task detail / spec map / network）统一形态：模块级 `const xxx = { open, loading,
seq, … }` + `open/close/fetch/render` 四函数 + 独立 `overlayEl`（html 里预置 `hidden` div）：

- **stale guard**：异步回包检查 `seq`/`open`/身份字段（root/taskPath），过期即丢弃
- **关闭即清缓存**：`close()` 里清 Map 缓存 + `replaceChildren()` + `hidden = true`
- **Esc/背景点击**绑定一次（初始化处），多个 overlay 共存时 Esc 按后开优先关
- 事件绑定挂卡片内元素，随 `replaceChildren` 自然回收——不用 addEventListener 泄漏检查

## 尺寸与 zoom 安全（硬线）

**弹层/浮层尺寸禁用裸 viewport 单位（vw/vh）**——dashboard 的文字缩放补偿机制
无法补偿 viewport 单位，会直接破坏大字号可用性（v5-a 实际踩过：先写
`min(880px, 92vw)` 被 settings-renderer-browser-env 测试红牌，改 percent-only 才过）。
正确形态是百分比链接到定位父级 + px 上限：

```css
/* ✓ */
width: calc(100% - 48px);
max-width: 880px;

/* ✗ */
width: min(880px, 92vw);
```

既有把关：`test/settings-renderer-browser-env.test.js` 扫 viewport 单位，全量必跑。

**常驻面板高度同禁区（v6.1 踩过三步）**：面板类布局（非弹层）禁用固定 `max-height`
（像素或 vh 都不行——`640px` 和 `min(72vh,720px)` 都被用户当场打回）。正确形态是
flex 链路填满：`main` 改 `flex column`，section `flex:1 1 auto; min-height:0`，
两栏各自 `min-height:0` 内部滚动。判据：把窗口拉高，面板必须跟着长。

## 全局样式陷阱（元素选择器继承）

新建小尺寸控件前先查它继承的元素级样式，本仓库已知两个：

1. **`button { min-width: 82px; … }`**（dashboard.html ~2595）：任何图标/caret/小按钮
   不显式 `min-width: 0` 会被撑成 82px 宽（v6.1 caret 踩过：负 margin 修正位置后
   仍被 min-width 撑爆，视觉“箭头不明显/错位”）。同批还要覆盖 `height/min-height`。
2. **`.trellis-view-section { flex-direction: column }`**：挂在它下面的新 section
   要并排布局必须显式 `flex-direction: row` 覆盖（v6.1 左右栏变上下）。

调试方法：UI 错位时先用 CDP `getBoundingClientRect()` + `getComputedStyle()` 量化
实际尺寸/坐标，再定位到规则；盲改 margin/padding 两轮都失败、量化后一次命中。

## 事件与定时器

- 行内按钮 `stopPropagation()`（防触发行选中/展开）
- renderer 内 `setTimeout`/`requestAnimationFrame` 必须可取消（存 id，关闭路径 clear）；
  参照 `renderer.js` 的 swapToken 防竞态写法

## CSS 选择器必须核对 renderer 实际 className（v7 R9fix 踩过）

**改/写任何 CSS 规则前，先 grep renderer 里元素实际挂的 className 串。**
复合选择器（`.a.b { }`）若 `a` 类从未挂上元素，整套规则**静默零命中**——
无构建报错、无测试红牌，只有运行时布局崩坏（v7 R9：CSS 写
`.trellis-spec-card.trellis-spec-split`，renderer 挂的是
`trellis-view-section trellis-split-section trellis-spec-split`，列方向规则全灭，
header/list/doc 挤成一行，用户截图打回）：

```js
// 改 CSS 前必核对：
//   grep -n 'className = .*你要选的类' src/dashboard-renderer.js
// 元素挂多类时，CSS 用单类选择器 + 显式覆盖冲突基类
//（如 .trellis-spec-split 显式 flex-direction:column 盖掉 split-section 的 row、
//  margin:0 盖掉 view-section 的 margin-bottom）。
```

判据：新写的选择器在 renderer 里 grep 不到完整类名组合 = 大概率写错了。
沙盒测试（FakeElement）不跑 CSS，选择器失配只能靠人工核对或真机截图发现。

## 派生内容必须跟随过滤作用域（v7 R10fix 踩过）

**懒加载的副视图（分组/面板/抽屉）若从全局状态（selectedRoot/过滤词）派生
数据源，切作用域时必须重拉**，否则每个入口看到的都是首次加载的那份
（v7 R10：spec/关联分组只在首展开拉取一次，切项目 chip 后内容不变，四轮
反馈打回）。固定形态：

```js
// 单一 scope 真相函数（与列表过滤同源，不要另写一份判断）：
function currentScopeRoot() { return state.selectedRoot || state.roots[0] || null; }
// 每次视图重建时同步检查：展开中 + root 变了 + 无在途 fetch → 清缓存重拉
function syncPanelScopes() {
  const root = currentScopeRoot();
  if (panelOpen && panel.open && panel.root !== root && !panel.loading) refetchPanel(root);
}
// 主 render 入口开头调 syncPanelScopes()
```

判据：任何按 root/cwd/过滤词取数的缓存，问一句"切 chip 后它重拉吗？"
答不上来就是漏了。
