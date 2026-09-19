# 执行计划 — Trellis 流程感知

依赖：阶段 1 → 2 串行（activity import phase）；阶段 3 依赖 2；阶段 4、5 可并行；阶段 6 依赖全部。
每阶段验证独立可定位，不用"整体 npm test"代替阶段验证。

---

## 阶段 0 — 前置检查（只读确认，答案写回本文件）

- [ ] **A** 读 renderer/preload 的 `mini-clip` 通道定义：确认是否 mini-mode 专用；若通用，跃迁动画改走它（更轻，不动状态机）
- [ ] **B** 定位 HUD 渲染层 i18n 字典文件与 `sendI18n` 载荷形状；确定阶段徽标文案 7 语言的落点
- [ ] **C** 逐 agent 核对 sessionId → sanitize key 匹配：至少 claude / codex / pi 三个真实会话，把「Clawd sessionId、Python 生成的指针文件名、Node 复刻结果」三元组写进测试 fixture
- [ ] **D** 抄全 `_CONTEXT_KEY_PLATFORM_ALIASES`（逐条，含注释里的审计说明），确定 Node 版表内容与 Clawd agentId 的对应
- [ ] **E** 读 `claude-settings-watcher.js` 的自调度 setTimeout + lifecycleToken 骨架（L286-299、L575-621），阶段 2 照抄

**验证**：结论写入本文件末尾；C 项三元组直接成为 `test/trellis-phase.test.js` 的 fixture 数据。
**回滚点**：无改动。

---

## 阶段 1 — 纯逻辑层（零 IO）

- [ ] 新建 `src/trellis-phase.js`
  - `sanitizeKey(raw)`（复刻 `_sanitize_key`：`[^A-Za-z0-9._-]+`→`_`、strip `._-`、截 160）
  - `PLATFORM_ALIASES`（阶段 0-D 抄全）+ `trellisPlatformFor(agentId)`
  - `sessionPointerKey(agentId, sessionId)`
  - `derivePhase({ status, hasPrd, isArchived })` → 按 design D2 表
  - `deriveProgress(taskJson)` → `{done,total} | null`（无 subtasks 或全空 → null，禁 0/0）
- [ ] 新建 `test/trellis-phase.test.js`
  - **对照测试**：阶段 0-C 的三元组（真实指针文件名 vs Node 复刻输出）逐条断言
  - 阶段表全分支 + 未知 status → null；sanitize 特例（空、纯符号、超 160、`.` 开头）
  - 别名表逐条（agentId → platform，未知 agentId → null）

**验证**：`node --test test/trellis-phase.test.js`
**回滚点**：删两文件。

---

## 阶段 2 — activity owner（注入 fake fs/timer）

- [ ] 新建 `src/trellis-activity.js`，导出 `createTrellisActivity({ state, fs, now, setTimeoutFn, onTrellisUpdate, onCelebration })`
  - 自调度 setTimeout 轮询（照阶段 0-E 骨架，禁 setInterval），lifecycleToken 守卫 `start()`/`stop()`
  - 每轮：live session 快照 → 定位 `.trellis` 根（≤8 层向上）→ 精确 key 匹配 → 退化匹配（单文件 + <30min）→ 读 task.json + 产物 stat → 组装 `TrellusInfo` 缓存
  - 门控退避：无可绑定会话 → 周期 15s；有 → 5s
  - diff 检测：缓存变更非空才调 `onTrellisUpdate(changedSessionIds)`
  - 跃迁史 `Map<taskPath, phase>`：→ finish/done 跃迁调 `onCelebration(taskPath)`，同 task <10s 抑制
  - **只读**：仅 readFile/stat/readdir；任何写方法不得出现
- [ ] 新建 `test/trellis-activity.test.js`
  - fake fs 造 `.trellis` 树：指针命中 / 缺失 / 损坏 JSON / 多文件歧义
  - 门控：无 trellis 会话时零 IO 且退避；会话出现后恢复 5s
  - 跃迁：planning→in_progress 不触发庆祝；→completed 触发一次；10s 内重复不重播
  - **只读断言**：整轮前后 fake fs 写操作计数 = 0
  - stop 后排入的轮次不再执行（lifecycleToken）

