---
name: trellis-panel-contract
description: Trellis 集成契约——外部进程 argv 冻结/信任门禁/输出解析身份，以及只读流程感知的会话绑定契约
paths:
  - src/trellis-*.js
  - src/settings-tab-trellis.js
  - src/session-key.js
  - src/state-session-snapshot.js
  - src/session-hud-renderer.js
  - src/dashboard-trellis-panel.js
  - test/trellis-*.test.js
  - test/settings-tab-trellis.test.js
  - test/session-key.test.js
  - test/dashboard-trellis-panel.test.js
---

# Trellis 面板的外部进程契约

## Scenario: 调用外部 CLI 并解析它的输出

### 1. Scope / Trigger

任何「Clawd 主进程 spawn 一个外部 CLI，并把结果呈现给用户」的代码都适用本条。

触发条件（满足任一即需按本 spec 深度实现）：

- 新增/修改 `src/trellis-*.js` 里的命令构造或输出解析
- 新增一个会 spawn 进程的 IPC 通道
- 让渲染层能影响被 spawn 命令的 argv

不适用：纯读盘扫描（`trellis-scanner.js` 的 fs 部分）——它不 spawn，按只读规则审即可。

### 2. Signatures

```js
// src/trellis-cli.js — 工厂，execFile 可注入
createTrellisCli({ execFileImpl?, env?, platform?, timeoutMs? })

// 每条命令一个函数，返回值统一带 ok / output
readGlobalVersion()                     // → { installed: boolean, version: string|null }
fetchRemoteChannels()                   // → { channels: {latest,beta,rc} } | { error }
updateProject(projectPath)              // → { ok, from, to, output }
addPlatforms(projectPath, platformIds)  // → { ok, added: string[], output }
upgradeGlobal(channel?)                 // → { ok, from, to, output }
```

冻结的 argv 常量（**不得合并、不得从渲层拼接**）：

| 常量 | 值 | 用在哪 |
| --- | --- | --- |
| `UPDATE_ARGS` | `["update", "--force"]` | 项目升级 |
| `INIT_ARGS_SUFFIX` | `["-y"]` | 新增平台（**不含 `-s`/`-f`**） |
| `GLOBAL_UPGRADE_ARGS` | `["upgrade"]` | 全局升级（自动） |
| `REMOTE_CHANNELS` | `["latest","beta","rc"]` | 通道白名单（唯一定义） |

### 3. Contracts

**进程调用**

| 项 | 约束 |
| --- | --- |
| API | `child_process.execFile`，argv 恒为数组 |
| `cwd` | 用户路径**只**作 `cwd`；永不进 argv，永不拼 shell 字符串 |
| `env` | 经 `mergedExecutionEnv`（`src/codex-queue-delivery.js`）——当前等价于继承 `process.env`，与 `src/updater.js` 同模式 |
| `shell` | 仅 `platform === "win32"` 时为 `true`（解析 `trellis.cmd`） |
| `timeout` | 必设；超时归类照 `src/updater.js` 的 `ETIMEDOUT` / `ESOCKETTIMEDOUT` / `ERR_TIMED_OUT` |

**IPC 信封**（`src/trellis-ipc.js`）

| 通道 | 入参 | 返回 |
| --- | --- | --- |
| `settings:trellis-scan` | `{ channel? }` | `{ status, roots, channels, remote, scans, projects, global, platformCatalog, channelCatalog }` |
| `settings:trellis-set-roots` | `{ roots }` | `{ status }`（**必经 `settings-controller`**） |
| `settings:trellis-add-platform` | `{ path, platforms: [id] }` | `{ status, added }` |
| `settings:trellis-upgrade-global` | `{ channel? }` | `{ status, from, to }` |

**输出解析（身份契约）**

`trellis --version` 写到 **stdout**，但版本行不保证是 stdout 的第一段。当进程 cwd 含 `.trellis/` 时，CLI 给**每个**命令加前缀横幅（源码：`dist/cli/index.js` 的 `checkForUpdates(cwd)`，读 `<cwd>/.trellis/.version` 与 `VERSION` 常量比对，`console.log` 到 stdout）。两个分支都存在：

| cwd 状态 | stdout 实际内容 | 首匹配读到 |
| --- | --- | --- |
| 项目旧于 CLI | `⚠️  Trellis update available: 0.6.0 → 0.7.0-beta.4` … `0.7.0-beta.4` | **`0.6.0`（项目）❌** |
| 项目新于 CLI | `⚠️  Your CLI (0.7.0-beta.4) is older than project (9.9.9)` … `0.7.0-beta.4` | `0.7.0-beta.4`（CLI）✅ |
| 无 `.trellis/` | 仅 `0.7.0-beta.4` | `0.7.0-beta.4` ✅ |

均以 CLI 0.7.0-beta.4 实测。三条结论：

1. 横幅左侧 = **项目**版本，右侧 / 括注里的括号值 = **CLI** 版本。
2. `--version` 因此是 **cwd 相关**的。
3. **错误是分支相关的**：三种 cwd 状态里只有一种错。“我测过了没问题”在这里毫无证明力——换一个 cwd 就静默读到别的项目的版本。

所以解析必须锚定**形状**（整行仅一个版本号），不得锚定**位置**（第一个版本样 token）。形状规则同时天然忽略第二个分支里嵌在散文中的 `9.9.9`。

### 4. Validation & Error Matrix

| 条件 | 行为 |
| --- | --- |
| `isTrustedEvent` 未注入 | **全部**通道 → `{status:"error", message:"untrusted-sender"}`；不 spawn、不写 prefs |
| `isTrustedEvent` 抛错 | 同上（**不得**把 guard 的异常串透传给渲染层） |
| `platformIds` 含表外 id | `{ok:false, error:"unknown-platform"}`；**execFile 不被调用** |
| `channel` 非 `REMOTE_CHANNELS` 成员 | `{ok:false, error:"unknown-channel"}`；**execFile 不被调用**（ipc 与 cli **各校验一次**） |
| 退出码非 0 | `{ok:false}`，**保留原始 stdout/stderr** |
| `--version` 输出无「整行仅版本号」的行 | `{installed:true, version:null}`（不是 `installed:false`） |
| `--version` 的 cwd 含 `.trellis/` | 解析仍取 CLI 版本；但 UI 显示的“已安装版本”含义变窄（见下） |
| 远程查询失败 / 离线 | `remote.error` 有值，`channels` 与 `target` 为 `null` → 渲染「未知」，**绝不当成「已最新」** |

### 5. Good/Base/Bad Cases

- **Good**：`upgradeGlobal("beta")` → argv `["upgrade","beta"]`；`upgradeGlobal()` → `["upgrade"]`
- **Base**：`--version` 输出只有 `0.7.0-beta.4` → 解析得 `0.7.0-beta.4`
- **Bad**：`addPlatforms(dir, ["gemini"])` 产出 `["init","--gemini","-y","-f"]`——`-f` 会让 CLI 跳过 `handleReinit` 增量分支、**从零重建** `.template-hashes.json`，使已登记平台从记录中消失，之后 `trellis update` 静默不再同步它们

### 6. Tests Required

| 断言点 | 位置 |
| --- | --- |
| 无 guard → 全通道 `untrusted-sender` 且 cli 调用计数全 0 | `test/trellis-ipc.test.js` |
| guard 抛错 → 同上（**新分支**，不是只测 guard 缺失） | `test/trellis-ipc.test.js` |
| 不可信 sender 被拒、可信 sender 仍可调用 | `test/trellis-ipc.test.js` |
| `upgradeGlobal()` argv 恰为 `["upgrade"]` | `test/trellis-cli.test.js` |
| `upgradeGlobal("beta")` argv 恰为 `["upgrade","beta"]` | `test/trellis-cli.test.js` |
| 未知 channel → `{ok:false,error:"unknown-channel"}` 且 execFile 未被调用 | `test/trellis-cli.test.js` |
| `addPlatforms` argv 恰为 `["init","--gemini","-y"]`（不含 `-s`/`-f`） | `test/trellis-cli.test.js` |
| 未知 platform id → 不构建 argv | `test/trellis-cli.test.js` |
| 更新横幅（项目旧于 CLI）下取右侧版本，且断言 `!== "0.7.0-beta.3"` | `test/trellis-cli.test.js` |
| 第二个横幅分支（CLI 旧于项目，版本嵌在散文里）也取 CLI 那行 | `test/trellis-cli.test.js` |
| 不可解析输出 → `installed:true, version:null` | `test/trellis-cli.test.js` |

