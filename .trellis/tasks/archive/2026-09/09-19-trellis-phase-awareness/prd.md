# Trellis 流程感知：HUD 阶段徽标 + 桌宠跃迁动画

## Goal

让 Clawd 感知 Trellis 工作流的实时状态：当前 AI 会话绑定的是哪个 Trellis 任务、处于哪个阶段（Phase 1 Plan / Phase 2 Execute / Phase 3 Finish）、任务进度如何；并在桌宠 HUD 与桌宠动画上呈现——HUD 行内展示阶段徽标与进度，桌宠在阶段跃迁时播放一次性的庆祝/提示动画。

## 背景事实（已验证）

- **会话↔任务绑定真相**：`<project>/.trellis/.runtime/sessions/<TRELLIS_CONTEXT_ID>.json`，字段 `{ platform, last_seen_at, current_task, current_run }`。`task.py start` 写入；hook 未注入 session 身份时降级不写（指针缺失≠无任务）。
- **任务真相**：`<task-dir>/task.json`，字段含 `status`（`planning` / `in_progress` / `completed`…）、`title`、`subtasks[]`、`createdAt` 等。
- **阶段真相**：无直接落盘字段。阶段由"任务 status + 规划产物存在性（prd/design/implement.md）+ 归档状态"推导（`workflow_phase.py` 即此逻辑，供 agent 上下文用）。Clawd 侧需用 Node 只读复刻该推导，不 spawn Python。
- **参照项目 trellis-card**（czm15053/trellis-card，Tauri+Rust）：hook 从 cwd 路径段提取 task id、快照写 inbox、工具调用映射活动流。其"绑定"机制已由本项目自有 `.runtime/sessions` 取代，不照搬其 IPC。
- **Clawd 侧宿主事实**：Session HUD（`src/session-hud.js` + renderer）已按行展示 live session（含 badge/图标/别名/点击跳转终端）；桌宠状态机（`src/state.js`）已有 thinking/working 等状态与一次性动画切换机制（swapToken）。

## Requirements

### R1 会话 → Trellis 任务绑定（只读）

- 对 HUD 中每个 live session，从其 cwd 向上找 `.trellis/` 根（限有界深度，遵循"路径只读、不写"）。
- 在该根下读 `.runtime/sessions/*.json`，按 `platform` 与会话身份/最近活跃度对齐到当前会话，得到 `current_task`。
- 无 `.trellis/`、无 session 文件、指针缺失或不可读 → 该行不显示 Trellis 信息（降级，不报错）。绑定歧义（多文件无法区分）时保守显示项目级任务摘要而非错误归属。
- **精确对齐规则（含 Clawd 会话 id 与 `TRELLIS_CONTEXT_ID` 是否同源）在 design 阶段实测后固化。**

### R2 阶段与进度展示（HUD 行内）

- HUD 每行新增阶段徽标：`Plan` / `Execute` / `Finish` / `Done`（+ 可选数字细分，如 `1.1 PRD`），由 Node 只读推导（R1 数据 + 产物文件存在性 + `task.json` status）。
- 进度呈现：任务级（subtasks 完成计数或产物里程碑），不逐字解析 `implement.md` checkbox（成本高、易碎）；具体口径 design 定案。
- 折叠/展开行为沿用 HUD 现有形态；阶段徽标不改变现有行的点击跳转语义。
- **点击徽标跳任务**：点击阶段徽标触发终端聚焦/跳转到该任务所属会话（复用 HUD 现有点击跳转与 terminal focus 机制；不打开文件管理器、不 spawn 进程）。
- i18n：新增文案覆盖 7 语言全集（en/zh/zh-TW/ko/ja/pt-BR/es，无 zh-CN）。

### R3 桌宠阶段表现（跃迁动画 + 阶段化身）

- **跃迁动画**：桌宠在阶段跃迁点播放一次性动画（如：进入 Execute=开工动作、任务完成=庆祝、Finish 提交=小憩），利用现有一次性动画机制，不改 `REQUIRED_STATES` 契约（主题缺失时优雅降级为普通状态动画）。
- **阶段化身（配件映射）**：各阶段给桌宠佩戴对应配件——Plan→wizard-hat（思考帽，资产已有）、Finish/Done→party-hat（庆祝帽，资产已有）、Execute 沿用 working 动画。配件系统沿用现有 accessories 机制，仅新增映射表。
- **归档庆祝**：绑定的任务归档（阶段跃迁至 Done/archive）时播放一次性庆祝（party-hat + double-jump 类既有资产）。
- 跃迁判定以"会话绑定的任务阶段发生变化"为准；抖动抑制（同任务内反复切换不连播，最短间隔 design 定案）。
- 不新增弹窗、不抢焦点、不发声（遵循桌宠既有约束）。

