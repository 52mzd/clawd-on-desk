# Design — 任务气泡 + 下一步引导

## D1 模块分层（KISS：3 处改动，2 个新文件）

```
src/trellis-phase.js        +deriveNextStepHint()   纯函数（R2 规则表，单一事实源）
src/trellis-bubble.js       新                      气泡窗口生命周期 + 触发判定
src/session-hud-renderer.js +title tooltip          R3
src/i18n.js                 +21 key（7 语言 × 3 档）
src/main.js                 接线（idle 信号 + onTrellisUpdate → maybeShow）
```

不复用 update-bubble.js 的工厂体量（772 行含 IPC/下载语义）；只复用其定位纯函数。

## D2 引导规则表：`deriveNextStepHint(trellisInfo)` → `{ key, params? } | null`

放 `trellis-phase.js`（phase 的下游映射，纯函数可独立表驱动测试）：

| derivePhase(info) | 返回 | i18n key |
|---|---|---|
| `plan` | `{key:'trellisHintPlan'}` | "Plan ready — start the task to execute" |
| `execute` | `{key:'trellisHintExecute', params:{done,total}}` | "Executing {done}/{total} steps" |
| `finish` | `{key:'trellisHintFinish'}` | "Looks done — archive to wrap up" |
| `done` / null / 无绑定 | `null` | —（归档已由庆祝动画覆盖） |

params 插值沿用 i18n.js 现有占位符替换约定（与 recap/permission 文案同机制）。HUD tooltip 文案 = `任务名 — 引导行`（气泡同源）。

## D3 气泡窗口（单例复用）

- `createTrellisBubble({ getPetState, getDnd, getPetHidden, getMiniMode, getWorkArea, getAvoidRects, getHudRect, i18n, timers… })` — 全依赖注入（与 trellis-celebration 同模式，单测无需 Electron）
- BrowserWindow 参数对齐 update-bubble：transparent / frameless / skipTaskbar / non-activating；内容静态 HTML + `webContents.executeJavaScript` 设文本（不重载页面）
- 单例：首次 show 时创建，之后 show/hide 复用；app quit / before-quit 销毁

## D4 定位与避让

复用 update-bubble.js 的定位纯函数（`findNearestY` / `normalizeAvoidRects`；若未导出则追加 export，不改函数体）。输入对齐既有消费者：

- `avoidRects`：permission stack 各 bubble bounds + Session HUD bounds（与 update-bubble 重排时的来源一致）
- `permissionStackOffset`：permission stack 保留高度
- 方向：默认桌宠上方，放不下（越 workArea）时下移

permission bubble 增删 / HUD 显示变化时重排：气泡存活期间监听与 update-bubble 相同的重排触发点（permission.js 的 stack mutation 回调 + HUD geometry 更新回调），直接调用同一 `relayout()`。

## D5 触发链与门槛（main.js）

`maybeShowTrellisBubble()` 由两个事件驱动：
1. pet state 切到 `idle`（state.js 既有 onState 通知路径）
2. trellis-activity 的 `onTrellisUpdate`（绑定建立/变化时若恰处 idle）

门槛短路顺序（全部注入 getter，无直接 require）：DND → petHidden → mini → `getPetState() !== 'idle'` → 当前绑定任务的 `deriveNextStepHint() === null` → 会话级去重表 `Set<taskDir>` 已含 → show。

去重表：`Set`（abs task dir），Clawd 会话生命周期，不落盘。任务归档后绑定消失，不涉及重置。

## D6 消失路径

- 自动：show 后 `setTimeout(hide, 4000)`（注入 timer，测试可驱动）
- 点击桌宠：tick.js 既有 click 通道回调 → hide（气泡本身不可点，non-focusable）
- 门槛翻转（DND 开启 / 进 mini / petHidden）：getter 轮询到即 hide；为免加轮询，挂在 DND/mini 切换的既有事件回调上（与庆祝动画同挂点）

## D7 HUD tooltip（R3）

`session-hud-renderer.js` 的 chip 构建处追加 `el.title = taskTitle + ' — ' + hint`；hint 为 null 时 title 只显示任务名。i18n 访问沿 renderer 既有 `t()`。零布局/零样式改动。

## D8 明确不做

- 不用系统 Notification（跨平台一致性 + Windows 通知中心堆积）
- 不做气泡内按钮/动作（引导是提示，不是执行器）
- 不做周期性提醒（去重表一次性语义）

## D9 风险与对策

| 风险 | 对策 |
|---|---|
| Linux 透明窗口兼容 | 窗口参数完全对齐 update-bubble（其在三平台已验证），不引入新参数 |
| idle 抖动（working↔idle 快速切换）反复触发 | 去重表天然抑制（同任务一次）；不额外 debounce |
| 气泡与庆祝动画同帧 | 气泡只在 idle 弹、庆祝在 finish/done 跃迁（非 idle 场景）——时序上互斥；若仍撞，气泡延迟 1s 后再判（实现时观察） |
| execute 进度文案与 HUD 徽标重复 | 接受（气泡瞬态、tooltip 常驻，用户偏好不同通道） |

## D10 测试面

- `test/trellis-phase.test.js`：deriveNextStepHint 表驱动（plan/execute+params/finish/done/null 输入）
- `test/trellis-bubble.test.js`（新）：门槛短路序、去重一次、4s 自动消失（fake timer）、hide 幂等、relayout 被重排触发点调用
- `test/i18n.test.js`：parity 自动覆盖新 21 key（既有扫描型测试）
- `test/session-hud-renderer` 行为测试：chip.title 含任务名与引导文案；hint null 时仅任务名