### 7. Wrong vs Correct

#### Wrong — 锚定位置，读到另一个主体的版本

```js
const VERSION_OUTPUT_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
function parseVersionOutput(text) {
  const m = String(text || "").match(VERSION_OUTPUT_RE);   // 第一个版本样 token
  return m ? m[0] : null;                                 // ← 可能是【项目】版本
}
```

横幅存在时返回 `0.7.0-beta.3`（项目的），而 CLI 实为 `0.7.0-beta.4`。更糟的是：**升级任意项目都会改变这个读数**，于是 bug 表现为「全局 CLI 版本莫名其妙变了」。而且它**只在“项目旧于 CLI”这个分支错**，另两个分支碰巧对——所以随手测一下很可能测不出来。

#### Correct — 锚定形状，跳过横幅

```js
const VERSION_LINE_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
function parseVersionOutput(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {      // 倒序：末行仅版本号者胜
    const t = lines[i].trim();
    if (VERSION_LINE_RE.test(t)) return t.replace(/^v/, "");
  }
  const m = lines.join("\n").match(VERSION_OUTPUT_RE);  // 兜底：形如 "trellis v0.7.0"
  return m ? m[0] : null;
}
```

横幅行永远不是「整行仅版本号」，因此该形状对三个方向的横幅都成立（项目旧于 CLI、新于 CLI、无横幅）。

### 附带：跨层教训

**同一份人类可读输出里常混着不同主体的数字。** 信任之前先确定「这个数是谁的」，并把解析锚在不歧义的**形状**上，而不是**位置**上。位置会随无关状态（这里是 cwd）改变；形状不会。

**分支相关的错误比稳定错误更危险。** 这里的错误只在三种 cwd 状态中的一种出现，另两种碰巧正确。“我手动试过，是对的”在此毫无证明力。设计断言时要问：“这个错误在哪些输入下**不**出现？”——只覆盖“会错”的那一侧，并把另一侧也写成用例，否则重构时很容易把它改回错的。

**实测的证伪（本 spec 的测试有效性证据）**：把 `parseVersionOutput` 临时改回位置锚定后重跑：

```
✖ reads the CLI version, not the project version in the startup banner   ← 被抓
✔ reads the CLI version from the other banner branch too                 ← 碰巧通过
```

即：**两个分支用例里只有一个能抓到该 bug**。所以“有一个用例失败了”不等于“测试够了”；反过来，若当初只写了分支 B，这次 bug 会全程绿灯。

同一个 `--version` 既是 cwd 相关的，就意味着「已安装版本」只在**工具找不到项目的 cwd** 下才有唯一含义。若将来复用这个函数，必须显式保证 cwd 干净（`/tmp` 或应用目录），否则会静默读到某个项目的版本。建议在任何复用点旁写下这个前提。

---

## Scenario: 只读感知 Trellis 工作流状态（会话 → 任务绑定）

### 1. Scope / Trigger

「把磁盘上 Trellis 的任务/阶段/绑定状态呈现给用户」且**不执行任何 trellis 命令**的代码适用本条。

- 新增/修改 `src/trellis-activity.js`（轮询/对齐/缓存/跃迁）
- 新增/修改 `src/trellis-phase.js`（sanitize / platform 别名 / 阶段推导）
- 消费 snapshot 的 `entry.trellis` 字段做 UI

不适用：spawn CLI 的路径（见上一 Scenario）。

### 2. Signatures

```js
// src/trellis-activity.js — 工厂；fs/timer 全部可注入
createTrellisActivity({ state?, getLiveSessions?, fs, now, setTimeoutFn,
                        clearTimeoutFn?, onTrellisUpdate, onCelebration?,
                        onPhaseTransition? })
activity.start() / activity.stop()
activity.getTrellisInfo(sessionKey)   // → TrellisInfo | null（null = 不渲染）
activity.getByProject(projectPath)    // → { count, activeTasks:[{title,phase}] } | null
activity.getKnownRoots()              // → string[]（本进程正向缓存的 .trellis 根，stop() 清空）
```

`getKnownRoots()` 只读导出 rootCache 的正向缓存（cwd 命中过 .trellis 根），
供 recap Trellis 段（`src/recap-trellis.js`）作扫描根：会话结束后根保留
（当天早些时候做过的项目晚上仍进小结），stop() 清空后 recap 查询得到空
数组 → 返回 null → 该段隐藏。**只返回根路径字符串，不含任何任务内容。**

`onPhaseTransition({ taskPath, title, fromPhase, toPhase })` 同一 diff
管道的两个触发源：①`seen` 循环的真跃迁（首轮观察静默 seed，与跃迁庆祝
同规则）；②归档负空间检测的 `toPhase:"done"`（指针已删、title 为 null，
bubble 回退 taskPath）。title 读取复用 readTaskInfo（归档后从归档目录）。

`onCelebration(taskRelPath: string)` 两个触发源，参数统一是
`.trellis/tasks/<name>` 相对路径：①轮询观察到 →finish/done 跃迁；
②归档完成（绑定消失 + `tasks/archive/<月>/<同名>` 出现）。

`TrellisInfo = { taskPath, title, phase: plan|execute|check|finish|done,
                 progress: {done,total}|null, parallelCount,
                 nextStep?: string }`

`check` 是推导相而非真信号：task.json 的 status 只有
planning / in_progress / completed，`check` = **in_progress 且
implement.md checklist 全勾**（`total > 0 && done === total`）。
已知语义：全勾到实际跑 check 之间有一段「预标 check」窗口，文案
（“正在跑测试检查…”）是引导而非事实断言——与 finish 相
（completed → “归档以收尾”）同一启发式模式；反向误标不可能
（check 前必然全勾），中途补新未勾项自然回退 execute。
`progress` 口径（c13afbd1 起三级链）：**implement.md checklist →
prd.md 验收 checkbox → task.json subtasks**。implement.md 缺失或
无勾选项时回退 prd.md（PRD-only 轻量任务也有执行步骤可显，
不再是 0/0）；两者都无才走 subtasks。`nextStep` 仅在
存在未勾项时附键，值经 `truncateNextStep` 截到 40 code points
（surrogate-pair 安全，组合字符边界是可接受的视觉瑕疵）。

### 3. 会话绑定的双源真相（关键契约）

trellis 指针文件（`<project>/.trellis/.runtime/sessions/<platform>_<sanitized-raw-id>.json`）
存的是 **raw 会话 id**（如 `pi:01a0b040-…`）；而 Clawd snapshot 的 `entry.id` 是
**scoped key**（`s1.<b64url-profile>.<b64url-raw>`，见 `src/session-key.js`）。
两者**永不直接相等**：

```js
// main.js 组装侧：先解出 raw id 再交给 activity
const { parseSessionKey } = require("./session-key");
getLiveSessions: () => snapshot.sessions.map((entry) => ({
  id: entry.id,
  rawSessionId: (parseSessionKey(entry.id) || {}).rawSessionId || entry.id,  // 解不开则原样回落
  agentId: entry.agentId, cwd: entry.cwd, headless: !!entry.headless,
}))
// trellis-activity.js 消费侧：指针 key 永远用 raw id 构造
sessionPointerKey(session.agentId, session.rawSessionId || session.sessionId)
```

**新增 session key 消费者时先问：我要的是 scoped 还是 raw？** 任何把 snapshot
entry.id 直接当外部工具记录 id 用的代码都会静默失配（HUD 徽标 chips=0 的真机根因）。

### 4. 契约

- **只读红线**：`trellis-activity` / `trellis-phase` 只允许
  `readFile / stat / readdir`；零写、零 spawn、零网络。`trellis-celebration`
  只经注入回调播动画，不得自行 spawn。
- **对照测试**：sanitize / platform 别名表的 Node 复刻必须用**真实指针文件名**
  做 fixture 逐条断言（Python `_sanitize_key` / `_CONTEXT_KEY_PLATFORM_ALIASES`
  是权威）；CLI 改表时测试失败而非静默漂移。
- **别名表保守原则**：无真机指针证据的 agent（traecode/grok-build/qwen 等）
  一律 `trellisPlatformFor → null`，不类比推断；待证据出现再逐条补。
- **null 语义三态**：`phase` 为 null（未知 status）→ 不渲染；
  `upgradable` 类比同理——未知绝不渲染成「已最新」。
