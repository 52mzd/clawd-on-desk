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

**反向陷阱（09-25 局部折叠）**：不经过 render 而**直接在 DOM 上落地**的状态变更
（局部 class 翻转）必须反过来把签名**刷成当前值**（`syncTrellisViewSignature()`）。
签名留在旧值 → 下一次 1s tick 把存储态当"新数据"整树重建，把则刚做完的局部更新和
进行中的 transition 一起冲掉。两边对称：**重建生效 → 置空签名；就地生效 → 同步签名**。

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
3. **作者 `display` 打败 `[hidden]` 属性**：UA 对 `[hidden]` 的 `display:none`
   优先级低于任何元素/类选择器里的显式 `display`（flex/grid/block）。给会被
   JS `.hidden = true` 隐藏的元素写 `display: flex`（折叠卡片、quick banner、
   quota summary 都踩过）后，hidden 属性失效、元素仍然可见。dashboard.html
   已有全局守卫 `[hidden]{display:none!important}`（静态测试守护，勿删）；
   新 HTML 页面同样要带这条守卫，或改用 class 切换 display。详见
   `guides/trellis-panel-contract.md` §8c。

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

## 动效 = CSS class 记账，重建不重播（apple-design R1 踩过）

**Dashboard 每 1s 全量重建 DOM，任何挂在卡片上的 animation class 都会在下一轮
replaceChildren 后重播**。入场动画只能"标记新增"，不能"标记在场"：

```js
// ✅ 用 id 集合 diff 标记新增卡，下一轮重建自动丢 class（一次性）
enteringSessionIds = new Set(ids.filter(id => !knownSessionIds.has(id)));
if (enteringSessionIds.has(session.id)) card.classList.add("is-entering");

// ❌ 直接给所有卡加入场动画 → 每秒闪一次
```

首帧整列表入场用容器 class（`is-first-frame`）+ setTimeout 摘除，而不是逐卡
stagger（卡片活在各自 group 父级里，逐卡 index 维护成本高）。

**vm sandbox 陷阱**：renderer 会被 node:test 的 vm.runInNewContext 无 timer 环境
加载（dashboard-session-history.test.js），顶层直接调 `setTimeout` 会 ReferenceError。
新代码用 timer 前先惰性探测：

```js
const enroll = typeof setTimeout === "function" ? setTimeout : null;
if (enroll) { ... } // 探测不到就跳过动画布防，功能不受损
```

## 折叠类交互必须局部 class 翻转，禁止整树重建（09-25 折叠动画失效复盘）

**根因**：CSS transition 需要*存活的元素*经历 from→to；折叠实现走
`replaceChildren` 重建，新元素生来终态，transition 静默失效（caret 不转、
行不收——不崩，只是"感觉不对"）。

```js
// ❌ 折叠 = 改状态 + 整树重建 → 所有 transition 失效
trellisSplit.collapsedPhases.add(phase);
lastTrellisPanelSignature = null;
renderTrellisViewBody();

// ✅ 折叠 = 找到已挂载的卡，翻 class；caret 旋转是可感知反馈
card.classList.toggle("is-folded", folded);     // 行显隐（卡 class）
head.classList.toggle("is-collapsed", folded);  // caret 旋转
toggle.classList.toggle("is-collapsed", folded);
```

### class 记账：显隐与旋转是两套类，四个写入点必须一致

| 职责 | 元素 | 类 | CSS 锚点 |
|---|---|---|---|
| 行显隐 | 行 | `is-subtree-folded` / `is-month-folded` | `.trellis-split-row.<类> { display:none }` |
| 行显隐 | phase 卡 | `is-folded` | `.trellis-split-phase-card.is-folded > .trellis-split-row` |
| caret 旋转 | 行 | `is-collapsed` | `.trellis-split-row.is-collapsed .trellis-split-caret` |
| caret 旋转 | group head / 其 toggle | `is-collapsed` | `.trellis-split-group-head.is-collapsed …` / `.trellis-split-group-toggle.is-collapsed …` |
| caret 旋转 | month head | `is-collapsed` | `.trellis-split-month-head.is-collapsed …` |

