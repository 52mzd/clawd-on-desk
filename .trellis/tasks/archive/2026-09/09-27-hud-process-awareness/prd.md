# HUD 过程级感知：trellis 指令与当前步骤

## Goal

HUD 的 trellis 感知从**状态级**（task.json 推导的 plan/execute/check/finish）升级到**过程级**：绑定会话的 HUD 详情行显示「正在执行的 trellis 指令（如 brainstorm）+ 当前步骤（如 1.1 Requirement exploration）」。用户是高频 trellis 用户，盯屏看 agent 干活时需要知道"现在在跑哪条指令"。

## 已确认事实（2026-09-27 实测本仓会话 jsonl）

- **数据源 1（指令层）**：`<command-name>/trellis-brainstorm</command-name>` 等调用痕迹随用户敲命令写入会话 jsonl；事件式但持续期天然覆盖整个执行过程（brainstorm 跑 30 分钟期间语义不变）
- **数据源 2（步骤层）**：每轮 UserPromptSubmit hook 注入 `<workflow-state>` 块（含 Status / Next-Action / Active task），只在用户发消息时刷新——agent 长自主期间冻结在上一用户轮次，这是 trellis 数据模型的固有属性，文档与 UI 文案需如实表述
- **jsonl 路径**：`~/.claude/projects/<sanitized-cwd>/<raw-session-id>.jsonl`；sanitized-cwd 规则与 trellis channel projectKey 同源（`\`/`/`/`_`→`-`，其余非 `[A-Za-z0-9.-]`→`-`）
- **关键坑**：assistant 思考文本里也含 `<workflow-state>` / command 字样（实测抓到本会话 thinking）——提取必须锚定**消息形态**（user role 消息内的 hook 注入块 / command 消息），禁止裸子串匹配（同 trellis-panel-contract「锚定形状不锚定位置」教训）
- **会话文件规模**：单会话可达 2MB+，全量读不可取——尾部扫描 N KB + 逐行 JSON.parse + 坏行跳过
- 新鲜度模型：5s 轮询（复用 trellis-activity 既有节律）；不用 fs.watch（流式追加高频事件，debounce 复杂度不值）

## Requirements

1. 绑定会话时，解析其 jsonl 尾部（N KB 帽，design 定具体值），提取：最近一次 trellis command-name + 最近一次 `<workflow-state>` 块的 Status / Next-Action
2. HUD 详情行（既有 `.trellis-detail`）在任务名/引导行之外，追加「指令 + 步骤」信息；无痕迹时静默降级为现状显示
3. 提取锚定消息形态；i18n 7 语言；详情行高度沿用 §4.1 实测回传契约
4. 只读红线：仅 readFile；IO 帽（每轮每会话 ≤ 尾部 N KB 一次读）；无 .trellis 绑定时零新增 IO
5. MVP 平台范围：Claude Code（本机 19 项目 / 94MB 真实数据）；codex（0 会话）/ pi 的 jsonl 格式后置

## 验收标准

1. 会话执行 `/trellis-brainstorm` 后 ≤ 一个轮询周期（5s），HUD 详情行显示指令名；发送新消息后 Next-Action 步骤随之更新
2. 构造含伪迹（assistant 文本里手写 `<workflow-state>` / command 字样）的 fixture，断言提取结果不受污染
3. 超大 jsonl（>2MB）下尾部扫描 IO 恒定（不随文件增长）
4. 关闭 trellis / 无绑定任务的会话，HUD 显示与现状逐字节一致
5. fake fs 写操作计数恒 0；i18n 7 语言键集一致

## Out of Scope

- 动作层 tool_use 实时流（二期评估）
- codex / pi 会话格式
- workflow-state 块内容的语义解读（只透显 Status/Next-Action 文本）

## Open Questions

无阻塞项。技术细节（尾部 KB 帽、workflow-state 块解析从 `.trellis/workflow.md` 的 `[workflow-state:*]` 模板取证、HUD 详情行文案形态）在 design.md 定。