**验证**：`node --test test/trellis-activity.test.js`
**回滚点**：删两文件。

> **REVIEW GATE 1**：阶段 1-2 全绿后向用户汇报对齐规则实测结果（三元组）与跃迁语义，确认后进入接线。

---

## 阶段 3 — snapshot 透传 + HUD 徽标

- [ ] `src/state-session-snapshot.js`：`options.trellisResolver` + entry `trellis` 字段（照 `contextUsage` L399 写法）
- [ ] snapshot 透传测试（扩既有 snapshot 测试文件或新建）：resolver null → 字段 null；resolver 值 → 原样透传；**旧调用（无 resolver）不崩**
- [ ] `src/session-hud-renderer.js`：行内徽标渲染
  - 徽标 = 小圆角标签（`plan/execute/finish/done` 四态样式）+ `title`（悬浮 tooltip 任务名）+ `n/m`（progress 非空时）
  - 并行计数 >1 时徽标后附 `×N`
  - 点击徽标 → 复用该行既有点击跳转 handler（不新增 focus 通道）
  - null → 不渲染该元素，行布局不变
- [ ] HUD i18n：阶段 0-B 定位字典后补 7 语言（en/zh/zh-TW/ko/ja/pt-BR/es）
- [ ] `src/main.js`：组装 trellis-activity → trellisResolver 注入 snapshot 构建路径 → `onTrellisUpdate` 走既有「重建 snapshot → latestSnapshot → sendSnapshot()」

**验证**：`node --test test/state-session-snapshot*.test.js test/session-hud*.test.js test/i18n.test.js`
**手工**：真实 trellis 项目里 `task.py start` 后 HUD 行 5s 内出现徽标；`task.py archive` 后变 done。
**回滚点**：还原 4 处修改。

---

## 阶段 4 — 跃迁动画

- [ ] 按阶段 0-A 结论落点：
  - mini-clip 通用 → `onCelebration` 直接发一次性 clip
  - 否则 → 状态机一次性状态入口（照 jumping-once 全链路，含 DND/petHidden 门槛与 swapToken 竞态防护）
- [ ] 主题缺资产静默跳过（沿用可选能力降级路径，不改 REQUIRED_STATES）
- [ ] 测试：跃迁触发一次、抑制窗口、DND/petHidden 不播（可注入 fake）

**验证**：`node --test test/<动画落点相关>.test.js`
**手工**：真实项目完成任务归档 → 桌宠播庆祝一次；反复归档不连播。
**回滚点**：摘掉 onCelebration 接线（阶段 3 不受影响）。

---

## 阶段 5 — Settings 联动（R5）

- [ ] `src/trellis-activity.js` 暴露 `getByProject(projectPath)`
- [ ] `src/settings-tab-trellis.js`：项目行追加「活跃任务 + 阶段」摘要（scan 返回后读缓存渲染；无则不显示；7 语言）
- [ ] 测试：tab 测试扩 2 例（有/无活跃任务）

**验证**：`node --test test/settings-tab-trellis.test.js test/i18n.test.js`
**回滚点**：还原 tab 与 getter。

---

## 阶段 6 — 集成与真机验证

- [ ] `npm test` 全量（对照基线失败集合，零新增）
- [ ] 手工验收（对照 prd AC）：
  - [ ] trellis 项目会话行徽标与 task.json status / 产物一致
  - [ ] 阶段推进（补 design.md、task.py start、archive）徽标 5s 内自动更新，无需重启
  - [ ] 归档 → 桌宠庆祝动画一次；缺资产主题回落无动画无报错
  - [ ] 无 .trellis / 指针缺失 / json 损坏 → HUD 正常，无控制台异常
  - [ ] **shasum + mtime 对比整轮轮询前后 `.trellis/` 不变**
  - [ ] i18n 7 语言无裸露 key
  - [ ] HUD 既有功能（badge/折叠/跳转/别名）回归无损
- [ ] 真机多 agent 抽查（阶段 0-C 三元组之外的 agent 至少 1 个）

**验证**：`npm test`
**回滚点**：整体还原。

---

## 阶段 7 — 收尾

- [ ] `.trellis/spec/` 补沉淀（只读边界、sanitize 对照测试模式）
- [ ] 文档：README 功能列表或 docs/guides 补一句
- [ ] commit（仓库风格）

