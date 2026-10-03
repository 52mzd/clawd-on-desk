# Trellis channel 协作可视化（On Hold）

> **2026-09-27 搁置**：本机 `~/.trellis/channels/` 为空、channel 为 v0.6-beta 执行层能力——超前需求，暂不动工。取证成果（schema/布局/投影语义）保留在本文档，待真实使用出现后直接续。后续决策见 [[09-27-trellis-perception-deepen]]。

## Goal

把 `~/.trellis/channels/` 的多 agent 协作运行时（Trellis v0.6 channel runtime）以**纯只读**方式呈现到 clawd——当前 channel worker 对 HUD/juggling 完全不可见（juggling 只统计 live session subagent）。用户价值：桌宠/Dashboard 能"看见"多个 agent 在频道里协作的实时状态。

## 已确认事实（2026-09-27 取证，CLI 0.7.0-beta.4 / trellis-core 内嵌于 @mindfoldhq/trellis）

### 存储布局（trellis-core `dist/channel/internal/store/paths.js`）

- 根目录：`~/.trellis/channels/`（可被 env `TRELLIS_CHANNEL_ROOT` 覆盖）
- 项目桶：`<root>/<projectKey>/`，`.bucket` 标记文件；特殊桶 `_global`（scope=global）、`_legacy`（迁移遗留）、`_default`
- 频道目录：`<projectKey>/<channelName>/`，含 `events.jsonl`（追加式事件日志）、`.seq` sidecar、`<channel>.lock`、`<worker>.<suffix>` / `<worker>.spawnlock`
- **projectKey 派生**：`path.resolve(cwd)` → `\`/`/`/`_` 替换为 `-` → 其余非 `[A-Za-z0-9.-]` 替换为 `-`。**clawd 的注册 roots 可直接派生对应桶**，与现有项目筛选（§4.7 selectedRoot）天然对齐
- 频道名/worker 名安全段：`^[A-Za-z0-9._-]+$` 且非 `.`/`..`；发现扫描跳过 pre-validation 遗留目录
- 发现机制（官方同款语义）：`listProjects()`（有 `.bucket` 标记或属于 `_legacy`/`_default`/`_global` 的目录）+ `listChannelNamesInProject(project)`（含 `events.jsonl` 的 safe-name 子目录）

### 事件行 schema（`internal/store/events.d.ts`，20 kinds）

- 基底：`{seq: number, ts: string, kind, by, idempotencyKey?, to?, origin?: "cli"|"api"|"worker", meta?}` + kind 特定字段
- kinds：`create | join | leave | message | thread | context | channel | spawned | killed | respawned | progress | done | error | waiting | awake | undeliverable | interrupt_requested | turn_started | turn_finished | interrupted | supervisor_warning`
- 关键 kind 字段：`spawned{as?, provider?, pid?, agent?}`、`killed{reason?, signal?, worker?}`（reason: explicit-kill/timeout/crash/idle-timeout）、`done{duration_ms?, exit_code?}`、`error{message?}`、`turn_started{worker, inputSeq, turnId?}`、`turn_finished{worker, outcome?}`、`message{text?}`、`progress{detail?}`
- 未知 kind / 未知 reason 必须按 opaque 容忍（schema 注释明示 consumers should treat unknown reasons as opaque）

### Worker 存活投影（`internal/store/worker-state.d.ts`）

- `reduceWorkerRegistry(events)` **纯函数**，只从事件日志投影：lifecycle（`starting/running/done/error/killed/crashed`）+ activity（`idle/mid-turn`）+ `pendingMessageCount`（inbox 语义：explicitOnly / broadcastAndExplicit）——**零 pid 文件依赖**，clawd 复刻此投影即可，与 sanitize 别名表同一"Node 复刻 + 对照测试"模式
- 终态判定 `isTerminalLifecycle`；`done/error` 可为 synthesized（supervisor 合成）

### 风险/约束（既有 spec 契约）

- 本机 `~/.trellis/channels/` 当前为空——**无真实事件样本**，schema 依据是包源码 .d.ts（版本化契约！上游 0.7.x→正式版可能变；参照 trellis-panel-contract「解析外部工具的状态文件」节：解析失败先怀疑上游改契约）
- 事件日志是**写方锁定**的 append-only 文件（file lock + seq sidecar）；clawd 只读无锁，必须容忍读到半行/写入中行（JSONL 尾行解析失败静默丢弃）
- home 目录信任面是**新增**：roots store 模式（§4.5）不覆盖 home 目录扫描；但 channel store 是用户级数据、非项目内容，读它不涉及项目信任面——只需 name/路径段守卫（同 §4.3 双分隔符拆分拒绝）
- 频道事件文本（message.text）是任意内容：渲染走既有 builder/createText 白名单，零 innerHTML

## Requirements（草案，待定见 Open Questions）

1. 只读红线：新模块（暂名 `src/trellis-channels.js`）仅 readFile/readdir/stat；零写、零 spawn、零网络；不碰 `.seq`/`.lock`/`*.spawnlock`
2. 事件投影：events.jsonl 逐行 JSON.parse，坏行/尾半行静默跳过；kind 白名单外按 opaque 保留原文
3. worker 注册表：Node 复刻 reduceWorkerRegistry 语义（lifecycle/activity/pendingMessageCount），对照测试用真实事件序列 fixture
4. 项目关联：注册 roots → projectKey 派生桶 + `_global` 桶；跟随 selectedRoot 筛选（scope-following，同 §4.6c R10fix 模式）
5. 渲染：Dashboard 独立 Trellis 视图内新增分组，复用左栏分组模式（caret/折叠/懒加载/↻ 刷新）与 split 右栏详情；事件时间线与 worker 列表的具体形态见 Open Questions

## Open Questions（阻塞规划）

1. **MVP 承载面**：仅 Dashboard 分组 vs 同时上 HUD chip / 宠物行为（气泡/动画）？
2. **forum 频道**：MVP 是否只支持 chat 型时间线，forum 线程投影后置？
3. **新鲜度模型**：懒加载一次性（同 spec/network 分组）还是进入轮询（同 trellis-activity 5s/15s）？

## Out of Scope

- 任何写操作（send/spawn/kill/interrupt）——D 在 pool v6
- trellis mem——B 在 pool v6（.trellis/tasks/09-27-idea-pool-v6）
- 事件内容语义分析（只呈现不解读）