- **轮询骨架**：自调度 setTimeout 链 + lifecycleToken（禁 setInterval），
  空闲退避 15s / 活跃 5s；无可绑定会话时当轮零 IO。每个已绑定任务的
  implement.md 读取（存在或 ENOENT）与 task.json 同轮共享 per-round
  `taskReads` 缓存（同任务去重，+1 readFile/轮）；无 .trellis 根时
  零新增 IO；parallelCount 的 30s root summary **不**读 implement.md。
- **跃迁庆祝**：→ finish/done 才播，同 task <10s 抑制；DND / petHidden /
  mini 模式不播；主题缺 reactions.double 资产静默跳过（可选能力降级，
  不改 REQUIRED_STATES）。触发源两路：轮询可见的相位跃迁，以及归档
  完成（`task.py archive` 删指针+移目录是同一次提交，中间态不落盘，
  靠「绑定消失 + 归档副本存在」负空间检测；无副本的消失静默）。
- **idle 任务气泡**（trellis-bubble）：agent-idle（无 working 会话）+
  绑定任务 → 桌宠旁 thought-bubble 显示任务名 + `deriveNextStepHint`
  引导行（plan/execute/check/finish 四档，done/null 不弹；execute 且
  有 nextStep 时升级为 `trellisHintExecuteNext` 三插槽文案，nextStep
  在 formatHint 里**最后**替换，防止步骤文本内的 `{done}` 字面量被
  二次解释）；同 task 每会话
  一次；4s 自动隐藏；DND/petHidden/mini 同门槛；定位复用 update-bubble
  的 `__test.computeUpdateBubbleBounds`（permission stack + HUD 避让）。
  两个语义坑：①「idle」是 agent-idle 不是鼠标 idle 渲染态（用户在场
  时鼠标在动，鼠标 idle 永远不触发）；② loadFile 异步——注入文本必须
  等 `did-finish-load`，否则 executeJavaScript 被 catch 吞掉、窗口全
  透明。HUD chip tooltip 同源引导文案（7 语言）。
- **阶段切换气泡**（v3 lifecycle feedback，`showPhaseTransitionBubble`）：
  每次 `onPhaseTransition` 真跃迁弹一次性 thought-bubble（任务名 +
  `trellisPhaseBubbleHint` 单插槽 `{phase}`，在 formatHint 替换链里
  追加在 nextStep 之后，防止阶段名内的 `{…}` 字面量被二次解释）。
  与 idle 气泡共用窗口/定位/4s 隐藏，但**键独立**：去抖双表——
  dedupe `${taskPath} ${toPhase}` 10s 不重弹 + per-taskPath 10s rapid
  window（快速连续切换只弹最终态：可见时原地重写文本并**重置** hide
  timer，已隐藏则丢弃）。gate：DND/petHidden/mini（与 idle 气泡共享）
  + sleeping-like（`SLEEP_SEQUENCE.has(getCurrentState())`，phase-only
  新增）；**无 agent-idle gate**（转换通常 mid-work）。阶段名复用 HUD
  徽标键 `sessionHudTrellisPhase*`（`phaseLabelKey`，未知 phase 回退
  raw 字符串）；title null（归档负空间检测）回退 taskPath。双通道
  语义：finish/done 时 celebration 动画与 phase 气泡**并列触发**（PRD
  要求的「过渡动画+气泡」），两通道抑制窗口/触发面独立、互不接管。
  已知边界：pointer 存活时归档 done 的 taskPath 是归档路径
  （`.trellis/tasks/archive/<月>/<名>`），与 finish 时的 active 路径
  不同 key，per-task 去抖不跨归档边界生效（finish+快速归档会各弹
  一次，两次信息各自正确）。
- **HUD Trellis 详情行**（点击展开，取代 hover tooltip）：点 chip 在
  该会话行下方插入 `.trellis-detail` 弹性行，显示任务名 + 引导行。
  三个硬约束：① **高度双轨制**——`computeHudHeight(rowCount,
  detailExtra)` 只认固定行高×28px，弹性展开高度必须由渲染层实测
  （`offsetHeight`+margin）经 `session-hud:set-trellis-detail-height`
  IPC 回传 main 重算 bounds，禁止拍常数（固定值遇换行即截断）；
  ② **flex 收缩禁区**——HUD 容器是 column flexbox + overflow:hidden，
  `.trellis-detail` 必须 `flex: 0 0 auto`，否则窗口不够高时行被压缩，
  实测值就是被压缩后的值，反馈回窗口尺寸成 runaway shrink loop
  （症状：越点越矮）；③ **测量时序**——实测必须在 rAF 后（布局
  落定），无帧循环环境（测试 harness）同步 fallback，否则 0 或旧值。
  新增 `session-hud:*` IPC 通道必须同步补 session-ipc.test.js 频道
  白名单与依赖基座（required dep 缺失会被白名单测试拦住）。
- **阶段化身与并行 juggling**（avatar R3/R3.1）：`onAggregateChange({
  executingCount, planningActive})` 只在聚合值变化时 fan out（steady
  轮零触发；`stop()` 复位不 fan out）。三段契约：① **thinking-cap
  配件链**——planning 阶段 wizard-hat 是 ephemeral 补位：仅当
  manual+holiday 解析后 head 槽为 `none` 时注入（main.js
  `getEffectivePetAccessoryPayloads` 与 holiday runtime 注入的
  `resolveHeadAccessoryOverride` 两条独立 delivery 必须同口径），不写
  prefs、不顶掉 holiday（窗口内）或 manual 选择；主题无该配件经
  `buildPetAccessoryPayload` 静默降级。② **juggling 显示层升级**——
  `resolveDisplayState` 仅在 base 为 `working` 且跨项目
  `executingCount >= 2` 时返回 `juggling`：显示层 only，不改状态机、
  不加 REQUIRED_STATES、不写回 session.state；juggling tier 取
  `live subagents + trellisParallelCount` 之和
  （`normalizeTierExtraCount` 把 NaN/负/垃圾归 0）。③ **求和口径**——
  per-root 去重（同 root 多会话只计一次），仅统计本轮仍有 bound
  live session 的 root（复用 `parallelCache`，零额外 IO）；最后绑定
  消失的下一轮必须清零（`clearStaleBindings`）。注入侧
  `getTrellisProjectExecutingCount` 缺失/throw/垃圾值一律归 0 走旧路径。

#### §4.1 详情行高度契约（code-spec 7 段式）

**1. Scope/Trigger**：HUD 内任何「主进程算窗口尺寸 × 渲染层弹性内容」
组合。触发源：新增跨层 IPC `session-hud:set-trellis-detail-height`。

**2. Signatures**（全链路，自渲染层起）：
- renderer `reportTrellisDetailHeight()` → rAF 后 Σ(`.trellis-detail`
  .offsetHeight + 4px margin)，`Math.round` 后单次上报
- preload `sessionHudAPI.setTrellisDetailHeight(px:number)`
- IPC `session-hud:set-trellis-detail-height`（send，无 ack）
- main `_sessionHud.setTrellisDetailHeight(px)`（runtime 导出字段）
- session-hud.js `setTrellisDetailHeight(px)` →
  `computeHudHeight(rowCount, detailExtraPx)`

**3. Contracts**：
- `height = rowCount × HUD_ROW_HEIGHT(28) + HUD_BORDER_Y + detailExtraPx`
- detailExtraPx 只能来自渲染层实测，main 侧不预测、不缓存跨快照
- 单向流：renderer 实测 → IPC → main 重算 bounds → setBounds
- extra=0 时公式与旧版完全一致（无展开即零行为变化，向后兼容）

**4. Validation & Error Matrix**：
| 条件 | 行为 |
| --- | --- |
| px 为 NaN/非数字/≤0 | 归 0，等同全部收起 |
| \|Δpx\| < 2 | 忽略（防亚像素抖动重排循环） |
| 展开会话被折叠/消失 | render() 从 Set 清除，下轮上报 0，窗口回落 |

**5. Good/Base/Bad**：
- Good：7 语言长引导文案换行 3 行 → 实测 ~70px → 窗口完整容纳
- Base：无展开 → extra=0 → 高度公式与历史行为逐字节一致
- Bad：拍常数 44px → 任何换行即截断（§5 首行失败模式）

**6. Tests Required**：
- `test/session-ipc.test.js`：通道白名单 + noop 依赖基座（required
  dep 缺失必须 throw，白名单用例拦截漏注册）
