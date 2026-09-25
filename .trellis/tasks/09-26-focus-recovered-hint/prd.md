# startupRecovered 会话的终端跳转提示不具可操作性

## 任务状态

**待办（planning）** —— 用户 2026-09-26 要求：先记录，下次再修好并向上游提 PR。

调查已**完成**（根因、证据链、归属判定齐全），下次可直接进入实现，不需要重新排查。

## Goal

Clawd 启动时通过 recovery lease 恢复的会话（`startupRecovered === true`）在 HUD / Dashboard 被点击时，
只得到兜底文案「此会话未提供终端窗口信息」。该文案对用户**零可操作性** ——
真实情况是「这个会话是 Clawd 重启时恢复的，去终端发一条消息即可恢复跳转」。

目标：给这类会话一个**专属且可操作**的原因文案，并按上游口径向上游提交 PR。

## 现象

HUD 上有一行显示正在工作的会话（本次实例：Orca 终端里启动的 Claude Code，cwd 为 wallpaper 项目）。
点击该行**不跳转终端**，而是弹出提示「此会话未提供终端窗口信息。」

**自查特征**：该行的 chip 区域会显示「已恢复」(`sessionRecovered` / class `chip-recovered`)。

## 根因（已完整定位）

### 代码链

`src/session-hud-renderer.js`
- L196：`if (session.startupRecovered) return { label: t("sessionRecovered"), cls: "chip-recovered" };` → 恢复会话带「已恢复」chip
- L349：`const canFocus = session.canFocus === true;`
- L504-508：`if (canFocus) focusSession(...) else showSessionFeedback(session.id, focusUnavailableTooltip(session));`

`src/state-session-snapshot.js`
- L340-345：
  ```js
  const startupRecovered = !!(session && session.startupRecovered === true);
  const focusTarget = session && !session.headless && !startupRecovered && state !== "sleeping" && !hiddenFromHud
    ? getSessionFocusTarget(...)
    : { canFocus: false, type: null, url: null };   // ← 恢复会话直接 canFocus=false
  ```

`src/session-focus-unavailable.js`
- 只有三个分支：`webui` / `remote` / **兜底 `sessionFocusUnavailableMissingTerminalInfo`**
- `startupRecovered` **不在任何分支里** → 落到兜底 → 文案与真实原因无关（这就是缺陷所在）

`src/state.js`
- L2990：启动恢复时写入 `startupRecovered: true`
- L2227-2228：真实事件到达时 `delete existing.startupRecovered` → 跳转能力**自动恢复**

### 触发条件与复现步骤

1. 有一个正在运行的、支持 terminal focus 的 agent 会话（本例 Claude Code）
2. **重启 Clawd** —— recovery lease 判定该进程仍存活 → 恢复会话并标记 `startupRecovered=true`
3. HUD 出现该会话，带「已恢复」chip
4. 点击该行 → 「此会话未提供终端窗口信息」（不跳转）
5. 在终端里发一条消息 → 真实事件清除 `startupRecovered` → 再点击即可正常跳转

### 实测证据链（2026-09-26 事故）

| 证据 | 值 |
|---|---|
| 触发动作 | 为验证折叠动画而重启 Clawd |
| 重启时间 | `.claude` 目录 mtime **Sep 26 03:07** |
| 恢复租约写入 | `~/.clawd/session-recovery-v1/session-recovery-v1-ce4415eb…json` **03:08** |
| 该会话 history 文件 | `session-history-v1-ce4415eb….json`（**同一 hash**） |
| 该 history 的 cwd | `/Users/Dae/Downloads/codes/wallpaper` ✅ 与用户描述一致 |

## 归属判定：**官方行为，与二开无关**

- 二开**没有**碰这条链路：对 `src/state-session-snapshot.js` 只有纯新增的 trellis resolver 段（+17 行、0 删除）；
  `hooks/`、`agents/`、`src/session-focus.js`、`startupRecovered`、`canFocus`、`getSessionFocusTarget` 的 diff 全为空
