# Design：HUD 多项目分节 + 过程级感知阶梯扩窗

## 架构与边界

两个改动都落在既有链路上，不新增 IPC 通道、不新增文件：

```
R1（trace 扩窗）  ~/.claude/projects/<dir>/<id>.jsonl
                    └─ readTail + extractSessionTrace（src/trellis-activity.js，主进程侧改）
R2（多项目面板）  readHudTaskPanel（src/trellis-activity.js）
                    └─ main.js handler（session-hud:trellis-panel）
                    └─ session-hud-renderer.js createTrellisPanel（分节渲染）
```

## R1：阶梯扩窗 + 渲染门槛放宽 + command 降级

**现状**：`readSessionTrace`（trellis-activity.js:519-547）单次 `readTail(file, 512*1024)`；渲染第三行以 `info.command` 为门槛（session-hud-renderer.js:422）。

**实测结论（2026-09-28，本会话 jsonl 8.9MB）**：当前 Claude Code 的 jsonl 不落盘 command 痕迹（user 行 content 为纯 STRING；`<command-name>` 字样仅在 assistant 文本 / tool_result 渲染 / `prompt_snapshot` 附件里，全是伪迹）；ws 注入块（attachment + `rendered[].content`）是每条用户消息必写、唯一可靠的信号源，且会被长轮次推出 512KB 窗口。

**改动 1（B：阶梯扩窗，`readSessionTrace` 内，无新抽象）**：

```js
const TRACE_TAIL_STEPS = [512, 1024, 2048, 4096, 8192]; // KB，阶梯
for (const kb of TRACE_TAIL_STEPS) {
  const tail = await readTail(file, kb * 1024);
  const trace = extractSessionTrace(dropFirstHalfLine(tail));
  if (trace.workflowStatus || trace.workflowNextAction) return trace; // ws 命中 → 停
  if (trace.command) return trace; // command 命中（旧版本 jsonl）→ 停
  continue; // 全空 → 扩窗
}
return null;
```

- 停止条件以 ws 为主信号：command 与 ws 若同时存在必在同轮（相邻行），不存在「ws 在窗口内而 command 在窗外」的常态分离；部分信号即停，避免无谓读满 8MB
- 最常见路径（注入块在 512KB 内）仍是一次读；全空才扩，每级重读整个尾部（无增量缓存，KISS）

**改动 2（C：渲染门槛，`session-hud-renderer.js:416-426`）**：

```js
// 门槛：任一过程信号存在即显示第三行
if (info.command || info.workflowStatus || info.workflowNextAction) {
  let commandLine;
  if (info.command) {
    commandLine = t("sessionHudTrellisCommand").replace("{command}", info.command);
    if (info.workflowNextAction) commandLine += ` — ${info.workflowNextAction}`;
  } else {
    // ws-only：Status — Next-Action（Next-Action 自带指令上下文，如
    // "Load `trellis-brainstorm`; stay in planning"）
    commandLine = `${info.workflowStatus || "—"} — ${info.workflowNextAction || ""}`.trim();
  }
  title += "\n" + commandLine;
}
```

- `info.command` 存在时维持原文案（i18n 键不变）；ws-only 走新分支，Status/Next-Action 均为透显原文（对齐原任务「不语义解读」口径，不新增 i18n 键）

**改动 3（A：command 降级）**：`TRACE_COMMAND_RE` 锚定逻辑保留不动（旧版本 jsonl 仍可命中），仅不再是显示与扩窗的必要条件；spec 记录「当前版本无 command 痕迹」实测结论。

**契约修订**：`.trellis/spec/guides/trellis-panel-contract.md` IO 预算段改为阶梯表述（最坏 ~15MB/轮，触发条件=信号被推出窗口）；trace 信号源结论一并记入。

## R2：面板分项目分节

**IPC 形状**（`session-hud:trellis-panel`，main.js:5330-5340）：

```js
// 请求：{ cwd } 保留（锚定 root 排序依据），不再决定数据范围
// 响应：{ status: "ok", projects: [{
//   cwd, name,            // name = path.basename(projectRoot)
//   active: [...],        // collectActiveTasksInRoot 原样
//   archived: [...],      // 每项目 cap 由 8 收紧到 3
// }] } | { status: "missing" }   // 无任何已知 root
```

**主进程 `readHudTaskPanel(anchorCwd)`**：

- 项目集合 = `collectKnownRootCwds()`（persistedRoots ∪ 正向 rootCache，既有信任面），去重到 root，锚定 cwd 的 root 排最前，其余保持集合序
- 面板 cap：项目 ≤5（HUD 空间），超出按上述序截断；单项目 archived ≤3（8→3，多项目下防过长）
- 每 root 复用 `collectActiveTasksInRoot(root, cwd)` + `listArchivedTasks`，IO 形状与 dashboard 侧一致

**renderer `createTrellisPanel`**：

- header（锚定会话的 `trellisChipInfo` 详情行）不变；列表区改为按 `projects[]` 循环：每节一个小标题（项目 name，class `trellis-panel-project`）+ 原 active/archived 两段
- 行点击：`entry.cwd` 来自所属节（渲染时把节 cwd 写进 row 闭包），不再引用 `trellisPanel.cwd`
- `toggleTrellisPanel` 简化：打开即 fetch（cwd 参数仅用于传给主进程排序）；`missing` = 无已知 root → 关面板。换锚定会话不再触发 refetch（数据范围已与单 cwd 解耦），仅在面板关闭重开时刷新——面板打开期间新任务靠下次重开可见，与现状一致

**不做**：面板内自动轮询刷新、跨项目合并排序、增量缓存（YAGNI）。

## 兼容与回滚

- 旧响应消费者只有 session-hud-renderer（同仓同步改）；dashboard-trellis-panel 走独立通道不受影响
- 两个改动相互独立，可分两个 commit 分别回滚
- 行高回传机制（`reportTrellisDetailHeight` 汇总 `.trellis-task-panel`）天然支持面板变高，无需改

## Trade-offs

- 每轮最坏 IO 增大（~15MB 读 vs 0.5MB）：只发生在「活跃会话且信号被推出窗口」时；5s 轮询下顺序 tail 读的代价远低于丢过程感知的价值——用户核心诉求就是长轮次里的过程感知
- 面板显示全部已知项目而非仅活跃两个：集合来自既有信任面（≤5 cap），注册过但未使用的项目也可见——符合「项目工作台」语义，且避免了「活跃/非活跃」的模糊判定