- `test/session-renderer-behavior.test.js`：无 rAF 环境测量同步
  fallback（缺失则 4 个用例时序被吞）
- `test/session-hud.test.js`：`computeHudHeight(rowCount, extra)` 的
  0/负/NaN/正常四类输入

**7. Wrong vs Correct**：
```text
Wrong   computeHudHeight(rows, detailCount * 44)   // 拍常数
        .trellis-detail { }                        // 可 flex-shrink
Correct 渲染层实测 offsetHeight → IPC 回传 → main 重算
        .trellis-detail { flex: 0 0 auto; }
```

#### §4.2 Dashboard Trellis 面板（第二个 `entry.trellis` UI 消费者）

**1. Scope/Trigger**：Dashboard 页内任何消费 snapshot `entry.trellis`
做任务列表的渲染代码。当前实现：`src/dashboard-trellis-panel.js`
（纯聚合）+ `src/dashboard-renderer.js` 的 `renderTrellisPanel`。

**2. Signatures**：
- `aggregateTrellisTasks(sessions)` → 按 `taskPath` 去重的任务数组；
  phase 不在 `TRELLIS_PHASE_BADGE` 四相内、taskPath 空白的绑定直接丢弃；
  `parent`（task.json 同级任务名）首个非空值随任务携带，同 title 的
  first-wins 策略
- `groupTrellisTasks(tasks)` → 扁平渲染序列
  `[{task, depth, hasChildren, childSummary:{done,total}|null}]`；
  parent 是 **同目录 sibling 任务名**（`dirname(child.taskPath)+"/"+parent`
  必须在聚合列表内才成组，同名跨项目任务不会误融合）；孤儿/坏
  parent/环一律平铺到 depth 0，不报错
- 分组防护：`summary()` 递归先预留 slot（环返回 null 不死循环）、
  `emit()` 以 `emitted` Set 守卫，环成员由末尾补发循环平铺；
  递归深度受任务数上限约束（emit 每任务至多一次）
- 组头行显示 subtree 汇总 `dashboardTrellisGroupProgress`（替代自身
  step 计数），无子行时保留自身 progress；child 行缩进 18px
- `TRELLIS_PHASE_BADGE`：labelKey 复用 HUD 既有 `sessionHudTrellisPhase*`
  7 语言键（**不新开 dashboard 前缀阶段键**），cls 是 Dashboard 本地徽标类
- 模块是 `session-focus-unavailable.js` 的 UMD twin：测试 require、
  `dashboard.html` 以相邻 `<script>` 加载、renderer 经
  `globalThis.ClawdDashboardTrellisPanel` 解构——纯函数体内零 DOM/零 i18n/零 IPC

**3. Contracts**：
- 数据源只用 snapshot 内 `entry.trellis`（resolver 产物），不新开 watcher/IPC
- 每秒 render() 重建卡片树时靠签名防抖：签名 =
  `{lang, tasks, expanded(sorted)}` 的 JSON.stringify 全量比较；
  展开/收起切换把签名置 null 强制重渲染
- 展开态存模块级 `Set<taskPath>`，重建时重读；清理时机：任务列表清空时
  `clear()`、每次重建剔除不在 livePaths 的 key（不是只增不减）
- 隐藏语义：`.trellis-panel { display:flex }` 会让 author display 覆盖
  UA 的 `[hidden]{display:none}`，必须显式写 `.trellis-panel[hidden] `
  `{ display:none }`（同 `.quick-banner[hidden]` 既有模式），并有静态测试守卫

**4. Wrong vs Correct**：
```text
Wrong   在 renderer 里内联聚合逻辑 / 新开 dashboardTrellisPhase* 键
        面板隐藏只靠 `el.hidden = true`（flex 覆盖后仍泄漏 12px 边距）
        expanded Set 只在 click 时写入，从不清理
Correct 聚合入 dashboard-trellis-panel.js UMD；阶段文案复用 sessionHudTrellisPhase*
        hidden 属性 + .trellis-panel[hidden] { display:none } 成对出现
        重建时以 liveTasks 的 taskPath 集合修剪 Set
```

#### §4.3 任务详情卡（readTaskDetail + readTaskDoc + Dashboard overlay）

**1. Scope/Trigger**：任何「按需单次读取某个 Trellis 任务文件并呈现」的
代码。当前实现：`src/trellis-activity.js` 的 `readTaskDetail` /
`readTaskDoc`（共享 `resolveTaskDir`）、`src/session-ipc.js` 的
`dashboard:trellis-task-detail` / `dashboard:trellis-task-doc`、
`src/dashboard-renderer.js` 的 trellis-detail overlay + doc tabs、
`src/trellis-doc-renderer.js`（受限 GFM 子集渲染器，UMD twin）。

**2. Signatures**（全链路，自渲染层起）：
- renderer `openTrellisDetail(task)` → 单次 `dashboardAPI.getTrellisTaskDetail(
  { taskPath, cwd })`（冻结于打开瞬间，从不轮询）
- preload `getTrellisTaskDetail(payload)` / `getTrellisTaskDoc(payload)` →
  `ipcRenderer.invoke`
- IPC `dashboard:trellis-task-detail`（handle，同步返回结果对象）
- main `_trellisActivity.readTaskDetail(cwd, taskPath)` →
  `{status:"ok",task:{title,phase,rawStatus,createdAt,completedAt,
  archived,checklist,docs}}` | `{status:"missing"}` | `{status:"error",message}`；
  `docs` 列出任务目录全部 `*.md`（`{name,size}`，prd → design → implement
  优先，其余字典序；size 是 utf-8 字节数）
- main `_trellisActivity.readTaskDoc(cwd, taskPath, doc)` →
  `{status:"ok",name,size,truncated,content}` | `{status:"missing"}`
- renderer `switchTrellisDetailTab(tab)` → doc tab 懒拉取一次，
  `renderMarkdownDoc(builder, content)` 渲染（builder 注入，
  createElement/createTextNode only）

**3. Contracts**：
- **payload 恰为两/三字符串**：detail 通道 `Object.keys` 排序后长度必须是
  2（`cwd`/`taskPath`）；doc 通道长度必须是 3（`cwd`/`doc`/`taskPath`）。
  结构化克隆后的 `{"__proto__":…}` 是 own property，会被这个门拦下，
  污染面到不了 owner
- **trusted-frame 门禁**：与 session history 同一道
  `isTrustedDashboardEvent`（sender===owner contents && mainFrame &&
  精确页面 URL），不依赖 webFrameId
- **cwd 三源信任面**：cwd 必须过 `isTrustedTrellisCwd()` —— live 会话 cwd ∪ 本进程正向解析过 .trellis root 的 cwd（rootCache 正向条目） ∪ 已注册项目根（persistedRoots，经 `normalizeRootPath` 规范化后比对）；陌生 cwd 直接 missing，即使磁盘上 root 可达也不读——根永远来自会话或用户显式注册，不来自请求
- **路径遏制（双分隔符）**：taskPath 必须以 `.trellis/tasks/` 开头，且
  按 `/[\\/]/` 拆分后每段非空、非 `.`、非 `..`。**win32 的 `path.join`
  会把反斜杠段也 normalize**：`"/"`-only 拆分放行
  `.trellis/tasks/a\..\..\x` → join 越界到 root 外（POSIX 分支碰巧无害，
  win32 分支真越界——分支相关错误，拆分逻辑必须平台无关）
- **doc 名双门禁**：`doc` 必须是纯 `*.md` basename（字符串、非空
  stem、无 `/` 无 `\\`、非 `.`/`..`），且必须是**重新列目录结果**的成员
  ——rendir 白名单在读取前重验，渲染层无法指名目录里不存在的文件。
  basename 门禁已在名字空间上封死路径逃逸；白名单是"列目录结果即真实
  文件名"的字符串级 containment（symlink 指向属任务目录内容信任面，
  与 task.json 同一既有语义，不额外 realpath）
- **1MB 字节截断**：`Buffer.subarray(0, 1MiB).toString("utf8")` +
  `truncated:true`；截断落在多字节序列中间时 Node 会把悬挂字节换成
  U+FFFD（合法字符串，不 mojibake 不抛错——有回归用例）；截断后
  未闭合围栏由渲染器 fail-open 渲到 EOF