**不要合并成一个类**：显隐与旋转职责不同，合并必有一个失效。
**四个写入点必须写同一套**：点击、整树重建、expand-all、collapse-all。
死类教训（acb422fb）：行上写 `is-folded`、caret 上写 `is-collapsed` 都是
零 CSS 消费者的裸类名 → 旋转锚点零命中；expand-all 只清 caret 的类、
collapse-all 只给 caret 加类 → 展开后 caret 仍指折叠态。
判据：每个写入的类都要能在 CSS 里 grep 到消费者，每个折叠 CSS 类都要有
renderer 写入者（`test/dashboard-trellis-panel.test.js` 有静态守卫）。

### 真机 DOM 陷阱：`parent.children` 是 HTMLCollection

`Element.children` 是 `HTMLCollection`：**`Array.isArray()` 恒为 false，且没有
`indexOf`**。写成 `Array.isArray(parent.children)` 会让局部路径在真机 100%
落回整树重建——而不崩、只是动画没了。**探测一律用 `Array.from()`**
（HTMLCollection 与普通数组都能归一化，之后 `indexOf` 可用）：

```js
function applySubtreeFold(childrenLike, row, folded) {
  const siblings = Array.from(childrenLike || []); // ← 唯一正确形态
  const start = siblings.indexOf(row) + 1;
  if (start <= 0) return [];
  const myDepth = Number(row.dataset.depth || "0");
  for (let k = start; k < siblings.length; k++) {
    const node = siblings[k];
    if (!node.classList.contains("trellis-split-row")) break;
    if (Number(node.dataset.depth || "0") <= myDepth) break;
    node.classList.toggle("is-subtree-folded", folded);
  }
}
```

**配套要求**：
1. 行常驻渲染（折叠行也 mount，靠 class 隐藏）+ `data-depth` 标层级
   （折叠时按深度扫兄弟行）。无 `parentNode` 时（vm 沙箱 / 游离节点）回退
   整树重建——行为正确、无动画；**这个回退分支不能删**。
2. 行常驻 → **所有枚举都要过滤可见性**。`querySelectorAll` 不会跳过
   `display:none` 的行：键盘导航（↑/↓）、Enter、选中行查找、滚动/聚焦目标
   必须统一走一个 `isTrellisRowVisible()`（自身折叠类 + 祖先 phase 卡
   `.is-folded`），否则会"选中不可见行"（界面看着像没反应）。
   已知语义（有意，不是 bug）：**选中行被折叠后 ↑/↓ 不响应**（`findIndex`
   落空即早退），而不是"跳到最近可见行"；全部行都折叠时同样早退、不崩。
3. **局部翻转后要同步结构签名**（`syncTrellisViewSignature()`）：折叠状态
   （collapsedPaths / openMonths）在结构签名里，不刷新的话下一次 1s tick
   会把旧状态当"新数据"整树重建，把刚刚的局部成果和进行中的 transition
   一起冲掉。
4. 选中（`renderTrellisSplitSelectionOnly`）与折叠是同一模式：
   新增「状态翻转→视觉反馈」交互一律走此路径。
5. **stub 直测守不住探测条件本身**（09-25 二次复盘）：类 HTMLCollection 的
   stub 直测只能覆盖 `applySubtreeFold()` 的**内部归一化**；把点击路径的
   探测条件改回 `Array.isArray(parent.children)` 时，stub 测试与全套测试
   **依然全绿**（真实失败形态是"真机不生效、测试看不出来"，不崩不报错）。
   所以需要第二道防线：在 `test/dashboard-trellis-panel.test.js` 用**静态断言**
   禁止 `Array.isArray(…children)` 形态，以及禁止 `row` / `caret` 上的
   `is-folded` 写入（该类的唯一合法宿主是 phase 卡）。
   规则：**任何“沙箱里两种形态表现一致”的真机陷阱，都必须有一条机器可判定的
   静态断言兜底**；每条新断言都要逆向验证（注入错误形态即变红），否则等于没写。