---

## 前置检查结论

（2026-09-19 阶段 0 只读检查完成，除本节外零改动）

### A — `mini-clip` 是 mini-mode 专用裁剪通道，与动画无关

`src/mini.js` L284-300 发送 `mini-clip`（载荷 `{fraction, edge}` 或 `null`），`src/renderer.js` L1300-1315 消费为 `clipPath: inset(...)`——它是 mini 模式贴边时的**视觉裁剪** inline style，不是动画播放通道（`src/main.js` L1661-1665 也只用于 renderer 重载后补发裁剪状态）。

**结论：阶段 4 跃迁动画走状态机一次性状态入口（jumping-once 模式全链路），不使用 mini-clip。**

### B — HUD i18n 落点：`src/i18n.js` 扁平 key × 7 语言

- 字典：`src/i18n.js` 单文件、扁平 key，HUD 现有 key 用 `sessionHud*` 前缀（en 版 L212-220）；en/zh/zh-TW/ko/ja/pt-BR/es 七语言同文件。
- 载荷与通道：`sendI18n()`（`src/session-hud.js` L630-643）→ `ctx.getI18n()` → `getDashboardI18nPayload()`（`src/main.js` L696-699）→ `{ lang, translations: {...i18n[lang]} }`，经 `session-hud:lang-change` 通道下发；renderer 初始经 `sessionHudAPI.getI18n()` 拉取（`src/session-hud-renderer.js` L503），变更监听 L495。

**结论：阶段徽标文案以 `sessionHudTrellisPhase*` 前缀 key 加进 `src/i18n.js` 七语言块，无需动通道与载荷形状。**

### C — sessionId → 指针文件名三元组

| Agent | Clawd sessionId 形态（来源） | Python 指针文件名 | 证据级别 |
| --- | --- | --- | --- |
| pi | `pi:01a0b040-370d-70b0-8e1a-9c8626dfd17e`（`hooks/pi-extension-core.js` L109 `${PI_AGENT_ID}:${id}`） | `pi_01a0b040-370d-70b0-8e1a-9c8626dfd17e.json`（本仓库 `.trellis/.runtime/sessions/` 实存，`TRELLIS_CONTEXT_ID` 同值） | **真机** |
| claude | `6218983c-1109-4a8d-8fde-a9b121655801`（`hooks/clawd-hook.js` L564 原样上报，无前缀） | `claude_6218983c-1109-4a8d-8fde-a9b121655801.json`（`~/Downloads/jianlairpg/.trellis/.runtime/sessions/` 实存） | **真机** |
| codex | `codex:<thread-uuid>`（`agents/codex-log-monitor.js` L836/L1208、`hooks/codex-hook.js` L438 `normalizeCodexSessionId`；thread uuid 形态经 `_extractSessionId` L1826-1834 确认） | `codex_<uuid>.json`（按 `_context_key("codex","session",uuid)` 推导） | 推导（无真机指针） |

Node 复刻输出与上述文件名逐条一致（已固化为 `test/trellis-phase.test.js` 断言）。

**关键发现：Clawd 侧 sessionId 带 namespace 前缀**——codex/pi/qoder/zcode/qwenwork 等上报 `<agentId>:<raw>`，而 trellis 指针文件名存 raw id。`sessionPointerKey` 必须先剥 `<agentId>:` 前缀，且只剥等于自身 agentId 的前缀（claude 等无前缀 agent 不误剥）。

sanitize 边界值已用 `python3` 实测 `_sanitize_key` 对照（空串、纯符号、首尾空白、`._-` strip、重音/emoji、连续非法、截断顺序），结果固化进测试断言。

### D — `_CONTEXT_KEY_PLATFORM_ALIASES` 与 Clawd agentId 对应

`active_task.py` 原表（仅两条，context-key 构造时应用）：

```python
_CONTEXT_KEY_PLATFORM_ALIASES = {
    "zcode": "claude",   # ZCode reuses Claude's session env var name → 同一 runtime 文件名
    "factory": "droid",  # Factory Droid 配置目录是 .factory/，hook 可能按目录名报 factory
}
```