- **文档内容 ephemeral**：内容只乘 IPC 回包而行——不进 prefs、
  不进日志、不落盘；渲染层 `trellisDetailDocs` 会话内存缓存在
  `closeTrellisDetail()` **和** `openTrellisDetail()`（同一 overlay 重入，
  不经过 close）都必须清空——否则跨任务累积 1MB×docs 且签名
  fingerprint 携带死 key
- **渲染器红线**（`trellis-doc-renderer.js`，UMD twin 同 §4.2 模式）：
  纯函数 `(builder, markdown, options) → {root, truncated}`，全部元素
  经注入 builder 的 createElement/createTextNode，零 innerHTML；
  行内 tokenizer 单趟前向 + `MAX_INLINE_DEPTH=4` 硬帽（敌意输入
  O(n×depth)，无 O(n²) 退化）；行数帽 `MD_MAX_RENDER_LINES=5000`，
  超限丢弃尾部并返回 truncated；链接只渲染 label 文本（URL 丢弃）；
  h2/h3 折叠交互在 renderer 侧 wire（toggle 类 + 隐藏同级），点击
  不会误关 overlay（backdrop 判定是 `event.target === overlay`）
- **归档回退**：active 目录消失时复用 `findArchivedTaskDir` 精确名匹配
  （与轮询/庆祝同一语义）；跨月同名取 readdir 首个，与既有回退一致；
  detail 与 doc 共享同一条 `resolveTaskDir`（含回退）
- **降级语义**：无 root/无目录/被拒 → `missing`（卡片提示可能已归档）；
  task.json 损坏 → `error`（不渲染半空数据）；doc 不可读/不在白名单 →
  `missing`；checklist 只解析 checkbox 列表，不渲染任意 markdown
- **overlay 生命周期**：每秒 render() 调 `renderTrellisDetail`，但签名 =
  `{lang,open,loading,request,result,tab,docsFingerprint}` 的 JSON 全量比较——
  request（含 sessions 快照）在打开时冻结，所以周期重建既不关卡也不闪，
  折叠态/激活 tab 在 tick 下保留；docsFingerprint 只含缓存条目的
  (key,loading,status,length,truncated)——1MB 文档不进签名（碰撞面：
  同 key 内容变化但 length 相同 → 不刷新，snapshot 语义可接受）；
  任务从面板消失后卡片靠冻结引用继续存活。ESC（quick 模式持键时不
  抢）/backdrop 点击/✕ 关闭；监听器只在 init 注册一次
- **CSS hidden 守卫**：`.trellis-detail-overlay[hidden]{display:none}`
  必须与 `display:flex` 成对出现（静态测试断言，同 `.trellis-panel`）

**4. Wrong vs Correct**：
```text
Wrong   taskPath.split("/") 后只拒 ".." 段        // win32 反斜杠段漏网
        findTrellisRoot(renderer 传入的任意 cwd)   // 任意目录探测 .trellis
        overlay 重建引用面板实时 sessions          // 每秒卡片闪变/被归档期关掉
        doc 名白名单只在打开时验一次               // TOCTOU + 渲染层可指名任意文件
        doc 缓存只在 close 清空                    // 同 overlay 重入跨任务累积 1MB×docs
        截断用 content.slice(0, N)                 // 按代码点切，字节上限失效
Correct taskPath.slice(prefix).split(/[\\/]/) 后逐段拒绝
        cwd ∈ collectLiveSessions() 的 cwd 集合，否则 missing
        request 冻结于 open 瞬间，签名含 request/result 才重渲染
        每次读前 readdir 重验 doc 名白名单（纯 basename 门禁）
        openTrellisDetail + closeTrellisDetail 都清 trellisDetailDocs
        Buffer.byteLength 验收：截断后 ≤ 1MiB+2（U+FFFD 补偿）
```

#### §4.4 归档任务列表（独立视图 + 共享遍历）

**1. Scope/Trigger**：任何「读取 `.trellis/tasks/archive/` 并呈现」的
代码。当前实现：`src/trellis-archive.js`（共享遍历）、
`src/trellis-activity.js` 的 `readArchiveList`、`src/session-ipc.js` 的
`dashboard:trellis-archive-list`、`src/dashboard-renderer.js` 的归档
折叠区。recap（`src/recap-trellis.js`）与归档列表**共用同一遍历**，
不得复制。

**2. Signatures**（全链路，自渲染层起）：
- `listArchivedTasks(fsApi, archiveBase, options?)`（`src/trellis-archive.js`，
  注入同步 fs）→ 冻结条目数组
  `{name, month, dir, title, createdAt, completedAt, completedAtMs}`；
  `options.month`（"YYYY-MM"）限定单月目录（recap 语义，不多 readdir
  archive 根），缺省读全部 YYYY-MM 目录。task.json 不可读/损坏 →
  跳过；completedAt 无效时 fallback 目录 mtime（仅存 completedAtMs，
  由消费方投影到自己的时区——recap 用 timeZoneId，dashboard 用
  toLocaleDateString(app lang)）
- renderer 首次切到独立 Trellis 视图 / 显式 ↻ 刷新 → 单次
  `dashboardAPI.getTrellisArchiveList()`（**无 payload**；根集完全
  来自 owner，无活跃会话也能列出，永不轮询）
- main `readArchiveList()` → `{status:"ok", tasks:[…200]}`，
  newest-first（completedAtMs 降序，null 压尾）；条目
  `{taskPath, title, createdAt, completedAt, completedAtMs, durationMs, cwd}`；
  `durationMs ≤ 0` 或缺失 → null（渲染 "—"）

**3. Contracts**：
- **根集来自 owner（无 payload 通道）**：IPC 层无 payload（多余字段被
  忽略，root 集不来自请求）；owner 层用 `collectKnownRootCwds()` ——
  已注册 roots 优先 + 本进程正向解析过 root 的 cwd（cap 32），每个
  root 经 `rootToCwd` Map 去重后只扫一次（注册根与子目录会话解析
  同一 root 时不会双扫）。注册 root 直接 `path.join(root, ".trellis")`
  解析——不向上搜索、不落负缓存；缺失 .trellis 的注册目录安全地
  返回空列表
- **信任模型**：roots 永远来自会话或用户显式注册（§4.5），不来自
  请求；taskPath 是
  `.trellis/tasks/archive/<月>/<名>` posix 相对路径，直接走 readTaskDetail
  既有归档回退（cwd 由条目携带，无额外信任面）
- **缓存与竞态**：模块级 `trellisView.archive` 状态（loading/
  loaded/tasks/error/openMonths）；fetch 前后 `seq+=1`
  守卫，旧响应回来 `seq !== current` 直接丢弃
- **隐藏语义**：loaded 且空 → 空态文案（独立视图内仍显示区块
  头）；loading/error/非空保持可见
- **locale**：mtime fallback 的完成日期用 `toLocaleDateString(app lang)`，
  非 task.py 写入的原始 YYYY-MM-DD 字符串优先直接显示

**4. Wrong vs Correct**：
```text
Wrong   toLocaleDateString()                    // 跟系统 locale，与 UI 语言不一致
        readArchiveList(payload.cwds)              // 渲染层供 cwd → 任意目录探测 .trellis
        fetch 回包无 seq 守卫                       // 旧包渲染进新项目视图
Correct readArchiveList() 无参；根集来自 collectKnownRootCwds()
        root 去重后才扫；回包对 seq 后才落地
        completedAt 原串优先；mtime fallback 日期跟 i18nPayload.lang
```

#### §4.5 注册项目根（trellis-roots 持久化 store）

**1. Scope/Trigger**：任何「让用户登记/移除一个 Trellis 项目根并跨
重启保留」的代码。当前实现：`src/trellis-roots.js`、`src/main.js` 的
`pickAndRegisterTrellisRoot` / `removeRegisteredTrellisRoot`、
`src/session-ipc.js` 的 `dashboard:trellis-roots-{list,add,remove}`。

**2. Signatures**：
- `createTrellisRootsStore({ fs?, filePath?, warn? })` →
  `{ load(), list(), listPicks(), recordPick(), removePick(), add(root), remove(root) }`；默认文件
  `~/.clawd/trellis-roots.json`，v1 形态 `{version:1, roots:[...], picks:[{picked, roots:[...]}]}`
  （**不足 prefs**，与 roam-area.json 同层，settings schema/controller 零接触）。
  legacy 纯字符串数组自动迁移：按未覆盖根的父目录推断 pick 行
  （f853b513——簿记曾只在进程内存 Map，重启即退回逐根移除）
