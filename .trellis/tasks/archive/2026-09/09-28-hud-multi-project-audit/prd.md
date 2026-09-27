# HUD 多项目缺失与过程级感知补验

## Goal

两个 HUD/Trellis 感知缺陷：① 多项目并行时展开 HUD 只显示一个项目的内容；② 已归档的「过程级感知（trellis 指令 + 当前步骤）」在真实会话中不显示。逐一定位根因、修复并补真实场景验收。

## Background（根因证据，2026-09-28 实测）

### 问题 1：HUD 展开面板单项目 —— 结构性设计限制，非数据丢失

- 面板唯一入口（trellis 图标按钮）锚定 `lastBoundExpandedSession()`（最近活跃带 cwd 会话）：`src/session-hud-renderer.js:96-106`、`731-745`
- 面板只 fetch 单个 cwd（`src/session-hud-renderer.js:48-92`）；主进程 `readHudTaskPanel(cwd)` 只扫单 root（`src/trellis-activity.js:1461-1484`）
- 另一个项目在面板中没有任何入口——09-27 hud-trellis-icon-entry 的单锚设计如此

### 问题 2：过程级感知已实现，真实会话下必现失效（三重根因，2026-09-28 逐层实测）

- 实现链条完整：`extractSessionTrace`/`readSessionTrace`（`src/trellis-activity.js:419-547`）、渲染第三行（`src/session-hud-renderer.js:152-157`）、`agentId === "claude-code"` 门与真实取值一致（`src/state.js:1150`）、pointer 在 `task.py create` 时即写 `current_task`（本会话实测存在）
- **根因 A（信号源不存在）**：`<command-name>/trellis-xxx` 痕迹在当前 Claude Code 的会话 jsonl 里根本不落盘——本会话执行 4+ 次 trellis 指令，全文件 0 条真实 command 行（`type:"user"` 行 content 为纯 STRING 文本，如「brainstorm 好像没看到」；所有 `<command-name>` 字样均在 assistant 文本 / tool_result 渲染 / `prompt_snapshot` 系统提示快照里，全是伪迹）。09-27 PRD 的「数据源 1 实测存在」与今天的可复核事实矛盾
- **根因 B（窗口不够）**：`TRACE_TAIL_BYTES = 512KB`。实测本会话 jsonl：最近真实 workflow-state 注入距文件尾 1.17MB（当时）→ 497KB（贴边）——agent 一轮大文件读取/长输出即把注入块推出窗口。ws 注入是每条用户消息必写、且唯一可用的信号源
- **根因 C（渲染门槛绑死 command）**：`src/session-hud-renderer.js:422` `if (info.command)` 是第三行的显示门槛——即使 ws 提取成功（workflowStatus/Next-Action 有值），command 为 null 时第三行整个不渲染
- 当时测试全绿：fixture 行密度失真 + 轻量轮次碰巧窗口内有痕迹；验收标准 1 从未在长 agent 轮次下人工验收（用户判断属实）

## Requirements

### R1 修复过程级感知（三根因各对症）

- **B → 阶梯扩窗**：512KB 起步，ws 信号缺失时按 1MB → 2MB → 4MB → 8MB 逐级重读，取得 workflowStatus/Next-Action 或到上限即停
- **C → 渲染门槛放宽**：第三行显示条件从 `info.command` 改为「command 或 workflowStatus/Next-Action 任一存在」；ws 分支显示「Status — Next-Action」（Next-Action 文本自带指令上下文，覆盖原「指令 + 步骤」体验）
- **A → command 提取保留但降级**：TRACE_COMMAND_RE 锚定逻辑不动（向后兼容旧版本 jsonl），不再是显示门槛；spec 记录「当前版本 jsonl 无 command 痕迹」的实测结论
- 同步修订 `.trellis/spec/guides/trellis-panel-contract.md` 的「每轮每会话 ≤512KB」IO 预算表述

### R2 HUD 展开面板分项目分节（用户已选方案 A）

- 面板列出所有已知项目的任务，每个项目一节：项目名（目录 basename）做小标题，节内 active 全量 + archived（每项目 cap 收紧，防多项目下面板过长）
- 行点击跳转用**各节自己的 cwd**（不再用面板单值 cwd）
- 项目集合与排序复用 `collectKnownRootCwds()` 信任面；锚定会话的 root 排最前

## Acceptance Criteria

1. 本仓真实会话（长轮次，jsonl >8MB、注入距尾 >512KB）执行 trellis 流程时，展开 HUD 面板 header 第三行 ≤1 个轮询周期（5s）显示 ws 状态行「Status — Next-Action」（planning 期间 Next-Action 含指令上下文）
2. fixture：真实 ws 注入块之后填充 ≥2MB tool_result 文本（assistant 行混入 `<command-name>`/`<workflow-state>` 伪迹、`prompt_snapshot` 型 attachment 混入 command 字样），断言阶梯扩窗后 ws 提取成功、伪迹仍被忽略
3. 两个项目并行会话时，展开 HUD 面板分两节显示两个项目的任务；点任一节内行跳到对应项目过滤视图
4. 全量测试与基线一致（9 个无 GUI 环境 Electron fixture 固有失败除外）；只读红线不破（扩窗仍只 open/stat/read）

## Out of Scope

- codex / pi 会话 trace（沿用原任务口径）
- 动作层 tool_use 实时流
- Dashboard 侧多项目视图（chips 已支持，本任务只管 HUD）

## Key Decisions

- R2 UX 方案 = A 分项目分节（2026-09-28 用户拍板；B 行级入口 / C 切换 chips 落选）
- R1 修复方案（2026-09-28 二轮实测后修订）：阶梯扩窗救 ws 信号 + 渲染门槛放宽为任一信号 + command 提取降级保留（当前版本 jsonl 无 command 痕迹，实测 0 条；ws 的 Next-Action 自带指令上下文，覆盖原「指令 + 步骤」体验）
- R1 上限 8MB、每项目 archived cap 等数值细节在 design.md 定稿
