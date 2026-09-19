# 技术设计 — Trellis 流程感知（HUD 阶段徽标 + 桌宠跃迁动画）

## 1. 架构总览

```
.trellis/ 磁盘真相（只读）
  ├─ .runtime/sessions/<platform>_<sanitized-id>.json   ← 会话→任务绑定指针
  ├─ tasks/<task>/task.json                              ← status / subtasks
  └─ tasks/<task>/{prd,design,implement}.md              ← 产物存在性 → 阶段细分
        │  fs 只读轮询（5s，自调度 setTimeout）
        ▼
src/trellis-activity.js        ← 唯一 owner：对齐、缓存、跃迁检测、广播触发
  ├─ src/trellis-phase.js      ← 纯函数：sanitize/别名/阶段推导/进度（零 IO，可单测）
  ▼
state-session-snapshot.js      ← entry 新增 trellis 字段（经注入的 resolver 读缓存）
        ▼
session-hud.js sendSnapshot()  ← 复用既有广播（含 hudShow*/hudPinned 合并）
        ▼
session-hud-renderer.js        ← 行内阶段徽标 + 点击跳任务会话

跃迁检测（trellis-activity 内部）→ 一次性状态动画（复用状态机 proven 路径）
```

分层理由与上一任务一致：`trellis-phase` 纯逻辑可注入 fake 单测；`trellis-activity` 独占状态（缓存/轮询/跃迁史），避免散落；snapshot 与 HUD 走既有契约，不新增 IPC 通道。

## 2. 已验证的外部事实（设计依据）

| 事实 | 值 / 位置 |
| --- | --- |
| 绑定指针文件名 | `<platform>_<sanitized-session-id>.json`（`active_task.py` `_context_key`） |
| sanitize 规则 | `re.sub(r"[^A-Za-z0-9._-]+","_",v).strip("._-")[:160]`（`_sanitize_key`） |
| 指针内容 | `{ platform, last_seen_at, current_task, current_run }`（实测本仓库） |
| platform 别名表 | `active_task.py` `_CONTEXT_KEY_PLATFORM_ALIASES`（Node 版需复刻，逐条核对） |
| 阶段真相 | 无落盘字段；由 status × 产物存在性 × 归档推导（`workflow_phase.py` 同源逻辑） |
| snapshot 广播 | `session-hud.js` `sendSnapshot()` L617，通道 `session-hud:session-snapshot` L620 |
| snapshot 注入先例 | `buildSessionSnapshot` L343-471，参照 `model` L395 / `contextUsage` L399 的透传写法 |
| HUD 渲染 | `session-hud-renderer.js` `render()` L453 全量重建（createElement，无 innerHTML） |
| 一次性动画先例 | `jumping-once` 模式：主进程下发一次性状态 → renderer 换装链（swapToken 竞态防护）→ SVG 自播 → 回落 idle |
| watcher 先例 | `claude-settings-watcher.js`：目录 watch + 1000ms 防抖 + lifecycleToken 守卫 + 自调度 setTimeout（非 setInterval） |
| 庆祝资产 | `clawd-react-double-jump.svg` / `clawd-working-juggling.svg` / accessories `party-hat` `wizard-hat` 均已存在 |

## 3. 关键设计决策

### D1 会话对齐（Q1 定案）

对每个 live session（`agentId` + `sessionId` + `cwd`）：

1. 从 `cwd` 向上找 `.trellis/` 目录（最多 8 层，找不到即放弃该会话）。
2. 复刻别名表把 Clawd `agentId` 映射为 trellis platform 名（如 `claude-code`→`claude`、`codex`→`codex`、`pi`→`pi`；逐条从 `active_task.py` 抄，不类比推断——该表自带"每个名字都实测过"的审计注释）。
3. 构造精确 key `<platform>_<sanitize(sessionId)>`，读 `.runtime/sessions/<key>.json`。
4. **退化匹配**：精确 key 缺失时，若该目录下 `platform` 字段匹配的文件**恰好一个**且 `last_seen_at` 距今 < 30min，采用之；多个则放弃（保守，不错误归属）。
5. 指针不可读 / `current_task` 为空 / 任务目录不存在 → 该会话 trellis 信息为 `null`（HUD 不显示，不报错）。