**布局补偿陷阱**（第一次修复失败原因）：用负 margin（-6px）吃掉折叠行
占位时，补偿值必须与容器实际 gap 同源——本次 gap 是 2px，-6 失配导致
展开时行与相邻卡重合。`max-height: 0→auto` 本身不可插值（auto 非动画值）。
结论：**行显隐用 display:none，可感知反馈只留 caret 旋转**——零 layout
残留，KISS；大列表逐行 height 动画性能差且嘈杂，业界树形控件通行走
"caret 旋转 + 瞬时显隐"。

**reduced-motion**：`@media (prefers-reduced-motion: reduce)` 里给
`.trellis-split-caret` / `.trellis-split-group-toggle` / `.trellis-split-row`
写 `transition: none` 即可（旋转仍以最终态瞬时生效）。

## 设计 token 只收敛"同形异值"，不借机改值域（apple-design P1 教训）

border-radius/token 迁移时按**现状值域分档**（3/4/5→xs、6/7→s、8→m、12→l、18→xl），
而不是按理想值重新设计（初稿 -s=6/-m=10/-l=14 会一次性改变全应用观感）。
机械替换保留特例：`50%`/`999px`（圆）、复合值（多角）、`var()` 引用不碰。
每次批量替换后用 Counter 验证分布，防止误伤。

## 按钮的 in-flight 状态是模块级标志，重建时读状态而非重置（09-27 check 发现）

长时间操作（`npm install -g`、扫描、批量升级）期间必须禁用触发按钮，否则用户会重复
点击并产生并发操作。本仓既有约定（`settings-tab-trellis.js` 的 `scanning` /
`batchRunning`）：

```js
let scanning = false;              // 模块级，不是挂在 DOM 上的一次性状态
function runScan() { scanning = true; requestRender(); ... }

// 渲染时 **读** 标志决定按钮状态
helpers.buildButton({ label: t("trellisRefresh"), disabled: scanning, ... });
```

**陷阱**：把「重建时重置标志」当成清理手段。重建可能发生在操作**进行中**
（例如用户点 refresh），重置会让按钮**恢复可点**，重新打开并发窗口。

```js
// ❌ 重建时无条件重置 —— 升级进行中一次 refresh 就能再次触发安装
globalUpgradeButton = upgradeButton;
globalUpgradePending = false;

// ✅ 重建时按标志渲染
globalUpgradeButton = upgradeButton;
if (globalUpgradePending) {
  helpers.setButtonState(upgradeButton, { disabled: true, label: t("trellisStatusRunning") });
}
```

**规则**：in-flight 标志的生命周期由**操作本身**负责（成功/失败/异常三条路径都要清除），
**不由渲染路径清除**。测试要点：操作进行中触发一次重建，按钮必须仍为禁用 ——
只测「点击后禁用」会漏掉这条。

## vm 测试沙箱还有：没有 insertBefore / prepend（09-25 追加）

dashboard 渲染层的 node:test 用 `vm.runInNewContext` + 极简 DOM stub，除了没有 timer，
**也没有 `insertBefore` / `prepend`**。需要"插在最前"时，改用 append 顺序：
先 append 首元素再 append 其余，或构建时就把顺序排好，别在事后前插。

**09-25 补充（折叠可测性）**：`test/dashboard-trellis-panel.test.js` 的 FakeElement 已补上
`parentNode`（appendChild/replaceChildren 时设置，非枚举属性防循环）与
`querySelector`/`querySelectorAll`（仅支持 `.class` / `.class[attr]` /
`.class[attr="v"]` + 后代组合器），这样折叠的局部路径与键盘导航才真正被测到
（之前 `trellisViewEl.querySelectorAll` 不存在 → 静默走回退重建，测试与真机"一致地都错"）。
仍然没有：`insertBefore` / `prepend` / `replaceWith`（所以 selected-only 快速路径在沙箱里
依旧不可用）/ 真 timer / `matchMedia` / `CSS.escape` / `localStorage` —— 这些仍必须惰性探测。
注意：沙箱的 `children` 是**数组**，所以 `Array.isArray(children)` 的写法在沙箱里也能通过；
要守住 HTMLCollection 真机形态，必须用类 HTMLCollection 的 stub 直测纯函数，不能只靠沙箱。