- 「恢复会话不给 focus」与「已恢复」chip 都是**官方有意设计**（恢复后终端归属不可靠）
- **本次已排除的方向（勿重复调查）**：
  - ❌ ~~Orca pane key 上报失效~~：`~/.claude/settings.json` 的 clawd hook 直接引用仓库源码
    `hooks/clawd-hook.js`（永远是最新版）；`applyOrcaPaneKey` 在本机（L542）与 remote（L735）两条路径都调用；
    在当前 Orca 环境实测 `orcaPaneKeyFromEnv(process.env)` **正常返回** pane key
  - ❌ ~~Pi extension 陈旧~~：本机聚焦链路与该 agent 无关（此会话是 Claude Code）
  - ❌ ~~trellis chip 吞掉点击~~：chip 有 `event.stopPropagation()`（`src/session-hud-renderer.js` L417），
    点 chip 不冒泡到行、也不会出现该提示 → 用户点的是**会话行本身**

## Requirements

- **R1** 为 `startupRecovered === true` 的会话提供专属且**可操作**的原因文案，替代兜底文案
- **R2** 文案要点明可操作路径：在终端中产生任意活动（发一条消息 / 触发一次工具）后即可恢复跳转
- **R3** 判定顺序必须是 `webui` → `remote` → `startupRecovered` → 兜底。
  **remote 必须优先于 startupRecovered**：远端会话永远无法从本机聚焦，对它提示"发消息即可"是错误建议
- **R4** 语言齐全（按 `src/i18n.js` 实际语言集：en / zh / zh-TW / ko / ja / pt-BR / es），
  键名与既有 `sessionFocusUnavailable*` 家族一致（如 `sessionFocusUnavailableRecovered`）
- **R5** 所有消费点同步：HUD tooltip（`focusUnavailableTooltip`）与 Dashboard 用法
  （`src/dashboard-renderer.js` L4422 存在 `focusUnavailableReasonKey(session) === "sessionFocusUnavailableRemote"`
  的**等值比较**，新增 key 后必须确认该分支语义仍正确）
- **R6** 追加回归测试：恢复会话返回新 key；remote 且恢复的会话仍返回 remote；WebUI 仍返回 webui
- **R7** 向上游 `rullerzhou-afk/clawd-on-desk` 提交 PR（本任务含回贡 —— 与 `09-26-trellis-oss-sync` 的"不回贡"不同）

## 验收标准

- **A1** 恢复会话（`startupRecovered=true`）点击 HUD / Dashboard 得到新文案，不再是「未提供终端窗口信息」
- **A2** 既有四种情形的文案与行为**零回归**：webui / remote / 有 `sourcePid` / Codex JSONL best-effort
- **A3** `src/dashboard-renderer.js` 中依赖 `"sessionFocusUnavailableRemote"` 判等的逻辑不受影响
- **A4** 定向测试通过；全量 `npm test` 与 macOS 存量基线一致（约 26 条环境相关失败，零新增）
- **A5** 真机验证：重启 Clawd 恢复一个会话 → 点击看到新文案；在终端发一条消息 → 点击可正常跳转
- **A6** PR 已提交上游且 CI 通过（或明确记录 pending 原因）

## 设计要点（下次实现时细化）

- 改动面很小：`src/session-focus-unavailable.js`（加一个分支）+ `src/i18n.js`（各语言新键）
- ⚠️ **i18n 加键必须整行锚定** —— 本仓有事故记录：值子串正则会拼进另一键的字符串内部。
  见 `.trellis/spec/frontend/i18n-guidelines.md`
- ⚠️ `focusUnavailableReasonKey` 返回的是 **i18n key 字符串**（不是文案本身），且被 Dashboard 用于**等值比较**，
  改动后必须回归该比较点
- 可顺带审查的 UX 不一致（**需用户确认是否纳入本任务**）：
  `canOfferLocalFolder(session)` 不检查 `startupRecovered`，导致恢复会话**能打开文件夹却不能聚焦** ——
  这个组合对用户是矛盾的

## Out of Scope

- 不改变「恢复会话不提供 focus」这一既定策略本身（本次只改提示的可操作性）
- 不改 recovery lease 机制、不改 `src/state.js` 的恢复逻辑
- 不动 trellis 二开内容（那是 `09-26-trellis-oss-sync` 的范围）

## 参考

- 同仓相关任务：`09-26-trellis-oss-sync`（二开整合并开源，独立任务，**不回贡**）
- 上游文档：`docs/guides/known-limitations.md`（已记载 Codex JSONL 与 Remote SSH 的 focus 边界）