Clawd 侧 sessionId 形态差异（如 codex 的 uuid、pi 的 uuid、claude 的 session id）在 implement 第 0 步用真实会话逐 agent 抽查核对；**别名表 + sanitize 的 Node 复刻必须有对照测试**（同一输入在 Python 与 Node 产出同一 key——用本仓库真实指针文件名做 fixture）。

### D2 阶段推导（Q2 定案）

`trellis-phase.js` 纯函数 `derivePhase(taskDir, taskJson, isArchived)`：

| 条件（按序） | 徽标 |
| --- | --- |
| 任务目录已移入 `archive/` | `done` |
| `status === "completed"` | `finish`（待 finish-work 归档） |
| `status === "in_progress"` | `execute` |
| `status === "planning"` + 无 prd.md | `plan`（0.x 刚建） |
| `status === "planning"` + 有 prd 无 design/implement | `plan` |
| 其他/未知 status | `null`（不显示） |

进度 `deriveProgress(taskJson)`：`subtasks[].status` 完成计数（`n/m`）；无 subtasks → `null`（不显示百分比，**绝不显示 0/0**）。不解析 implement.md checkbox（易碎，已否决）。

### D3 刷新机制（Q3 定案）：有界轮询，不用 fs.watch

- 自调度 `setTimeout` 链（照 `claude-settings-watcher` L286-299 模式，**禁止 setInterval**），周期 5000ms，lifecycleToken 守卫启停。
- **门控**：每轮先取当前 live session 列表，过滤出 cwd 可定位 `.trellis` 根的会话；空集时本轮零 IO 并把周期退避到 15s（有会话恢复后回到 5s）。
- 每轮 IO 上界：每会话读 1 个指针 json + 每变更任务读 1 个 task.json + 有界 stat 产物文件（≤3 个 existsCheck）。轮询不写任何文件。
- 否决 fs.watch 的理由：watcher 生命周期需随会话增删动态绑定多根，Windows 目录级 watch 对 `.runtime/sessions/` 的原子替换行为需逐一验证；轮询读几个小文件的开销可忽略，AC 只要求"无需重启更新"，5s 足够。

### D4 snapshot 注入与广播触发

- `buildSessionSnapshot` 的 `options` 新增 `trellisResolver: (sessionId) => TrellisInfo | null`；entry 新增 `trellis` 字段透传（照 `contextUsage` L399 写法）。state.js 不持有 trellis 概念。
- `trellis-activity` 缓存变更（diff 非空）后回调注入的 `onTrellisUpdate` → main.js 既有"重建 snapshot → 更新 latestSnapshot → `sendSnapshot()`"路径。**不绕开 sendSnapshot 直接 webContents.send**（会丢 hudShow*/hudPinned 合并）。
- 消费者核查（改字段必查清单）：HUD renderer（新增消费）、quota-ring（不读 sessions 细节）、Dashboard（透传展示，可选消费）、Telegram direct-send（不读新字段）。新增字段对旧消费者是多余键，向后兼容。

### D5 跃迁动画（Q4 定案：复用现有资产与一次性状态机制）

- 跃迁史：`Map<taskPath, lastPhase>`。检测到 `lastPhase → newPhase` 属于以下跃迁才触发：
  - 任意 → `execute`：不额外播动画（working 状态动画本就会切，天然提示）
  - 任意 → `finish` / `done`：播一次性庆祝（`jumping-once` 类既有一次性状态；主题无该资产则静默跳过）
- 触发路径复用状态机一次性状态（jumping-once 的 proven 链路：下发一次性状态 → swapToFile → SVG 自播 → 回落）。**不改 REQUIRED_STATES**；`mini-clip` 通道疑似 mini-mode 专用，implement 第 0 步确认后决定是否改用它（若通用则更轻）。
- **抖动抑制**：同 taskPath 两次触发间隔 < 10s 不重播；DND / petHidden 时不播（沿既有全局门槛）。
- **配件（R3 阶段化身）降级为 P2**：配件目前是用户手选常驻机制，自动佩戴需先解决"与用户手选冲突"的规则。v1 只做动画；配件叠加若 implement 阶段确认 accessories 挂载支持非冲突叠加再补（独立小 PR 粒度）。
- **杂耍（R3.1）降级为 P2**：working 状态下按并行任务数切换动画需在 renderer 换装链加 visualHint 耦合。v1 先在 HUD 显示并行任务计数；`working-juggling` 作为可选状态能力的接入留待确认 renderer 侧侵入面后单独做。