- `add`/`remove` 返回 `{status: ok|duplicate|limit|invalid|not-found,
  roots?}`；cap 64（`TRELLIS_ROOTS_MAX`）；`remove` 会同步剪枝 pick
  簿记（根耗尽的 pick 随之消失）；`recordPick`/`removePick` 返回
  `{status: ok|invalid|not-found, roots?, removed?}`
- `normalizeRootPath(p)`：`path.normalize` + 去尾分隔符（**不做
  case folding**）；持久化集合的 canonical 形式

**3. Contracts**：
- **路径来源只有目录 picker**：add 通道无 payload（renderer 仅触发），
  main 侧 `electronDialog.showOpenDialog` 选目录后经
  `resolveProjectRoot`（向上找最近 .trellis，一次用户动作一次搜索、
  永不缓存）解析到项目根；无 .trellis 的目录也照注册（空列表直到
  trellis init），用户选择永不静默丢弃
- **remove 是白名单成员删除**：store 内 `indexOf(normalized)` 命中
  才写盘；“曾注册但已删”的路径 → `not-found` 零写盘。IPC payload
  严格恰为 `{root: 非空 string}`（`Object.keys` 长度=1，`__proto__`
  own-property 也会被拦）
- **原子写**：tmp 文件（同目录 `.<name>.<pid>.tmp`，同卷）+
  `renameSync`；仅在集合真变化时写（add 命中 duplicate / remove
  命中 not-found 均零写盘）
- **load 容错不回写**：损坏/非数组内容 → warn 一次、内存 roots=[]，
  **保留原文件**；已有注册永远不会被空文件意外清掉（写路径只在
  显式 add/remove；load 失败不触发 persist）。并发写：Electron 单
  main 进程内 store 操作同步串行，无跨进程锁需求
- **信任面同步**：main 每次 add/remove 成功后调
  `activity.setPersistedRoots(store.list())`；boot 时 load 后同步一次。
  `persistedRoots` 在 activity 内**穿越 stop()**（镜像 caller 拥有的
  文件，不是本模块自有的缓存）

**4. Tests Required**（`test/trellis-roots.test.js`）：
- 加载规范化（尾分隔符/非字符串/重复去重）；缺失文件零写盘
- 损坏/非数组 → 空集 + warn 一次 + 原文件保留
- add 的 tmp+rename 原子形状；duplicate 零写盘
- remove 已注册成员持久化；未注册零写盘；cap 64

#### §4.6 独立 Trellis 视图（双视图切换 + readActiveList）

**1. Scope/Trigger**：Dashboard 页内任何「与 Sessions 平级的 Trellis
视图」代码。当前实现：`src/dashboard.html` 的 view-switch /
`#trellisView` / `#sessionsHeaderExtras`、`src/dashboard-renderer.js` 的
`switchDashboardView` / `renderTrellisView` / trellisView 状态、
`src/trellis-activity.js` 的 `readActiveList`、`src/session-ipc.js` 的
`dashboard:trellis-active-list`。

**2. Signatures**：
- `switchDashboardView("sessions"|"trellis")`：纯显示翻转（两个滚动
  main + sessions 专属 header extras），内存态不持久化；切入 trellis
  时一次性 `refreshTrellisView()`（roots/active/archive 三路并发拉取）
- `readActiveList()` → `{status:"ok", tasks:[…200]}`，条目
  `{taskPath, title, phase, progress, parent, cwd, nextStep?}`；
  taskPath 是 snapshot 相对 posix 路径（readTaskDetail 接受）；
  与 readArchiveList 同根集（§4.4）且同鲜 `seenRoots` 去重

**3. Contracts**：
- **quick round 强制切回**：`beginQuickRound`（所有 quick 入口：
  onQuickIntent / quickPending）在 await 之前同步
  `switchDashboardView("sessions")`——数字骨架渲染在 sessions 内容
  区，任何 quick 入口都不许在 trellis 视图上画数字
- **hidden 双守卫**：`.trellis-view[hidden] { display:none }` 静态
  断言；sessions 侧用 `.hidden` 类（`display:none !important`）。
  `#sessionsHeaderExtras`（quota + 会话内嵌面板）在 trellis 视图下
  隐藏，但 `renderTrellisPanel()` 照常执行（签名防抖挡住无谓重建）
- **每秒 render() 与视图**：`renderTrellisView()` 开头
  `activeView !== "trellis"` 直接 return；视图签名 =
  `{lang, roots, selectedRoot, active, archive}` 全量 JSON（含
  openMonths；selectedRoot 见 §4.7）
- **会话内嵌面板保留**：活跃绑定视角（entry.trellis 聚合）仍是
  §4.2 面板；归档浏览只在独立视图——双入口不得回潮

**4. Tests Required**（`test/dashboard-trellis-panel.test.js`）：
- 视图切换：tab 点击、header extras/content 隐藏、切回不重拉
- quick round 在 trellis 视图上启动 → 切回 sessions（全部入口收口
  beginQuickRound，一例即可覆盖）
- `.trellis-view[hidden]` 静态 CSS 守卫

#### §4.6a Roots 管理的 pick 语义（67f62d6c）

- roots 区渲染的是**用户选择**（pick）而不是展开后的项目根：多项目
  pick（~/Downloads/codes → 5 个子项目）只显示一行——选择目录 + ×N
  徽标 + 一个移除按钮（移除即撤销该 pick 注册的全部根）。
- pick 簿记持久化在 roots store 自身（`picks` 数组，随 roots 同文件
  原子写，重启存活），`dashboard:trellis-pick-remove`
  通道严格 `{picked}` 单字符串 payload；无 pick 记录的根（会话解析/
  历史持久化）仍逐根渲染，保证一切可管理。
- picker 的选择**权威且不向上爬**：`isDirectProjectRoot` 只查所选目录
  本身（aeba090e 的教训——resolveProjectRoot 的向上 .trellis 爬会把
  整个 $HOME 注册成根）；三态：本项目→注册它 / 直接子级含项目→批量
  注册（CHILD_PROJECT_MAX=32）/ 否则 UI 提示"无 trellis 项目"。
- 树视觉（纯 CSS，无树组件）：连接线渐变辉光珠、[data-depth] 1-5
  深度着色内衬（蓝→紫→琥珀→橙→红）、行 hover 2px 位移、caret 悬停
  缩放、展开 160ms unfold 动画。**选择器必须锚定真实行类名**
  `.trellis-task-row / .trellis-archive-row`（曾写成 .trellis-tree-row
  匹配空）。

#### §4.6b 通道契约：dashboard:trellis-pick-remove（7 段式）

**1. Scope/Trigger**：跨层 IPC——renderer 撤销一次 pick（连带其注册的
全部根）。同类通道族：trellis-roots-{list,add,remove}。

**2. Signatures**：
- preload：`removeTrellisPick(picked: string) → invoke("dashboard:trellis-pick-remove", { picked })`
- session-ipc handler：trusted Dashboard main-frame only；payload 键集
  恰为 `["picked"]` 且为非空 string，否则 `{status:"invalid"}`
- main：`removeTrellisPick(picked)` → `_trellisRootsStore.removePick()`
  （store 内一次删 pick + 其全部仍注册根，单次原子持久化）+
  `syncTrellisPersistedRoots()` →
  `{status:"ok", roots, removed:[...]}`
- 依赖注入：`removeTrellisPick` 是 session-ipc 的 required dep（缺失即
  throw，测试基座必须补 noop）

**3. Contracts**：
- request：`{picked: string}`（严格单键；`__proto__` 等 own-key 变体拒）
- response：`{status: "ok"|"invalid"|"not-found"|"error", roots?: string[], removed?: string[]}`
- roots 数组同时是 pick-remove 后的 UI 真相（renderer 直接刷列表）

**4. Validation & Error Matrix**：
| 条件 | 行为 |
| --- | --- |
| 非 trusted frame / 多余键 / picked 非字符串/空 | `{status:"invalid"}` |
| picked 未在簿记 Map（含 normalize 差异） | `{status:"not-found"}`（不动 store） |
| pick 存在但某根已被单独 remove | 仍 ok——remove 幂等，removed 列实际删掉的 |
| store.remove 抛错 | 不吞：`{status:"error"}`，簿记已删但 store 可能半删（下次 add 同目录会重建簿记） |

