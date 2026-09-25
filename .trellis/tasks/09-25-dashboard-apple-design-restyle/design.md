# Dashboard apple-design 重构 — 技术设计

## 0. 现状事实（研究结论，含行号）

| 事实 | 位置 | 对设计的影响 |
|---|---|---|
| 单 `<style>` 块 ~71K CSS，按迭代追加 | `src/dashboard.html` L7–3149 | 分节重写而非整块替换，保 git diff 可审 |
| 4 个 `:root`（亮/暗 + trellis 局部） | L10–28 / L30–46 / L241–247 | 收敛为亮暗两套，trellis 局部 token 保留但引用新 scale |
| `border-radius` 硬编码 ~76 处、shadow 散落 | 全文件 | token 化 `--radius-{s,m,l,xl}` / `--shadow-{1,2,3}` |
| 全量 DOM 重建每 1s/snapshot | `dashboard-renderer.js` `render()` L4730–4794 | **列表条目不能每次渲染重播入场动画**；入场只限「新增/首次」，复用 `is-entering` + `entryPending` 模式（trellis view L2053/L2879 已有先例） |
| **实测更正（2026-09-25）**：`prefers-reduced-motion` 已有 3 处（L982/L1760/L1955）；overlay enter/exit 对称已存在（`trellis-card-pop-in/out` + `trellis-overlay-fade-in/out` L938–977）；`is-entering` 已覆盖 trellis split 节（L1731–1762），session 列表卡片无入场；`backdrop-filter` 0 处；`color-mix` 43 处（Electron 支持已验证）；`prefers-reduced-transparency` 0 处 | grep 实测 | P2 材质是真空白；P3 从「新建动效」收缩为「token 收敛 + 补 session 卡入场 + 统一 reduced-motion 块」 |
| 现有动效全是 CSS class + 固定 setTimeout | `animateTrellisOverlayClose` L2990–3007（140ms） | 不引入 JS 弹簧/插值引擎；动效纯 CSS，JS 只负责 class 布防/清理（与现有模式一致） |
| stagger 机制已有 CSS 变量先例 | `--split-group-index` L2162/L2193 | 复用该模式扩展到 session 卡片 |
| scrollGuard 已有滚动恢复 | renderer L133–258 | 动效不得触发滚动跳变；`scroll-behavior` 保持默认 |
| rAF 仅 1 处（alias focus） | L3889 | 无 rAF 动画循环，维持 |
| quick mode：主进程两段握手 + revision 栅栏 + opacity parking | `dashboard-quick-mode.js` | CSS 不触碰 opacity parking 与数字映射 DOM 结构 |
| 宿主差异：darwin/win32 BaseWindow+WebContentsView（无 ready-to-show）；Linux BrowserWindow | `dashboard-host.js` | 不依赖 `ready-to-show` 做入场时机；入场动画用 CSS animation 自动播放 |
| static guards 测试锚定类名/结构 | `test/dashboard-*.test.js` | 改名必须同步测试与 renderer 选择器；优先不改既有类名，仅新增 |
| [hidden] cascade 陷阱 / author display 优先 | spec renderer-guidelines、trellis-panel-contract §8c | 新 CSS 不得用 display 覆盖 [hidden]；删除样式走 author display |
| quick mode freeze | 数字映射冻结依赖 DOM | 不改列表行内结构 |

## 1. Token 体系（单一真相）

亮暗两套 `:root` + `@media (prefers-color-scheme: dark)`，在现有亮色根（L10）原位扩展：

```css
/* 层级与形状（贴现状值域：3/4/5px→xs，6/7px→s，8px→m，12px→l） */
--radius-xs: 4px;  /* 极小元素/badge 内件 */
--radius-s: 6px;   /* badge/小控件 */
--radius-m: 8px;   /* 输入、行内元素（现状最大项） */
--radius-l: 12px;  /* 卡片 */
--radius-xl: 18px; /* 浮层/overlay */

/* 阴影按表面尺寸分级（大面更深） */
--shadow-1: 0 1px 2px rgba(0,0,0,.05);                          /* chip */
--shadow-2: 0 2px 8px rgba(0,0,0,.07), 0 1px 2px rgba(0,0,0,.04);  /* 卡片 */
--shadow-3: 0 12px 32px rgba(0,0,0,.14), 0 2px 6px rgba(0,0,0,.06); /* overlay */
（dark 下降低透明度、提高底色不透明度补偿）

/* 材质 */
--material-bar: saturate(180%) blur(20px);
--bar-bg: rgba(255,255,255,.6);  /* dark: rgba(28,28,31,.62) */

/* 动效 scale */
--ease-out-apple: cubic-bezier(0.32, 0.72, 0, 1);        /* 临界阻尼近似 */
--ease-spring: cubic-bezier(0.34, 1.3, 0.64, 1);         /* 轻回弹，仅 momentum 场景 */
--dur-1: 120ms;  /* press/即时反馈 */
--dur-2: 180ms;  /* hover/展开 */
--dur-3: 240ms;  /* 卡片/浮层 enter-exit */
--dur-4: 320ms;  /* 大面积重排 */

/* 间距（收敛现有 magic number 到 4 的倍数） */
--space-1..5: 4/8/12/16/24px
```

迁移规则：新 token 就位后**逐节替换硬编码**，git 每节一 commit 可回滚；不一次性 sed 全文件（避免误伤 vendor 前缀区）。

## 2. 材质与深度（apple-design §12）

