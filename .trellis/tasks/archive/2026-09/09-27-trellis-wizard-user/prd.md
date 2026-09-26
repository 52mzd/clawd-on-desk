# Trellis 安装向导支持 `-u` 开发者身份

## 状态

planning（2026-09-27）—— 用户已确认范围：**只做 `-u, --user <name>`**，其他 init 参数不做。

## Goal

让 Settings → Trellis 的安装向导能指定 **Trellis 开发者身份**（`trellis init -u <name>`），
取代当前硬编码的「项目目录名」，使用户的个人工作区落在正确的名字下。

## 背景（调研已确认的事实）

### `-u` 的真实语义：开发者身份，不是项目名

CLI help：

```
-u, --user <name>   Initialize developer identity with specified name
```

官方文档（`docs.trytrellis.app/zh/start/install-and-first-task`）原文：

> `your-name` 会成为你的**开发者身份**，在 `.trellis/workspace/your-name/` 创建个人工作区。

且 `.trellis/.developer` 是 **gitignored 的 per-checkout 身份文件** —— 新克隆的 checkout 永远没有它，
这是 CLI 判断「新开发者」的干净信号。CLI 自己还会提示：
`Tip: Usually this is your git username (git config user.name).`

### 当前实现：3 处硬编码目录名

| 位置 | 代码 |
|---|---|
| `src/trellis-cli.js:316` | `const userName = path.basename(String(projectPath)) \|\| "clawd";` |
| `src/trellis-ipc.js:84` | `args: [...INIT_ARGS, "-u", path.basename(String(project.path)) \|\| "clawd", …]` |
| `src/trellis-runtime.js:205` | `args: [...INIT_ARGS, "-u", path.basename(String(projectPath)) \|\| "clawd", …]` |

用户自述：*「我之前为了调试方便，直接默认就是目录名」*。

### 实测验证（临时目录，已清理）

| 场景 | `.developer` | `workspace/` |
|---|---|---|
| 首次 `trellis init -u alice --claude -y` | `name=alice` | `alice/` |
| 再 `trellis init -u <目录名> --cursor -y` | **仍 `alice`** ✅ | **仍 `alice/`** ✅ |
| 再 `trellis init --qoder -y`（不传 `-u`） | 仍 `alice` ✅ | 仍 `alice/` ✅ |

**两个结论**：

1. ✅ **无数据风险**：加平台时传 `-u` **不会覆盖已有身份**（CLI 有保护）→ 现有 3 处传参不是数据 bug
2. ⚠️ **但首次 init 的语义错了**：用目录名当身份 → `.trellis/workspace/<项目名>/` 被创建（那本该是开发者名）
   - 本仓现状可作为佐证：`.developer` 是 `name=clawd`（首次 init 时手动传的），`workspace/` 下只有 `clawd/`

### 可用的判据与接入点（已核实）

| 需要的东西 | 现状 |
|---|---|
| 「是否首次 init」 | `project.installed`（`src/trellis-scanner.js` L80-84：`.trellis/` 存在且有 version 或 scripts 才为 true） |
| 向导的输入阶段 | `renderAddSelect()`（`settings-tab-trellis-wizard.js`）—— 单页多阶段：select → preview → install |
| 向导的 i18n | 文件内 `FALLBACK` 英文表 + `bridge.t(key)` 优先；**现有向导 key 未进 `settings-i18n.js`** |
| 预览命令的来源 | `addPlan.command`（由 `trellis-runtime` 的 `previewAddPlatforms` 构造，已含 `-u`；`previewTargets` 只是 path 过滤器，产出的 `trellis update` 命令与 `-u` 无关） |
| 调用链 | `settings-tab-trellis.js:35 openAddPlatformWizard(project, preselectId)` → `ClawdTrellisWizard.openAddPlatform(bridge, project, catalog, preselectId)` |

## 需求

- **R1** **仅当 `project.installed === false`（首次 init）时**，向导的「选平台」阶段显示一个
  **开发者名输入框**；`installed === true`（加平台）时**不显示**，且行为与现状完全一致
- **R2** 输入框**默认预填** `git config user.name`；读不到时留空，用 placeholder 提示
  「通常是你的 git 用户名」
- **R3** 用户确认后，该值经 `-u <name>` 传给 `trellis init` —— 把 3 处硬编码改为**可注入参数**
  （保留目录名作为最终兜底，保证 `-u` 永不为空）
- **R4** 预览阶段的命令块必须显示**实际将使用的** `-u <name>`（用户能在执行前核对）
- **R5** 值在向导内**跨阶段保持**（select → preview → back 往返不丢失）

## 设计要点（待 review 时确认）

### UI 位置

**推荐：平台列表之后、动作按钮之前。**