**5. Good/Base/Bad**：
- Good：pick codes（5 根）→ remove("…/codes") → 5 根全消失、roots 刷新
- Base：pick 单项目 → remove → 该根消失，行为与 roots-remove 等价
- Bad：renderer 传子项目路径（非 pick 目录）→ not-found，绝不部分删

**6. Tests Required**：session-ipc.test.js——通道白名单成员 + noop 依赖
基座 + payload 形状拒（多键/空串/__proto__）；main 侧 not-found /
幂等 / removed 回包（当前由 trellis-activity/panel 套件间接覆盖，
renderer 的 removeTrellisPickFromRow 错误路径置 rootsError）。

**7. Wrong vs Correct**：
```text
Wrong   removeTrellisRoot(childRoot)     // 对每个子根单独调——UI 碎片化
        removeTrellisPick(子项目路径)     // not-found：簿记键是 pick 目录
Correct removeTrellisPick(pick 目录)      // 一次撤销整组
```

#### §4.7 多项目筛选（独立视图 chip 行，纯渲染层）

**1. Scope/Trigger**：任何「在独立 Trellis 视图内按项目根切分/合并
任务列表」的代码。当前实现：`src/dashboard-trellis-panel.js` 的三个
纯函数 + `src/dashboard-renderer.js` 的 `buildTrellisFilterSection` /
`trellisRowProjectLabel` / `trellisView.selectedRoot`。

**2. Signatures**：
- `trellisTaskOwningRoot(cwd, roots)` → 拥有该 cwd 的注册 root
  （最长前缀匹配），无归属 → null
- `filterTrellisTasksByRoot(tasks, roots, selectedRoot)` → 过滤后
  数组；`selectedRoot === null` 原样返回（"全部" 合并视图）
- `buildTrellisRootLabels(roots)` → `Map<root, label>`；label 默认
  basename，重名时逐级加祖先段去歧义

**3. Contracts**：
- **纯渲染层**：筛选是聚合后过滤——完整 active/archive 列表留在
  内存，每次重建按 selectedRoot 现切；不写 prefs、不发 IPC、
  `selectedRoot` 会话级不持久化。chip 点击只置
  `lastTrellisViewSignature = null` 强制重渲染（签名含
  selectedRoot，双保险），同步完成、无点击竞态；active/archive
  从不轮询，签名稳定期 chip 行不会被 per-second tick 重建
- **最长前缀归属**：cwd === root 或以 `root + "/"` / `root + "\\"`
  开头才算命中——前缀必须落在路径分隔符上（`/a/projx` 不归
  `/a/proj`）；嵌套 root（`/a/proj` 与 `/a/proj/sub` 都注册）取
  最长者，任务不会双计。精确匹配（不做 case folding）：cwd 与
  root 出自同一 main 侧解析链（§4.5），分隔符已平台规范化
- **去歧义规则**：basename 唯一直接用；重名先加父段
  `name (parent)`，仍撞再加一级 `name (grand/parent)`（up 层
  数决定括号内段数，不同层 candidate 必不相等）；根级 root 无
  祖先段可用时全路径兜底——labels 键是 root 路径本身，chip 点击
  闭包绑定路径而非 index，无错位面
- **失效回退**：`refreshTrellisViewRoots` 成功落地后，若
  selectedRoot 不在新 roots 内 → 回退 null（"全部"），绝不静默
  过滤成空列表。回退条件只看存在性：异步 roots 回来时用户已切
  到别的 chip 且该 chip 仍在列表内，则保留用户选择
- **行内来源标注**：合并视图（selectedRoot === null）下每个归属
  root 的行尾带去歧义 label 标签；单项目视图标题已点名项目，
  标签省略；未注册 root 的 cwd 不显示误导性 basename
- **空项目 chip**：0 活跃 + 0 归档 → 置灰（opacity）但仍可点，
  点进去看空态是功能本身；chip 计数 = 该 root 活跃任务数，
  归档计数在归档区标题 `(N)` 上跟随筛选

**4. Tests Required**（`test/dashboard-trellis-panel.test.js`）：
- 纯函数：最长前缀、分隔符边界（`/proj/onesuffix` → null）、
  win32 反斜杠、去歧义三层 + 全路径兜底、`selectedRoot === null`
  原样返回
- 渲染：chip 行计数/aria-pressed/默认全选、单选收窄 active +
  archive 且隐藏来源标签、空项目置灰可点、注销所选 root 后回退
  全部、重名 basename 的 chip 与行标签

#### §4.8 任务树（独立视图，活跃 + 归档统一嵌套）

**1. Scope/Trigger**：任何「在独立 Trellis 视图内把活跃/归档任务按
parent 嵌套成树」的代码。当前实现：`src/dashboard-trellis-panel.js`
的 `buildTrellisTree` / `trellisArchiveMonthOf`、
`src/dashboard-renderer.js` 的 `createTrellisTreeNodeEl` /
`trellisTreeExpanded`。

**2. Signatures**：
- `buildTrellisTree(activeTasks, archivedTasks)` → `{roots, depthCap}`；
  节点 `{task, archived, depth, children, childSummary:{done,total}|null}`。
  纯函数：零 DOM/零 i18n/零 IPC（UMD 导出，测试直接 require）
- `trellisArchiveMonthOf(taskPath)` → `"YYYY-MM"` 或 `""`：取
  `"/archive/"` 段后的第一段（readArchiveList 的 taskPath 是
  `.trellis/tasks/archive/<月>/<名>` 全路径）。**不得改回取第一段**——
  v2 的月分组 bug 正是把全路径形态当 archive-relative 形态提取，
  所有月份静默合并进单个 `.trellis` 组（当时无 month 断言所以绿灯）

**3. Contracts**：
- **parent 匹配四层规则**（parent 是 task.json 的同级任务 NAME，
  逐层降级，歧义一律平铺不猜）：① 活跃子 → 同目录活跃父
  （`dirname(taskPath)+"/"+parent` 必须在活跃集内，v1
  groupTrellisTasks 同规则）；② 活跃子 → 唯一同名归档任务（任意月）；
  ③ 归档子 → 同月同名归档父，无同月时唯一跨月匹配；④ 归档子 →
  唯一同名活跃父（灰子挂活跃父下）。自指/环/超深（depth cap 32）
  平铺到 depth 0，行永不丢、永不双出（emitted Set + slot 预留，
  同 v2 防护模式）；活跃 taskPath 重复 first-wins 去重，归档重复行全保留
- **灰子不重复**：归档子挂到活跃父后不再是 root，归档月分组只对
  archive roots 做——它**只**出现在活跃父子树里，绝不同时出现在
  归档月组。归档区标题计数仍是全部归档任务数，与月组行数可以
  不一致（嵌套走的不占月组槽）
- **childSummary** 汇总全部后代 progress（归档任务无 progress，
  永不进分子分母）；组头行显示汇总，无子行的叶子保留自身 progress
- **展开语义**：模块级 `Map<taskPath, boolean>` override + 默认值
  （活跃分支展开、归档分支收起）；枝干行点击 = 切换子树（不打开
  详情卡），叶子行点击 = v2 详情卡语义，ⓘ 按钮恒在；
  expand/collapse-all 只对存在行的 section 渲染，且只动本 section
  的枝干；视图签名含排序后的展开 entries——展开集稳定时 1s tick
  不重建 DOM，override 以 live taskPath 集合修剪（不是只增不减）
- **渲染**：递归 DOM（`row + .trellis-tree-children` 容器），CSS
  缩进 + 左边框连接线，不引树组件；收起即不建子容器；递归深度
  受纯函数 depth cap 约束（树深 ≤ 32，JS 栈/DOM 嵌套均安全）
- **filter 先于树**：selectedRoot 过滤发生在 buildTrellisTree 之前，
  被滤掉的父任务使其孤儿子平铺回 root（树始终反映过滤后视图）

**4. Tests Required**（`test/dashboard-trellis-panel.test.js`）:
- 纯函数：同目录嵌套/跨集嵌套四层各一例、歧义平铺、环/自指/垃圾
  输入、depth cap 尾部重根、200 任务森林不丢不重、重复路径去重
  语义、`trellisArchiveMonthOf` 形状表（含 legacy 相对形态 → ""）
- 渲染：枝干点击切换且不开详情卡、归档分支默认收起、
  expand/collapse-all 分区隔离、灰子挂活跃父且不在月组重复出现

### 5. 失败模式

