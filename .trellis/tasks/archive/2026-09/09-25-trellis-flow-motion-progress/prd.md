# Trellis 流程动画与进度显示排查

## 背景（brainstorm 研究结论，2026-09-25）

### A. 动画：折叠类动效全数失效

行为表（行号属 src/dashboard-renderer.js / dashboard.html）：

| 交互 | 现状（修复前） | 期望 |
|---|---|---|
| phase 卡折叠 | 改 collapsedPhases → 整树 replaceChildren 重建 | caret 旋转过渡 + 行瞬时显隐 |
| 月份头折叠 | 同上 | 同上 |
| 子树折叠 | 同上 | 同上 |
| 选中行 | 局部 classList 路径（renderTrellisSplitSelectionOnly） | ✅ 已有动画，作为参照实现 |
| 入场 is-entering/is-first-frame | 一次性 class + animation | ✅ 正常 |

根因：折叠=整树重建，新元素生来终态，CSS transition 无 from→to。选中路径证明局部更新可行。

### B. 进度 0/11：链路已验证是通的

sessions/<id>.json → readTaskInfo（implement.md checkbox 计数，无则 prd.md 兜底）→ trellisInfoEqual（含 progress 比较，L~940）→ 变化推送 snapshot → renderer。

0/11 不变 = **checkbox 无人勾选**（执行 agent 不维护 implement.md），显示即文件真相。wallpaper 10/47 已证明 checkbox→进度链路在工作。

## 需求

- R1 折叠动画修复：折叠走**局部 DOM**——行常驻 mount + class 记账，caret 局部 toggle；
  参照既有 renderTrellisSplitSelectionOnly 模式
  - **动效范围（用户拍板）**：只保留 **caret 旋转过渡**（transform rotate）+ **行瞬时显隐
    （display:none）**，**不做行的 height/max-height 收纳动画**。
    理由：这是可达数百行的树形列表，逐行 height/`grid-template-rows` 动画性能差且视觉
    嘈杂；caret 旋转 + 瞬时显隐是业界树形控件（VS Code / GitHub / macOS Finder）通行做法，
    也与本仓"合成友好属性"约束一致。
- R2 进度：**搁置观察**（用户确认 0/11 已自然结束；wallpaper 10/47 证明 checkbox→进度链路
  在工作，无需改动）
- R3 reduced-motion：折叠动画在 prefers-reduced-motion 下退化为直接显隐
  （`@media (prefers-reduced-motion: reduce)` 已覆盖 `.trellis-split-caret` /
  `.trellis-split-group-toggle` / `.trellis-split-row` 的 transition → caret 瞬时到位）

## 本轮审查发现与修复（2026-09-25 第二轮，独立审查推翻 acb422fb）

第一版实现（acb422fb）在**真机上从未生效**。审查给出下列确凿问题，全部已修：