```
┌─ Add Trellis platforms ──────────────────┐
│ Pick the platforms to install into this  │
│ project:                                 │
│ ☐ Claude Code   ☐ Cursor   ☐ Codex  …    │
│                                          │
│ Developer name                    ← 新增（仅首次 init）│
│ [ alice                        ]         │
│ Trellis creates .trellis/workspace/alice/ │
│ as your personal workspace.              │
│                                          │
│              [ Cancel ]  [ Preview ]     │
└──────────────────────────────────────────┘
```

**理由**：不打断「选平台」的主流程；且紧邻 Preview 按钮 —— 预览会显示含 `-u` 的命令，逻辑连贯。

（备选：放在平台列表**之前**，语义上「身份先于平台」；但会打断主流程。**推荐前者。**）

### 默认值的取法

**推荐：打开向导时按需异步探测，不污染项目扫描。**

- 项目扫描是**批量**的（多个项目），若每个都跑 `git config` 会造成无谓开销
- 方案：`openAddPlatformWizard()` 在 `!project.installed` 时先取默认值，再渲染
  - 轻量 IPC（如 `settings:trellis-user-suggestion`）读一次 `git config user.name`，主进程侧可缓存
  - 或**先渲染空框、探测回来后填入**（改动更小，但有一瞬空白）
- **不选**：把 `suggestedUserName` 塞进 `project`（扫描期就为每个项目跑 `git config`）

### 空值回退链（必须保证 `-u` 非空）

```
输入框值 → 探测到的 git user.name → 目录名 → "clawd"
```

CLI 在缺 `-u` 时**不会**挂起（0.6.17 实测：`trellis init --gemini -y`、stdin=ignore 下 `exit=0`），
但它既不创建 `.trellis/.developer` 也不创建个人 workspace 目录 —— 用户会看到「安装成功」而开发者身份
静默缺失。因此**不能留空**。

### i18n（已决策：方案 C —— 整套补 7 语言）

向导现有 19 个 key **只维护英文 `FALLBACK`**（未进 `settings-i18n.js`），而 `frontend/i18n-guidelines.md`
明确要求「新键七块全加」，并把「在 renderer 里写 fallback 英文串绕过 i18n」列为反模式 ——
即现有向导本身就违反了该规范（非本次引入）。

**用户已选方案 C**：19 个旧 key + 3 个新 key = **22 个 key × 7 语言**，一次性补齐。

- `FALLBACK` 保留（作为 `bridge.t` 不可用时的最后防线）
- 插入必须**整行锚定**（`^(\s*)keyName: "…",\s*$`），插完 `node --check` + 按语言块计数
  —— 09-25 曾因按值子串定位把新键拼进另一键字符串内部、损坏整个文件

## 验收标准

- **A1** 首次 init（`project.installed === false`）时向导出现开发者名输入框；加平台时**不出现**
- **A2** 输入框默认值等于 `git config user.name`；该命令失败/为空时字段为空且有 placeholder
- **A3** 提交后实际执行的命令含 `-u <输入值>`（预览块与执行一致）
- **A4** 输入框留空时，回退链生效且 `-u` 非空（否则 CLI 静默不创建 `.developer` 与 workspace，见上）
- **A5** select → preview → back 往返后输入值不丢失
- **A6** 加平台场景（`installed === true`）的现有行为**零回归**（含 3 处传参语义不变）
- **A7** 定向测试通过（`test/settings-tab-trellis.test.js`、`test/settings-tab-trellis-wizard-static.test.js`、
  `test/trellis-cli.test.js`、`test/trellis-ipc.test.js`）；全量 `npm test` 与存量基线一致
- **A8** 真机验证：对一个**未 init** 的项目走一遍向导，确认 `.trellis/workspace/<输入名>/` 被创建

## Out of Scope

用户已明确只做 `-u`，以下**不做**：

| 参数 | 不做的理由 |
|---|---|
| `--monorepo` / `--no-monorepo` | 场景窄，且向导当前无相关 UI 需求 |
| `-t, --template <name>` + `--overwrite` | 远程拉取 + 覆盖 spec，风险高 |
| `--with-statusline` | Claude Code 专属，且可能与 Clawd 自己的 statusline 集成冲突 |
| `-f` / `-s` | 向导当前没有「已存在文件冲突」场景 |

另**不做**：把 `-u` 从「加平台」路径中移除（实测无风险，且移除会改变现有命令形态）。

## 风险

| 风险 | 缓解 |
|---|---|
| 改动 `trellis-cli.js` / `trellis-ipc.js` / `trellis-runtime.js` 三处传参 → 命令形态变化 | 保留目录名兜底；用 `trellis-cli.test.js` 的既有断言锁定 `-u` 存在性 |
| `git config` 在无 git 环境 / 未配置时报错 | 捕获 + 3s 超时后走回退链，绝不阻塞向导 |
| i18n 插入损坏文件（22 键 × 7 语言） | 整行锚定 + `node --check` + 按语言块计数（09-25 事故的既定防护） |
