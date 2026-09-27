# Design：HUD 过程级感知（trellis 指令与当前步骤）

## 1. 架构与数据流

三层，全部在既有链路内扩展，不新建模块/通道：

```
~/.claude/projects/<sanitized-cwd>/<rawSessionId>.jsonl   （Claude Code 会话日志，只读）
  │  readTail(filePath, TRACE_TAIL_BYTES)                  （注入的尾部读 helper，见 §2.3）
  ▼
trellis-activity.js  readSessionTrace(cwd, rawSessionId)   （新内部函数）
  │  → { command, workflowStatus, workflowNextAction }     （锚定形状提取，见 §2.1/2.2）
  │  挂接点：既有轮询循环内，绑定任务的会话 → TrellisInfo 扩展三字段
  ▼
TrellisInfo = { taskPath, title, phase, progress, parallelCount, nextStep?,
                command?, workflowStatus?, workflowNextAction? }   （缺省 = 不渲染）
  ▼
session-hud-renderer.js 详情行：任务名 + 引导行 + 「指令 · 步骤」行（i18n 7 语言包裹）
```

## 2. 数据契约

### 2.1 提取锚定（Measured on Claude Code 2026-09-27，本仓 f0fb3c8b 会话实测）

- **指令层**：行 `type === "user"`，`message.content` 数组项的 `text` 含
  `<command-message>trellis-xxx</command-message>\n<command-name>/trellis-xxx</command-name>`。
  取 `<command-name>` 的值，剥 `/trellis:` 或 `/trellis-` 前缀得短名（如 `brainstorm`、`continue`、`finish-work`）。
- **步骤层**：行 `type === "attachment"`，`rendered` 数组项的 `content` 字符串以
  `<system-reminder>\nUserPromptSubmit hook additional context: <workflow-state>` 开头。
  块内取 `Status: <STATUS>` 行 + 其后的 `Next-Action:` 行文本。
- **污染防线（关键）**：assistant 行的 thinking/text 同样可能含 `<workflow-state>` / `<command-name>`
  字样（实测抓到本会话 thinking）。因此提取**只接受上述两种消息形态**，绝不做全文件裸子串匹配——
  同 trellis-panel-contract「锚定形状不锚定位置」教训。
- STATUS 枚举（.trellis/workflow.md 120-131 行，唯一定义处）：`no_task / task_error / planning /
  planning-inline / in_progress / in_progress-inline / completed`。HUD 不复述枚举语义，只透显。

### 2.2 尾部扫描算法

```
readTail(path, 512KB)：fs.open → stat 得 size → read(max(0, size-512KB) 起) → close。
  字节窗口按 "\n" 切行后【丢弃第一段】（可能是写入中的半行），其余段为完整行。
  每行先 substring 预筛（含 '"type":"attachment"' 或 '<command-name>' 或 '"type":"user"'），
  命中才 JSON.parse；parse 失败跳过。
  逆序取：最近一次 workflow-state attachment + 最近一次 trellis command。
```

- `TRACE_TAIL_BYTES = 512KB`：attachment 每用户轮 1 条（~600B），512KB 覆盖数百轮；
  command 调用若落在窗口外 → `command: null` → 渲染降级（PRD 已声明此边界）。
- CPU：预筛把 JSON.parse 限制在极少数行；512KB 字符串扫描 5s 一次 × 绑定会话数，可忽略。

### 2.3 注入面

`createTrellisActivity({ ..., readTailImpl? })`——可选注入，缺省实现用 Node `fs/promises`
（open/read/close，只读）。main.js 无需显式传；测试 fake `readTailImpl` 断言 IO 恒定。
只读红线不变（open+read 无写）；spec §D7 的能力面表述（readFile/stat/readdir only）随本任务更新为
含「尾部读」。

### 2.4 路径推导与平台范围

- `~/.claude/projects/<sanitized-cwd>/`：cwd 经 `\`/`/`/`_` → `-`、其余非 `[A-Za-z0-9.-]` → `-`
  （与 trellis channel projectKey 同源的 Claude Code 惯例，本仓实测路径吻合）。
- 文件名 = `rawSessionId + ".jsonl"`——activity 已持有（双源契约的解出值）。
- **MVP 仅 claude**：`session.agentId` 为 claude 系才扫（其他平台 jsonl 格式不同，PRD 已出范围）。
- 文件不存在（ENOENT）→ 三字段全 null，零报错。

### 2.5 轮询与缓存

- 挂在既有 5s（活跃）/15s（退避）轮询：仅对**已绑定 trellis 任务**的会话扫（复用绑定集合）；
  per-round 每会话一次（同 taskReads 缓存模式）；无绑定时零新增 IO。
- TrellisInfo 三字段缺省（undefined）= 渲染层跳过——旧快照消费方（Dashboard 面板等）向后兼容。

## 3. HUD 渲染

- 详情行（既有 `.trellis-detail`）在任务名/引导行后追加一行：
  `⌘ brainstorm — <Next-Action 文本（截 80 code points，surrogate-safe）>`。
- i18n：新增 `sessionHudTrellisCommand`（"正在执行 {command}" 族，7 语言）；Next-Action 原文透显
  （它是 workflow.md 的本地文本，不翻译）。
- 高度契约沿用 §4.1 实测回传（新行由弹性高度机制自动容纳，无需改 computeHudHeight）。

## 4. 风险与回滚

| 风险 | 缓解 |
|---|---|
| attachment/command 格式是 Claude Code 私有（版本化契约） | 提取失败/形态漂移 → 全 null 静默降级；spec 记录 Measured on 日期与实测文件 |
| 会话文件被轮转/清理 | ENOENT → null |
| readTail 阻塞轮询（磁盘慢） | 512KB 上限 + 逐行预筛；实现放轮询的 await 链内与既有 readFile 同待遇 |
| 回滚 | 改动集中在 trellis-activity.js / session-hud-renderer.js / i18n，revert 单提交即可 |