| 症状 | 根因 | 防护 |
| --- | --- | --- |
| HUD 行有会话但徽标不渲染 | snapshot scoped id 当 raw id 用，指针永不命中 | §3 双源契约 + `parseSessionKey` round-trip 测试 |
| 徽标显示陈旧阶段 | 缓存 diff 未触发 `onTrellisUpdate` → snapshot 未重发 | 更新必须走既有 sendSnapshot 路径，不绕开直发 webContents.send |
| 阶段在 done/finish 间抖动连播动画 | 归档中目录移动的中间态 | 跃迁史 + 10s 抑制；指针悬空时 `detectArchivedTasks` 在同轮用 `tasks/archive/<month>/<name>` 精确名匹配判定 done 并庆祝（归档删指针与移目录是同一次提交，等下一轮必然绑定已消失；无归档副本的消失保持静默） |
| 详情行文字被截断（显示不完整） | 用固定常数当展开行高度，遇换行即溢出 | 高度双轨制：固定行高 ×28 + 渲染层实测弹性高度回传（见 §4） |
| 展开后 HUD 越缩越小 | detail 行可 flex-shrink，实测回传的是被压缩值，反馈成 runaway loop | `.trellis-detail { flex: 0 0 auto }`；实测值与压缩值必须区分 |
| Dashboard 面板隐藏后仍留空白间距 | `.trellis-panel { display:flex }` 覆盖了 UA `[hidden]` 规则 | `.trellis-panel[hidden] { display:none }` + 静态测试断言（见 §4.2） |
| 详情卡读出 root 外文件（win32） | taskPath 只按 `/` 拆分，`a\..\..\x` 单段过检，`path.join` normalize 后越界 | 双分隔符拆分 + 逐段拒绝（见 §4.3）；两平台都要有用例 |
| doc 渲染层执行了注入的 HTML | 渲染器拼了 innerHTML / 消费侧绕开 builder | builder 注入 + createElement/textContent only，hostile-input 用例断言只建 div/span（§4.3） |
| 同 overlay 连续打开多任务后内存膨胀 | doc 缓存只在 close 清，重入 open 残留 1MB×docs 死条目 | openTrellisDetail 与 closeTrellisDetail 都清空 trellisDetailDocs（§4.3） |
| 陌生 cwd 能探测任意 .trellis | readTaskDetail 直接 findTrellisRoot(renderer 的 cwd) | cwd 必须过 isTrustedTrellisCwd 三源（见 §4.3）；两平台都要有用例 |
| 独立视图活跃任务每条出现两次 | 注册根与子目录会话解析同一 root，readActiveList 无 root 去重 | seenRoots/rootToCwd 按 root 去重（§4.4/§4.6）+ 双源共享 root 回归用例 |
| 归档区所有月份合进单个组（月浏览器失效） | 月提取把全路径 taskPath 当 archive-relative 形态切第一段（得到 `.trellis` 而非月份）——形态认知错位，且当时无 month 断言故绿灯 | 提取锚定 `/archive/` 段（`trellisArchiveMonthOf`）+ 形状表测试含 legacy 形态（§4.8）；改 taskPath 形态时同步改所有消费方提取逻辑 |

### 6. 测试断言点（review 必查）

- fake fs 写操作计数恒 0（只读断言）
- scoped id 经 `getLiveSessions`+`rawSessionId` 绑定成功的端到端用例
- `parseSessionKey` 与 `makeSessionKey` round-trip；malformed / 非 `s1.` / 未知
  profile 的拒收
- stop() 后已排入 timer 不再执行（token 守卫）
- 阶段气泡：首轮 seed 静默；同 task+phase 10s 不重弹、rapid window 可见时
  原地重写（shown 计数不变）隐藏时丢弃；gate 链 dnd/petHidden/mini/
  sleeping 逐项抑制且 working 照弹；`{phase}` 插槽 + phaseLabelKey 未知
  回退 raw；与 idle shownTasks 键独立（phase 弹过 idle 仍能弹）；
  `onPhaseTransition` 与 celebration 双通道并存断言

### 7. Wrong vs Correct

#### Wrong：把 scoped snapshot id 直接当外部记录 id

```js
const ptrPath = path.join(root, ".runtime", "sessions",
  sessionPointerKey(session.agentId, session.id) + ".json");
// session.id = "s1.cHJvZmlsZV9h.piMwMWIw..." → 文件名永不存在
// 症状：指针永不命中，UI 静默降级（chips=0），零报错零日志
```

#### Correct：注入边界先解 raw id

```js
getLiveSessions: () => snapshot.sessions.map((entry) => ({
  id: entry.id,
  rawSessionId: (parseSessionKey(entry.id) || {}).rawSessionId || entry.id,
  agentId: entry.agentId, cwd: entry.cwd,
}))
// activity 内部：sessionPointerKey(agentId, session.rawSessionId || session.sessionId)
```

#### Wrong：期待轮询能观察到归档前的 status 翻转

```js
const phase = derivePhase(taskJson.status);   // archived 后再读已无源
if (prev === "execute" && phase === "done") celebrate();
// task.py archive 删指针+移目录是一次提交 → 这个分支永不触发
```

#### Correct：归档完成 = 负空间检测

```js
// 上一轮还在绑定的任务，这一轮绑定消失且归档副本存在
for (const [dir, relPath] of taskRelPaths) {
  if (liveDirs.has(dir)) continue;
  const archivedDir = await findArchivedTaskDir(archiveRoot, basename(relPath));
  if (archivedDir) onCelebration(relPath);   // 显式 done，不依赖中间态
}
```

---

#### §4.6c 通道契约：dashboard:trellis-spec-tree / dashboard:trellis-spec-doc（7 段式，v4-a）

**1. Scope / Trigger**：Dashboard Trellis 视图「规范地图」overlay 的两个只读
一次性通道（f4bd8b82）。复刻 `dashboard:trellis-task-doc` 四层链路。

**2. Signatures**：
- activity：`readSpecTree(root)` → `{status:"ok", files:[{relPath,group}], truncated}` 或
  `{status:"missing"}`；`readSpecDoc(root, relPath)` → `{status:"ok", relPath, size,
  truncated, content}` / `{status:"missing"}`。深度帽 3、文件帽 200、大小帽复用
  `TASK_DOC_MAX_BYTES`（不新造数字）。
- main api 表：`getTrellisSpecTree/getTrellisSpecDoc`（activity 缺失 →
  `{status:"error", message:"trellis-activity-unavailable"}`）。

**3. Contracts**：
- spec-tree payload 严格单键 `{root:string}`；spec-doc 严格双键
  `{root:string, relPath:string}`，多键/少键/类型错 → `{status:"invalid"}`，
  绝不触达 fs-reading owner。
- root 必须过 `isTrustedTrellisCwd`（注册 root / 活跃 cwd / 本进程正向解析）。
- relPath 只信分段白名单：每个目录段必须出现在其父目录的**实时 listing** 里
  才继续下钻；`..`、空段、反斜杠、非 `.md`、深度溢出 → `missing`，穿越
  永远到不了 `path.join`。

**4. Validation & Error Matrix**：
- untrusted sender → `{status:"error", reason:"untrusted-dashboard-sender"}`
- payload 形状非法 → `{status:"invalid"}`
- root 未注册/非信任 → `{status:"missing"}`
- relPath 合法形状但目录里不存在 → `{status:"missing"}`（与形状错同象，安全）
- spec 目录缺失 → tree 仍 `{status:"ok", files:[]}`（空态不是错误）

**5. Good/Base/Bad Cases**：
- Good：`{root:"/proj"}` → 该 root spec 全量分组列表；点击 `guides/cross-layer-thinking-guide.md` 渲染全文
- Base：无 spec 目录的项目 → 空态文案（dashboardTrellisSpecEmpty）
- Bad：relPath `"../tasks/x/task.json"` → `missing`，无读取发生

**6. Tests Required**：
- test/trellis-activity.test.js：分组列表/隐藏文件过滤/非 md 过滤/未信任
  root/空目录容忍/穿越拒绝矩阵/只读断言（writeOps=[]）
- test/session-ipc.test.js：信任帧 + 单键/双键严格校验矩阵 + `calls==[]`
  （invalid 不触达 owner）

**7. Wrong vs Correct**：
- Wrong：`path.normalize(relPath)` 后 `startsWith("spec/")` 就读 —— normalize
  无法证明该文件在实时目录里存在，symlink/手改文件仍可逃逸
- Correct：逐段 listing 白名单 —— 文件只有在它的父目录刚刚列出它时才可读