```js
// ❌ chipsRow.insertBefore(refreshBtn, chipsRow.firstChild); // vm DOM 无此方法
// ✅ 构建 chips 时先 appendChild(refreshBtn) 再 append 其余 chip
```

## 合并多 root 的列表，选中身份必须是 (id, cwd) 二元组（09-25 bug）

「全部项目」模式把多个 root 的任务合进一个列表，同名 taskPath（如两个仓库
各有一个 bootstrap-guidelines）会同时命中。凡是「选中高亮 / 键盘导航 /
map 缓存」，键一律用 `trellisTaskKey(path, cwd)`；只按 path 匹配会全高亮、
跳错行。新增同类列表时先问：这个 id 跨项目唯一吗？不唯一就带 scope。

## trellis 平台安装的三个隐藏契约（09-25 向导踩坑）

1. **`trellis init` 必须带 `-u <名字>`**：无 `-u` 时 CLI 直接失败退出
（Settings 安装向导曾报"安装失败"）。默认名 = 项目文件夹 basename；
argv 形态冻结为 `[init, -u, <name>, --<platform>…, -y]`。
2. **CLI 0.7.0-beta.4 起 `.template-hashes.json` 不再记录平台文件**：
只 parse hashes 会把装好的平台报成 0 个。平台读取必须走并集证据
`platformsOfUnion(hashes, path)`（hashes 记录 ∨ 配置目录存在）；
stale 语义不变（hashes 记录 ∧ 目录缺失）。
3. **未安装项目的首装不能过 `isTrellisProject` 门禁**：首装命令就是
`trellis init`，装完才有 .trellis 目录；IPC 通道对 init 类命令只做
平台白名单校验，不做项目存在性校验。

## Trellis 列表卡片族契约（09-25 R7 定型）

左栏 split view 与会话内 trellis 面板共用**同一卡片族**，改其中一处 UI
必须同步核对另一处：

| 层级 | 左栏 | 会话内 |
|---|---|---|
| 卡（border+surface+shadow-1+radius-m+6px 内边距） | `.trellis-split-phase-card` | `.trellis-phase-rows` |
| 卡头（13px/600 muted + 裸 caret + 右侧 count pill，hover tint） | `.trellis-split-group-head` | `.trellis-phase-section` |
| 行（**无自边框**、hover tint、accent 选中条、radius-s） | `.trellis-split-row` | `.trellis-task-row` |

### 折叠只藏行，不藏卡

```js
// ❌ wrap.hidden = collapsed; // 头也在 wrap 里 → 折叠后无法再展开；还踩 [hidden] 陷阱
// ✅ 卡与卡头始终构建；行也始终 append（行常驻 mount），折叠只翻行上的
//    显隐 class —— 键盘导航的 tasksByPath 照常填充
```

**行常驻是 09-25 的最终形态**（更早的"折叠时跳过行 append"已废弃）：行必须留在
DOM 里，CSS transition 才有存活元素可插值。行不在 DOM 的旧形态只适用于
整卡 `continue` 跳过（空组），不适用于折叠。

空组（空 done/finish 归档）直接 `continue` 跳过整卡，不渲染空占位。

### sticky 头进卡后背景必须换成卡面色

月份/分组头从「贴列表流」搬进卡片后，旧的列表混色背景
（`color-mix(surface, bg)`）会在卡内透出一条异色带——改用 `var(--surface)`。
同理，点击目标要 flex-fill 整行（`flex: 1 1 auto`），不能只命中文字。

### localStorage 同样要 typeof 守卫

与 timer 同理，vm 沙箱无 `localStorage`：持久化宽度等偏好前先
`typeof localStorage !== "undefined"`，读回时验证范围，非法值回退 CSS 默认。