| # | 问题 | 修复要点 |
|---|---|---|
| 阻塞 1 | 子树折叠在真机 100% 落进整树重建回退：`Element.children` 是 `HTMLCollection`，`Array.isArray()` 恒 false 且无 `indexOf` | 探测条件改为 `if (parent && parent.children)`，归一化下沉到纯函数 `applySubtreeFold()` 内部用 `Array.from()`；保留“无 parentNode 时回退重建”分支（沙箱） |
| 阻塞 2 | 折叠 class 记账三套各写各的：`is-folded` 挂在行上无任何 CSS 消费者；caret 旋转锚点 `.trellis-split-row.is-collapsed` 零命中；`expand-all` 不清 row.is-collapsed、`collapse-all` 不给 row 加 | 明确两个职责分离的类：**行显隐** `is-subtree-folded` / `is-month-folded`（行）、`is-folded`（card）；**caret 旋转** `is-collapsed`（row / head / toggle）。点击、重建、expand-all、collapse-all 四处写入同一套类；删除死类 `row.is-folded`、`caret.is-collapsed` |
| 阻塞 3 | 行常驻后键盘导航会选中不可见行（`moveTrellisSplitSelection` / `findTrellisSelectedRow` / `renderTrellisSplitSelectionOnly` / Enter 全量枚举） | 新增 `isTrellisRowVisible()`（三类折叠形态全覆盖，含 phase 卡祖先链），四处枚举统一过滤；导航注释更新 |
| 阻塞 4 | archive 分支折叠后子行"复活"：`renderSubtree(..., true, ...)` 常量第 4 参 | 恢复为 `!collapsedPaths.has(rootMeta.task.taskPath)`，与 active 分支同语义 |
| 清理 5 | `pendingPhaseReveal` 死代码（无写入者） | 删除变量残留读取块；reveal 语义已由 `renderTrellisView` 的 scrollTop 保存/恢复 + 局部折叠覆盖 |
| 清理 6 | `dashboardTrellisActiveEmpty` / `dashboardTrellisArchivedEmpty` 共 14 个死 i18n 键 | 整行锚定删除 14 行 + 测试残留断言，全仓零引用 |
| 清理 7 | `dashboard.html` 重复的 `.trellis-split-row{transition:…}` | 删除新增的那一处（DRY） |
| 追加 | 局部折叠后结构签名漂移 → 1s tick 误判为“新数据”整树重建，把局部路径的成果冲掉 | 局部折叠/展开成功后 `syncTrellisViewSignature()`（5 处：caret 点击 / month / phase 卡 / expand-all / collapse-all）；重建只在数据变化时发生（A1 要求）。注：phase 卡那处因 `collapsedPhases` 不在签名输入内，当前是无害 no-op，保留作前瞑性防御 |
| 测试 | 折叠断言“两条路径都绿”的假阳性；沙箱缺 `parentNode` / `querySelector(All)` 导致导航路径不可测 | 加 DOM 节点复用断言 + HTMLCollection 形状纯函数直测 + 键盘导航落地行断言 + 1s tick 后仍复用断言；沙箱补最小 DOM 能力 |
| 测试（收尾加固） | 上一轮真实的失效点在**点击路径的探测条件**，而沙箱 `children` 是数组、改回 `Array.isArray` 全套测试依然全绿；静态守卫用 `src.includes()` 也无法阻止行级死类复活 | `keeps the fold classes wired on both sides` 补两条机器可判定断言：禁止 `Array.isArray(…children)` 形态（真机形态无自动化守卫的缺口）、禁止 `row`/`caret` 上的 `is-folded` 写入。两条均经逆向验证（注入即红） |

## 非目标

- 不改 trellis CLI / 轮询架构 / IPC
- 不引入 JS 动画引擎（保持 CSS class 记账模式）
- 不做行 height/max-height/grid-template-rows 收纳动画，不引入 wrapper 结构

## 验收标准

- A1 折叠/展开 caret 有旋转过渡、行瞬时显隐（display:none）；整树重建路径**仅在数据变化时**触发
  （局部折叠后 1s tick 不得重建；结构签名保持与实时 DOM 一致）
- A2 选中行动画不回归（`renderTrellisSplitSelectionOnly` 快速路径不受影响，且局部折叠后签名
  同步让它继续可用）；is-entering 不受影响
- A3 npm test 与存量基线一致（失败集合不新增）；折叠键盘导航/选中回归通过
- A4 不适用：R2 进度项搁置观察，本轮无进度显示行为变更，故无对应测试要求

## 证据与验证（本轮）

- 定向：`node --test test/dashboard-trellis-panel.test.js` 72/72 绿（原 67 + 新增 5）
- 反向验证（逐条制造回归，确认断言真的会红）：
  - caret 局部路径短路 → 节点复用断言红
  - `applySubtreeFold` 不归一化 HTMLCollection → HTMLCollection 形状测试红
  - `isTrellisRowVisible` 恒 true → 两个键盘导航测试红
  - archive `ancestorsExpanded` 退回常量 true → archive 复活测试红
  - expand/collapse-all 局部路径短路 → 节点复用/class 记账断言红
  - `syncTrellisViewSignature` 变 no-op → 1s tick 复用断言红
  - 注意：把探测条件换回 `Array.isArray` 在**沙箱里测不出来**（`FakeElement.children`
    是数组），只有 HTMLCollection 形状的 stub 才能守住 —— 这正是上一轮漏检的机制
- 真机（仓库自带 Electron 41 打开真实 `src/dashboard.html` + 真实 renderer，`/tmp/probe/`）：
  `children.constructor.name === "HTMLCollection"`、`Array.isArray(children) === false`、
  `typeof children.indexOf === "undefined"`；折叠后 row / caret / list 节点引用不变、
  `scrollTop` 保持 160、caret 计算样式 `matrix(0, -1, 1, 0, 0, 0)`（= rotate(-90deg)）、
  子行 `display: none`；1.3s 后（跨过 1s tick）节点仍复用；强制 `renderTrellisViewBody()`
  作为反向对照 → 三个节点全部换新（证明断言有区分力）