### R3.1 多任务杂耍动画

- 同一项目（或同一 HUD 视野）内绑定 ≥2 个并行 in_progress Trellis 任务时，working 状态优先使用 `clawd-working-juggling.svg`（资产已存在）。
- 仅一个任务或主题缺该资产时保持现状（普通 working 动画）。

### R4 数据流与性能

- 阶段/绑定数据由主进程轮询或文件事件驱动刷新（选型在 design 定案），刷新不阻塞 UI。
- 只读：Clawd 绝不写 `.trellis/` 下任何文件（含 `.runtime/`）。
- 无 Trellis 项目在跑时零开销（不轮询无 `.trellis` 根的会话）。

### R5 Settings 面板联动（最小）

- 现有 Trellis tab 的项目行可显示"活跃任务 + 阶段"摘要（复用同一数据源），无则不显示。

## Constraints

- **只读边界**：不写 `.trellis/`、不 spawn `python3`、不注册新 hook。
- 兼容 trellis 降级模式（session 指针缺失）与多项目并行会话。
- 遵循 HUD 既有数据契约与 `state.js` snapshot 消费者边界（改字段需检查所有消费者）。
- 桌宠动画遵循主题状态契约（REQUIRED_STATES 不可加、可选能力缺失需降级）。
- 遵循 prefs/controller/settings 既有链路与 i18n parity 测试。

## Acceptance Criteria

- [ ] 在含 `.trellis` 的项目里启动 AI 会话并 `task.py start` 后，HUD 该会话行显示 Trellis 任务名与阶段徽标，与 `task.json` status / 产物文件一致。
- [ ] 阶段推进（如补齐 design.md → 进入 implement 阶段；`task.py start` → Execute）后，徽标在无需重启 Clawd 的情况下更新。
- [ ] 桌宠在任务完成（阶段跃迁至 Finish/Done）时播放一次庆祝类动画；主题无该能力时回落普通动画，无报错。
- [ ] 无 `.trellis` / 指针缺失 / 文件损坏三种情形下 HUD 正常渲染，无错误弹窗、无控制台异常。
- [ ] Clawd 全程未写 `.trellis/` 下任何文件（`shasum`/mtime 对比验证）。
- [ ] 新增文案 7 语言齐全（i18n parity 测试通过）。
- [ ] HUD 现有功能（badge、折叠、点击跳转、别名）回归无损。

## Open Questions（design 阶段定案）

- Q1 Clawd 会话 id 与 `TRELLIS_CONTEXT_ID` 的对齐规则（同源直接匹配？platform+cwd+last_seen_at 启发式？）。
- Q2 阶段推导的精确规则表（status × 产物存在性 → 徽标值）。
- Q3 刷新机制：fs.watch `.trellis/.runtime/sessions/` + `tasks/`（事件驱动）vs 有界轮询。
- ~~Q4 跃迁动画资源~~ → **已定（用户确认）：复用现有主题资产**（wizard-hat / party-hat / double-jump / juggling），不新增能力字段、不改 REQUIRED_STATES。

## Notes

- 参照 trellis-card 的产品形态（任务卡片 + 活动流 + 阶段进度），但数据通道完全采用本项目自有 `.trellis` 只读真相，不引入其 hook/IPC 设计。
- 本任务与已归档的 09-18-clawd-trellis-integration（版本巡检面板）共享 Trellis 生态语境但相互独立；R5 仅做最小联动。
- **创意池（brainstorm 收敛后明确留给后续任务，本任务不做）**：任务卡片气泡（idle 时 thought-bubble 闪现任务名）、Dashboard Trellis 任务页（trellis-card 核心形态）、"下一步" workflow 引导提示、Trellis 日报（recap 联动，需审 recap 红线）、活动流（需 hook，违反只读边界，远期）。
