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
"数据变了界面不动"。

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

## 事件与定时器

- 行内按钮 `stopPropagation()`（防触发行选中/展开）
- renderer 内 `setTimeout`/`requestAnimationFrame` 必须可取消（存 id，关闭路径 clear）；
  参照 `renderer.js` 的 swapToken 防竞态写法