另有 `_ENV_PLATFORM_ALIASES`（仅 env 查找用）：`claude-code→claude`、`factory→droid`、`factory-ai→droid`、`github-copilot→copilot`。`_KNOWN_PLATFORMS`（16 项）：claude, codex, cursor, opencode, gemini, droid, qoder, codebuddy, kiro, copilot, pi, trae, grok, kimi, zcode, snow。

Node 版 `PLATFORM_ALIASES`（Clawd agentId → 指针文件名 platform 前缀，12 条）：

| Clawd agentId | 前缀 | 依据 |
| --- | --- | --- |
| `claude-code` | `claude` | 名字不同（`_ENV_PLATFORM_ALIASES` 同款归并） |
| `codex` / `opencode` / `qoder` / `codebuddy` / `pi` | 同名 | `_KNOWN_PLATFORMS` 直接成员 |
| `copilot-cli` | `copilot` | 名字不同 |
| `gemini-cli` | `gemini` | 名字不同 |
| `cursor-agent` | `cursor` | 名字不同 |
| `kiro-cli` | `kiro`、`kimi-cli` → `kimi` | 名字不同 |
| `zcode` | **`claude`** | 两跳：platform `zcode` 经 `_CONTEXT_KEY_PLATFORM_ALIASES` 归并为 `claude`（指针文件名为 `claude_<id>.json`） |

不映射（`trellisPlatformFor` → null，保守）：`antigravity-cli`、`qwen-code`、`codewhale`、`mimocode`、`openclaw`、`hermes`、`reasonix`、`qoderwork`、`qwenwork`、`workbuddy`、`traecode`（trellis 有 `trae` platform 但与 Trae CN 的对应无证据）、`grok-build`（trellis 有 `grok` platform 但无对应证据）、`deepseek-harness`。待真机指针出现再逐条补，不类比推断。

### E — `claude-settings-watcher.js` 自调度骨架（阶段 2 照抄）

- L219-220：注入 `setTimeoutFn` / `clearTimeoutFn`
- L246：`lifecycleToken = 0`
- L279-284：`clearHealthTimer()`
- L286-299：`scheduleHealthCheck(delayMs, reason)`——先清旧 timer → 捕获 `tokenAtSchedule = lifecycleToken` → 回调内 `if (tokenAtSchedule !== lifecycleToken) return;`
- L345-356：`runHealthCheck` 内 `tokenAtStart` 捕获 + `checkInFlight` 防重叠 + 末尾 token 比对通过才 reschedule
- L556-578：`stop()` **先 `lifecycleToken++` 再清 timer**（已入队回调比对 token 后变 no-op）
- L580-615：`start()` bump token → 种子基线 → 首轮 schedule

附带事实：归档目录是 `.trellis/tasks/archive/`（isArchived 判定依据）；本任务 `task.json` 实测 `status: "in_progress"`、`subtasks: []`（`subtasks[].status` 完成值按 trellis 惯例取 `completed`）。

## REVIEW GATE 结论

### 独立质检（trellis-check）后修复

无阻断项。全量回归与本任务前基线一致（`session-renderer-behavior` 10 失败在 stash 我的改动后同样存在，属环境性预存失败）。

真机验证（dev Electron + CDP，真实 pi 会话）发现并修复了一个接线缺陷：

- **症状**：HUD 出现 pi 会话行但 chips=0，`getTrellisInfo` 恒 null。
- **根因**：main.js 的 `getLiveSessions` 从 snapshot 取的 `entry.id` 是 **scoped key**（`s1.<b64-profile>.<b64-raw-id>`，见 `src/session-key.js` `makeSessionKey`），而 trellis 指针文件名存的是 **raw id**（`pi:<uuid>`）。`sessionPointerKey("pi", "s1.xxx.yyy")` 剥不掉前缀，sanitize 出的文件名永远不匹配。
- **修复**：
  1. `src/session-key.js` 新增导出 `parseSessionKey(key)`（`makeSessionKey` 的逆：校验 `s1.` 版本、 base64url 解码 profile/raw，profile 非法则 null）；
  2. `src/main.js` 组装 `getLiveSessions` 时用 `parseSessionKey(entry.id).rawSessionId` 解出 raw id 传入；
  3. `src/trellis-activity.js` `collectLiveSessions` 接受 `rawSessionId`（缺省回落 entry.id），`sessionPointerKey` 改用 raw id。