- **顶栏 → 磨砂浮层**：`backdrop-filter: var(--material-bar)` + `--bar-bg` + 1px 亮顶边 `rgba(255,255,255,.4)`（dark 用暗顶边）；内容从其下方滚过。Dashboard 是不透明窗口，无 DWM 透明陷阱
- **卡片层级**：session 卡片 `--surface` + `--shadow-2`，取代现在的边框堆叠；组标题行贴滚动流（非浮层）不加阴影
- **状态色应用改为 tint 层**：badge 底色 `color-mix(in srgb, var(--running) 14%, transparent)` + 文字全饱和状态色；比现在的实底/描边更材质友好
- **overlay（trellis 文档浮层）**：`--radius-xl` + `--shadow-3` + scrim 渐进加深；enter/exit 动画 blur+scale 同步（材质"到场"感），reduced-motion 下退化为 cross-fade
- 禁止 light-on-light 叠层（spec：半透明浮层不叠半透明浮层）

## 3. 动效系统（apple-design §1/3/4/7 + 现有 JS 模式）

**原则：JS 只布防/清理 class，插值全交 CSS**（与 `animateTrellisOverlayClose` 既有模式一致，不新增动画引擎）。

| 场景 | 手法 | 值 |
|---|---|---|
| 按钮/行按压 | `:active` scale(.97)，pointer-down 即时 | `--dur-1` `--ease-out-apple` |
| hover 反馈 | 背景色 + shadow-1→2 | `--dur-2` |
| 卡片折叠/展开（fold） | 现有 maxHeight 机制保留，缓动换 `--ease-out-apple` `--dur-4`；grid-template-rows 方案因 [hidden] 陷阱风险**不改** | — |
| 列表新增卡片入场 | **session 列表卡片目前无入场**（is-entering 仅覆盖 trellis split 节）；为「新增会话卡」补 `is-entering`（首次 render 后比对 session id 集合新增者），淡入+上移 6px；**每秒重建不重播** | `--dur-3` |
| overlay enter/exit | **已对称存在**（pop-in/out + fade-in/out），仅将时长/缓动收敛到新 token | `--dur-3` |
| stagger | 复用 `--card-index` CSS 变量 + `animation-delay: calc(var(--card-index) * 24ms)`，上限 5 档 | 仅首屏 |
| momentum 回弹 | 只用于用户刚刚拖/滚/点过的场景（当前无拖拽，保留给 fold 展开与 quick mode 选中） | `--ease-spring` |
| reduced-motion | **已有 3 处局部块**（L982/L1760/L1955）→ 统一为覆盖全动效的块：slide/scale/blur → opacity cross-fade `--dur-2`；`scroll-behavior` 永不设 smooth | `@media` 一处统一 |

**新增 JS 面（renderer）**：仅一个 `noteEnteringSessions()`（记录上次 session id 集合，标记新增卡）≈ 15 行，挂在 `render()` 尾部；无 timer/rAF 循环。

## 4. 光学排版（apple-design §15）

- 窗口标题/组标题：600 weight，`letter-spacing: -0.01em`（13px 级）
- 大数字/空状态标题：若有 >20px 文案给 `-0.02em`
- 正文/行内：tracking 0，维持现有 13px UI 基线与系统字体栈（token `--font` 不动）
- 行高：标题 1.3、正文 1.45（现已接近，收敛为 var）
- 状态徽标等小字（11px）：`letter-spacing: .02em` + 500 weight（vibrancy 补偿）

## 5. 平台兼容矩阵

| 特性 | macOS | Windows | Linux | 风险 |
|---|---|---|---|---|
| backdrop-filter | ✅ | ✅ | ✅(Chromium) | 无 —— Dashboard 不透明窗口，非 pet 透明窗 |
| color-mix | ✅ Chromium 111+ | ✅ | ✅ | Electron ≥ 22 均含；确认 package.json electron 版本后定案 |
| @media prefers-* | ✅ | ✅ | ✅ | Windows 系统级 reduce 在 Chromium 生效 |
| overlay position fixed | ✅ | ✅ | ✅ | Linux BrowserWindow 宿主路径已有测试覆盖 |

回退：若 CI/electron 版本不满足 color-mix，tint 层降级为预计算 rgba 双套（亮/暗各写死）——设计上 tint 值集中在 badge 一节，可机械替换。

## 6. 分期与文件边界

| 期 | 内容 | 触碰文件 |
|---|---|---|
| P1 | token 层 + 排版 + 全文件硬编码迁移 | `dashboard.html`（style 前段） |
| P2 | 材质：顶栏磨砂、卡片阴影、tint badge、overlay | `dashboard.html` |
| P3 | 动效系统 + reduced-motion + `noteEnteringSessions()` | `dashboard.html` + `dashboard-renderer.js`（仅 render 尾部 ~15 行） |
| P4 | quick mode 视觉对齐（不动结构）+ 三平台验证 + spec 沉淀 | 只读验证为主 |

**不触碰**：`dashboard-quick-mode.js`、`dashboard-host.js`、`dashboard.js`、preload、IPC、`test/`（若类名零新增冲突则测试零改）。

## 7. 测试与验证

- `npm test`：static guards（[hidden] cascade、wireTrellisDocCollapse、类名匹配）每期必跑
- 新增静态 guard（P3 一并加）：`prefers-reduced-motion` 存在于 dashboard.html；`backdrop-filter` 仅用于 bar/overlay 类白名单
- 手动：macOS 本机全流程（含 quick mode 往返）；Windows/Linux 截图对比 + code-review-first 说明（环境为 macOS-first 开发机，与 AGENTS Testing 约定一致——注意 AGENTS 写 Windows-first，以当前实际环境为准记录）

## 8. 回滚

每期独立 commit；P1–P2 纯 CSS 可整体 revert；P3 的 renderer 增量单独 commit，revert 后 CSS 动效退化为无入场（无功能损失）。