### D6 Settings 联动（R5）

`settings-tab-trellis.js` 项目行摘要：`trellis-activity` 暴露 `getByProject(projectPath)`，tab 刷新时（用户点刷新/scan 返回后）读一次缓存追加渲染。零新 IPC。

### D7 只读红线

- `trellis-activity` / `trellis-phase` 全部 `fs.readFile` / `fs.stat` / `fs.readdir`，**零写、零 spawn、零网络**。
- 回归测试：整轮轮询前后 `.trellis/` 树 `shasum` + mtime 不变。

## 4. 新增 / 修改清单

### 新增

| 文件 | 职责 |
| --- | --- |
| `src/trellis-phase.js` | 纯函数：sanitize 复刻、platform 别名表、derivePhase、deriveProgress |
| `src/trellis-activity.js` | owner：轮询门控、会话对齐、缓存、跃迁检测、onTrellisUpdate 触发 |
| `test/trellis-phase.test.js` | 对照 Python 真实 key 的 sanitize/别名测试、阶段表全分支、进度边界 |
| `test/trellis-activity.test.js` | 注入 fake fs/timer：门控退避、退化匹配、跃迁触发与抑制、只读断言 |

### 修改

| 文件 | 改动 |
| --- | --- |
| `src/state-session-snapshot.js` | options 加 `trellisResolver`；entry 加 `trellis` 字段（照 contextUsage 写法） |
| `src/main.js` | 组装 trellis-activity（lifecycle、ctx 注入、onTrellisUpdate → snapshot 重发） |
| `src/session-hud-renderer.js` | 行内阶段徽标 + n/m 进度 + 点击徽标走既有 focus 路径；i18n |
| `src/session-hud*.js`（如文案字典在此） | 阶段徽标文案 7 语言 |
| `src/settings-tab-trellis.js` | R5 项目行"活跃任务+阶段"摘要 |

（跃迁动画若走一次性状态，还需在状态机侧加受控入口——implement 第 0 步定精确落点后更新本表。）

## 5. 数据形状

```js
// TrellisInfo（snapshot entry.trellis，null = 无）
{
  taskPath: ".trellis/tasks/09-19-x",   // 相对项目根
  title: "Trellis 流程感知…",            // task.json title
  phase: "plan" | "execute" | "finish" | "done",
  progress: { done: 2, total: 5 } | null,
  parallelCount: 3,                      // 同 .trellis 根下 in_progress 任务总数
}
```

## 6. 错误与降级

| 场景 | 行为 |
| --- | --- |
| 无 `.trellis` 根 / 指针缺失 / json 损坏 | 该会话 `trellis: null`，HUD 行正常渲染 |
| 任务目录被移动/归档中 | 指针悬空 → `null`；下一轮归档位检测恢复为 `done` |
| 轮询 IO 异常 | 吞掉计日志，下轮重试；连续失败不放大周期（文件小，无风险） |
| 多指针歧义（退化匹配命中多个） | 放弃该会话的 trellis 信息 |
| 主题缺庆祝资产 | 跃迁不播动画，仅徽标变化 |

## 7. 回滚

删除 2 个新增 src 文件 + 2 个测试文件，还原 5 处修改接线即完整回滚；snapshot 的 `trellis` 字段对旧消费者是多余键，无持久化残余。

## 8. 未决（implement 第 0 步确认）

- **A**：`mini-clip` 通道是否 mini-mode 专用（决定跃迁动画走它还是一次性状态）。
- **B**：HUD 渲染层 i18n 字典的确切位置与注入方式（`sendI18n` L630 已有，文案表在哪定义）。
- **C**：逐 agent 抽查 sessionId 形态与 sanitize 后 key 的实际匹配（claude/codex/pi 至少三个真机会话）。
- **D**：跃迁动画在状态机侧的精确入口（若不走 mini-clip）。