- **回归测试**：`test/session-key.test.js` 加 2 用例（round-trip + 拒 malformed）；`test/trellis-activity.test.js` 加 1 用例（scoped id 经 getLiveSessions+rawSessionId 绑定成功）。
- **真机复验**：修复后 pi 会话行渲染出 4 个 trellis 元素（徽标文本 `Execute ×2`），截图存证；`.trellis/` 树 shasum 前后对比零写入（仅任务自身文件变化）。

### 阶段 4 — 跃迁动画（已完成，2026-09-19）

- 摸底结论：所谓 "jumping-once 一次性状态" 的 proven 链路实际是 **reaction 通道**：主进程 `requestClickReaction(file, duration)`（main.js，内含 `collectRequiredAssetFiles` 主题资产检查，缺资产返回 null 静默）→ displayed-visual projection（`source: "reaction"`，generation/竞态防护）→ `sendRawToRenderer("play-click-reaction", payload, duration)` → renderer `playReaction`（swapToFile 自播 → duration 后 `endReaction` → `resumeFromReaction` 回落）。4 连击 double 反应（`clawd-react-double.svg` / `-double-jump.svg`）正是走它。
- DND 门槛在 hit-renderer 的 `canPlayReactionNow()`（renderer 侧，只挡用户点击）；主进程侧主动下发需自带门槛。
- 落地：新建 `src/trellis-celebration.js`（纯决策层，deps 注入）：门槛 = DND / `petWindowRuntime.isPetEffectivelyHidden()` / `_mini.getMiniMode()`；资产 = 主题 `reactions.double`（files 池随机/file 回退，默认 duration 3500，与 hit-renderer 连击同口径）；Calico/Cloudling 无 double → 静默不播（可选能力降级，不改 REQUIRED_STATES）。资产存在性不重复检查——入口 `requestClickReaction` 已拒缺资产文件。
- main.js 组装 `createTrellisActivity` 时传 `onCelebration: createTrellisCelebration({...})`；抑制窗口（同 task <10s）与→finish/done 才触发的语义在 trellis-activity 既有测试覆盖。
- 测试：`test/trellis-celebration.test.js` 10 例（门槛×3、资产缺失×2、入口拒收、抛错不炸、正常派发、pick 纯函数）。

### 阶段 5 — Settings 联动（已完成，2026-09-19）

- **数据通道选型：并进既有 `settings:trellis-scan` 返回载荷**（未新增 IPC 通道）。理由：Settings tab 只信任 `settingsAPI.trellis*` 既有通道（过 isTrustedEvent 门禁）；scan 是 tab 打开/刷新时的既有数据源，摘要随行最自然；session-snapshot 通道按 per-session 组织、Settings 不消费，塞项目级摘要会破坏 snapshot 合约。
- `src/trellis-activity.js`：`getParallelCount` 升级为 `getRootSummary`（同一批 readdir+task.json 读，产出 `{count, activeTasks:[{title,phase}]}`，同 30s TTL 缓存，零新增 IO）；新增 `getByProject(projectPath)` 纯缓存读（root 从未轮询/无活跃任务/stop 后 → null）。活跃任务的 phase 无需 hasPrd stat（in_progress→execute、planning→plan 无歧义）。
- `src/trellis-ipc.js`：`withActiveTasks` 把 `{title, phase}` 投影附加到 scan 返回的 `project.activeTasks`；getter 缺失/null/抛错/畸形 → 行对象原样（tab 渲染与之前完全一致）。
- `src/settings-tab-trellis.js`：项目行 `text` 追加一行 `row-desc` 摘要（`trellisActiveTasks` 模板 + phase 标签），无则不渲染。
- i18n：`src/settings-i18n.js` 7 locale 各 +5 key（`trellisActiveTasks` + `trellisPhasePlan/Execute/Finish/Done`，phase 词与 `src/i18n.js` 的 `sessionHudTrellisPhase*` 同源对齐）。
- 验证：trellis-activity 34、trellis-ipc 27、settings-tab-trellis 21、i18n parity（45 含 tab）、state 352，全部 0 fail。
