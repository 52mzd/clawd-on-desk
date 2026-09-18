# 技术设计 — Clawd Trellis 管理面板

## 1. 设计摘要

在 Settings 内新增一个 `trellis` tab，主进程新增一层 `trellis-*` 模块负责"扫描 + 调用外部 CLI + 并发编排 + 进度广播"。

```
settings-tab-trellis.js (renderer)
        │  invoke / on
        ▼
preload-settings.js  ──▶  trellis-ipc.js (ipcMain.handle)
                                   │
                                   ▼
                           trellis-runtime.js      ← 唯一持状态者（缓存 / 批次 / 取消）
                            ├── trellis-scanner.js  ← 纯函数：读盘扫描
                            └── trellis-cli.js      ← 纯执行：调外部命令
                                        │
                                        ▼
                                 child_process.execFile
```

分层理由：`scanner` / `cli` 无状态、可单测（注入 fake execFile / fake fs）；`runtime` 独有状态，取消与并发只在这一个地方实现，避免状态散落。

## 2. 已验证的外部事实（设计依据）

| 事实 | 值 / 位置 |
| --- | --- |
| 项目侧版本真相 | `<project>/.trellis/.version`（纯文本，如 `0.7.0-beta.3`） |
| 安装判据 | 存在 `<project>/.trellis/` 目录且含 `.version` 文件 |
| 全局 CLI 版本 | `trellis --version` |
| 远程通道 | `npm view @mindfoldhq/trellis dist-tags --json` → `{latest, beta, rc}`，**一次调用拿全部通道** |
| 项目升级 | `trellis update [--force\|--create-new\|--skip-all]`，cwd = 项目目录 |
| 全局升级 | `trellis upgrade`（有 `--dry-run`，无其他非交互选项） |
| 实测耗时 | `trellis update --dry-run` ≈ 1.1s/项目；`npm view` ≈ 0.94s |
| **`--dry-run` 会写盘** | 当项目 `.version` ≠ CLI 版本时，`trellis update --dry-run` 会**改写 `.trellis/.version`**（受控实验：`0.6.0`、`0.5.0` 均被写成 `0.7.0-beta.3`，仅此一个文件变化）→ **不得用作预览** |
| `trellis update` 无参默认行为 | 交互式逐文件确认 → **必须显式传 `--force`**，否则会挂起 |
| 非 Trellis 目录执行 `trellis update` | 会走进 init 引导流程而非报错 → **不能靠"命令失败"判断是否已安装**，必须靠 `.trellis/.version` 前置判定 |

最后一行是本设计里最关键的约束：**安装判定必须在 Clawd 侧完成（读文件），绝不能用"跑一次 trellis update 看是否报错"来探测。**

## 3. 新增文件与改动清单

### 3.1 新增（主进程）

| 文件 | 职责 |
| --- | --- |
| `src/trellis-version.js` | 版本字符串解析/比较、通道推断、可升级判定。纯函数，零依赖 |
| `src/trellis-platforms.js` | 21 项 `dirPrefix → id/flag/name` 映射表 + `parsePlatforms(hashes)` / `flagsFor(ids)` / `staleOf()`。纯数据 + 纯逻辑，零依赖 |
| `src/trellis-scanner.js` | 扫描根 → 项目列表；读 `.template-hashes.json` 经 `parsePlatforms()` 得到平台，并算 `staleRecord`。只读 fs，不跟 symlink |
| `src/trellis-cli.js` | 解析可执行文件、调用 `trellis` / `npm`、统一错误包装。`execFile` 可注入 |
| `src/trellis-runtime.js` | 编排：远程版本缓存（TTL）、单项目升级、批量升级（信号量 + 取消）、进度广播 |
| `src/trellis-ipc.js` | IPC 通道注册（照 `settings-ipc.js` 的 `handle()` + disposers 模式） |

### 3.2 新增（渲染层）

| 文件 | 职责 |
| --- | --- |
| `src/settings-tab-trellis.js` | tab UI：扫描根管理、项目列表、单项/批量升级、全局 CLI 区 |

### 3.3 修改（必需接线点）

| 文件 | 改动 |
| --- | --- |
| `src/prefs.js` | 新增数组字段 `trellisScanRoots`（仿 `customToolDiscoveryPaths` :453-457） |
| `src/main.js` | 接线 `trellis-ipc` 注册器（沿用既有 runtime 接线块） |
| `src/preload-settings.js` | 新增 3 个 invoke 方法 + 1 个进度订阅方法 |
| `src/settings.html` | 新增 `<script src="settings-tab-trellis.js">`（顺序在 `settings-renderer.js` 之前） |
| `src/settings-renderer.js` | tab 定义数组内注册一项（含 `render` / `init` 绑定） |
| `src/settings-window.js` | `ALLOWED_TABS` 白名单加 `trellis` |
| `src/settings-icons.js` | 新增 `trellis` 图标 key（缺失只回落 placeholder，但不加会不好看） |
| `src/settings-i18n.js` | 新增 `tabTrellis` 文案组 × 7 语言 |

### 3.4 新增（测试）

`test/trellis-version.test.js`、`test/trellis-platforms.test.js`、`test/trellis-scanner.test.js`、`test/trellis-cli.test.js`、`test/trellis-runtime.test.js`

## 4. 接口契约

### 4.1 prefs

```js
// src/prefs.js — SCHEMA 内新增（照抄 customToolDiscoveryPaths :453-457 的形状）
trellisScanRoots: {
  type: "array",
  defaultFactory: () => [],
  normalize: normalizePathList,   // 复用既有 helper：:998
},
```

`normalizePathList`（`src/prefs.js:998`）已自带：trim、`\0` 剔除、单条截断 2048 字符、平台感知去重（win32 折叠大小写）、上限 64 条。对"扫描根列表"是完全够用且语义正确的复用，无需新写 normalize。

**不 bump `CURRENT_VERSION`（当前 20）**：无历史数据需要迁移，`validate()` 对缺键即走 `defaultFactory`。
（前置检查：确认 `validate()` 是否会丢弃未知键。若会丢弃，旧版本 Clawd 打开新 prefs 会静默丢掉该字段——可接受，但需在 release note 说明。）

### 4.2 IPC 通道

命名沿用 `settings:` 前缀，全部 `ipcMain.handle`，统一返回信封 `{ status: "ok" | "cancel" | "error", ... }`：

| 通道 | 入参 | 返回 |
| --- | --- | --- |
| `settings:trellis-scan` | `{}` | `{ status, roots, projects[], remote, global }` |
| `settings:trellis-pick-root` | `{}` | `{ status:"ok", path }` / `{ status:"cancel" }` |
| `settings:trellis-set-roots` | `{ roots: string[] }` | `{ status }`（经 settings-controller 写 prefs） |
| `settings:trellis-preview` | `{ paths: string[] }` | `{ status, plan[] }`（**纯计算，零 spawn**） |
| `settings:trellis-upgrade-project` | `{ path }` | `{ status, from, to, output }` |
| `settings:trellis-upgrade-all` | `{ paths: string[] }` | `{ status, results[] }`（同步返回前先启动后台批次） |
| `settings:trellis-cancel-batch` | `{}` | `{ status }` |
| `settings:trellis-add-platform` | `{ path, platforms: string[] }` | `{ status, added[], output }`（platforms 为 id 白名单，主进程映射为 flag；**只追加 `-y`**） |
| `settings:trellis-upgrade-global` | `{}` | `{ status, from, to, output }` |

进度事件（主 → 渲染，`webContents.send`）：

| 通道 | 载荷 |
| --- | --- |
| `settings:trellis-progress` | `{ batchId, path, phase: "queued"\|"running"\|"ok"\|"failed"\|"cancelled", from, to, message? }` |

### 4.2.1 IPC 信任门禁（阶段 6 实现时补入）

`trellis-ipc.js` 的每个通道都必须先过与 `settings-ipc.js` **同一套** Settings 窗口信任判定，再进入 handler。

- `settings-ipc.js` 的工厂返回值新增导出 `isTrustedEvent`（原本只是内部函数），供兄弟 IPC 面复用同一判定，**不另写第二套更弱的检查**。
- `trellis-ipc.js` 接收注入的 `isTrustedEvent`，**fail closed**：注入缺失或抛错时**拒绝所有通道**，返回 `{ status:"error", message:"untrusted-sender" }`。
- 理由：若默认放行，桌宠窗口 / 气泡 / dashboard 等任意渲染层都能调用这些通道，等于把"用户显式点击"这条约束（R4/R5/R8、D7）交给渲染层自觉遵守——而它们是写盘 + spawn CLI 的通道。
- 判定发生在 `ipcMain.handle` 的最外层（进 handler 之前），确保未授权调用**既不 spawn 任何进程，也不写 prefs**。
- 对应测试：无 guard → 全部通道返回 `untrusted-sender` 且 CLI 调用计数全 0；不可信 sender 被拒但可信 sender 仍可正常调用。

### 4.3 返回形状（统一）

```js
{ path, name, installed: boolean, current: string|null, target: string|null,
  channel: "latest"|"beta"|"rc", upgradable: boolean|null /* null = 未知 */,
  platforms: string[] /* D10 解析结果，如 ["claude-code","pi","gemini"] */,
  staleRecord: boolean /* true = 记录里有平台但对应顶层目录不存在 */ }
```

`upgradable: null` 必须与 `false` 严格区分——远程查询失败时是 `null`（渲染"未知"），绝不渲染成"已最新"。

## 5. 关键设计决策

### D1 安装判定：读文件，不跑命令

见 §2 末行的实测约束。`trellis-scanner.js` 只做 `fs.stat` / `fs.readFile`，不 spawn 任何进程。同时也满足"无用户点击时零副作用"。

### D2 扫描范围：直接子目录

`fs.readdir(root, { withFileTypes: true })` → 过滤：

- 跳过 `dirent.isDirectory() === false`
- 跳过以 `.` 开头的名字
- 跳过 `node_modules`
- **跳过 symlink**（`dirent.isSymbolicLink()` 先于 `isDirectory()` 判断），避免越出根目录

对每个幸存子目录检查 `<child>/.trellis/.version` 是否可读。路径全部经 `path.join`，不做任何字符串拼 shell。

### D3 远程版本：单次查询 + TTL 缓存

`trellis-runtime.js` 持有 `remoteCache = { at, channels, error }`，TTL 60s。

- 一次 `settings:trellis-scan` 内无论多少项目，只调一次 `npm view`
- 连点"刷新"命中缓存，不打爆 npm
- 查询失败 → `remote = null` → 所有项目 `upgradable = null` / `target = null`，UI 显示"无法获取远程版本"并保留"重试"按钮

### D4 通道推断与比较

```js
// trellis-version.js
function inferChannel(version) {
  if (version.includes("-beta.")) return "beta";
  if (version.includes("-rc."))  return "rc";
  return "latest";
}
```

`upgradable` **必须用版本比较判定，不能只做字符串相等判断**：

```js
upgradable = compareVersions(target, current) > 0;   // target 严格新于 current
```

判定表：

| 关系 | `upgradable` | UI |
| --- | --- | --- |
| `target > current` | `true` | 可升级（主按钮） |
| `target === current` | `false` | 已最新 |
| `target < current`（本地更新：剪枝 / 回退 / 手改） | `false` | 已最新（可附"高于远程"说明） |
| `target === null`（远程查询失败） | `null` | 未知（不给升级按钮） |

理由：若使用 `current !== target`，本地比远程新的场景会被误判为"可升级"，一键批量就会把用户的项目**降级**——这是不可接受的破坏性行为。

`compareVersions` 的最小实现（无外部依赖，约 30 行）：

1. 剥离 prerelease：`0.7.0-beta.3` → base `[0,7,0]` + pre `["beta", 3]`
2. base 按数字逐段比较（缺失段补 0）
3. base 相等时：无 prerelease > 有 prerelease；都有则先比 tag，再比数字
4. 非数字/无法解析输入 → 返回 `null`，调用方将该项置 `upgradable = null`（未知），**绝不当成相等**

### D5 并发与取消

自实现 3 行级信号量（不引入依赖）：

```js
const MAX_CONCURRENCY = 3;
```

- 批次状态由 `trellis-runtime.js` 独占：`{ batchId, cancelled, inflight: Map<path, child>, results: [] }`
- `cancel` 时：置 `cancelled = true`，`kill()` 所有 inflight child，不再启动队列中的新项
- 单项失败：记录 `{ ok:false, message }`，**不中断批次**
- 批次结束广播 `{ phase:"done", summary:{ ok, failed, cancelled } }`

### D6 外部命令调用规范

照 `src/updater.js` 既有模式：

```js
execFileFn("trellis", ["update", "--force"], {
  cwd: projectPath,          // 用户路径只作 cwd，不进 argv、不进 shell
  timeout: 120000,
  windowsHide: true,
  shell: process.platform === "win32",   // 解析 trellis.cmd，与 updater.js:1093 一致
  env: mergedExecutionEnv(process.env, process.platform),
}, cb);
```

- **`--force` 必需**：无参 `trellis update` 是交互式的，在无 TTY 下会挂到超时
- `shell:true` 仅在 win32；`cwd` 不被 shell 解释，argv 内无用户数据 → 无注入面
- `env` 复用 `src/codex-queue-delivery.js:202` 的 `mergedExecutionEnv()`，解决 GUI 应用 PATH 缺失
- 超时错误归类照 `updater.js:175`（`ETIMEDOUT` / `ESOCKETTIMEDOUT` / `ERR_TIMED_OUT`）
- **执行器可注入**：`deps.execFileImpl`（照 `updater.js:228`），供单测替换

### D7 不自动升级

design 层面固化：

- 无启动时任务、无定时器、无 watcher 触碰 `trellis update`
- 每个写操作都必须经由一个 IPC 通道，且该通道只由用户点击触发
- 代码评审与测试都要守住这条（AC 里有对应条目）

### D8 渲染层事件订阅

进度回传需要 preload 暴露 `onTrellisProgress(cb)`。

**前置检查（implement 第 0 步）**：先读 `src/preload-settings.js`，确认其是否已有通用订阅模式（白名单 `ipcRenderer.on` 包装）或 `contextBridge` 的订阅通道列表，然后**照抄该模式**新增，不发明新风格。

### D9 i18n
语言全集 **7 种**：`en / zh / zh-TW / ko / ja / pt-BR / es`（**无 zh-CN**）。

- 在 `src/settings-i18n.js` 新增一个 `tabTrellis` 分组，7 个 locale 各一份
- key 顺序、类型、占位符、函数 arity 必须完全一致，否则 `test/i18n.test.js` 的 parity 断言失败
- 缺失 key 的行为取决于 i18n 实现（回落到 en 或裸露 key）→ implement 第 0 步一并确认

### D10 平台检测（读 Trellis 自己的记录）

**目标**：回答"这个项目装了哪些平台的 Trellis"，支撑 R8。

**权威数据源：`<project>/.trellis/.template-hashes.json`**

```json
{ "__version": 2,
  "hashes": { ".claude/agents/trellis-implement.md": "9e48...",
              ".pi/prompts/trellis-start.md": "...",
              ".trellis/workflow.md": "...",
              "AGENTS.md": "..." } }
```

**检测算法（一次读取 + 前缀集合 + 表映射）**

```js
// trellis-platforms.js
const IGNORED = new Set([".trellis", "AGENTS.md", ".agents"]);
const dirPrefixes = new Set(Object.keys(hashes).map(k => k.split("/")[0]))
                       .difference(IGNORED);
platforms = [...dirPrefixes].map(prefixToId).filter(Boolean).sort();
```

**21 项 `dirPrefix → id / flag / 显示名` 映射表**（取自 CLI `AI_TOOLS` 的 `configDir`，实测校验）：

| dirPrefix | id | CLI flag | 显示名 |
| --- | --- | --- | --- |
| `.agent` | `antigravity` | `--antigravity` | Antigravity |
| `.claude` | `claude-code` | `--claude` | Claude Code |
| `.codebuddy` | `codebuddy` | `--codebuddy` | CodeBuddy |
| `.codex` | `codex` | `--codex` | Codex |
| `.cursor` | `cursor` | `--cursor` | Cursor |
| `.devin` | `devin` | `--devin` | Devin |
| `.factory` | `droid` | `--droid` | Factory Droid |
| `.gemini` | `gemini` | `--gemini` | Gemini CLI |
| `.github` | `copilot` | `--copilot` | GitHub Copilot |
| `.grok` | `grok` | `--grok` | Grok Build |
| `.kilocode` | `kilo` | `--kilo` | Kilo CLI |
| `.kimi-code` | `kimi` | `--kimi` | Kimi Code |
| `.kiro` | `kiro` | `--kiro` | Kiro Code |
| `.omp` | `omp` | `--omp` | Oh My Pi |
| `.opencode` | `opencode` | `--opencode` | OpenCode |
| `.pi` | `pi` | `--pi` | Pi Agent |
| `.qoder` | `qoder` | `--qoder` | Qoder |
| `.reasonix` | `reasonix` | `--reasonix` | Reasonix |
| `.snow` | `snow` | `--snow` | Snow CLI |
| `.trae` | `trae` | `--trae` | Trae |
| `.zcode` | `zcode` | `--zcode` | ZCode |

**与 CLI 输出的一致性已验证**：全平台项目（23 个顶层目录）实测 `recorded 前缀 = 21 个`，与 `trellis platforms` 打印的 21 条**逐条一致，零差异**。因此本表只是把 CLI 的内部 `AI_TOOLS.configDir` 复刻为静态数据，不是自创规则。

**为什么不用 `trellis platforms` CLI**：它需 spawn 进程，违反 D1「无用户点击时零副作用」与"扫描只读盘"的分层原则。且它读的就是同一个文件，无额外信息。

**未知前缀**：不在表内的前缀（Trellis 未来新增平台）**原样展示为 `Unknown (<prefix>)`**，不丢弃、不猜测。

**`dirPrefix` 缺失即 `staleRecord`**：记录里有某平台、但磁盘上对应目录不存在 → 标 `staleRecord`，提示记录与实际不一致（轻量诊断，见 R10）。

**与升级的关系（重要）**：`trellis update` **没有**平台参数（实测 `--help` 仅 `-f/--force`、`-s/--skip-all`、`-n/--create-new`，且**不接受 `-y`**），它只为**记录里登记的平台**同步模板。因此：

- 平台选择只能是**展示 / 筛选**语义；
- 绝不能通过临时改写平台目录或记录文件来"限定升级平台"。

### D11 升级预览：纯计算，零 spawn

**需求来源**：prd R9。用户要求在真正升级前能预览。

**关键约束（实测得出）**：`trellis update --dry-run` **有写盘副作用**——它会更新 `.trellis/.version`。因此**预览绝不能用 `--dry-run` 实现**。

**设计**：预览是 `runtime.preview(paths)` 的**纯函数合成**，不调用 `cli.updateProject`、不 spawn 任何进程：

```js
// trellis-runtime.js
function preview(paths) {
  return paths.map(p => ({
    path: p,
    name: path.basename(p),
    platforms,                       // 来自 scanner.readPlatforms(p)
    from: current,                   // 来自 scanner.readProjectVersion(p)
    to: target,                      // 来自 evaluate()（可能为 null）
    command: { bin: "trellis", args: ["update", "--force"], cwd: p },
  }));
}
```

**为什么安全**：所有数据均来自已完成的 scan 快照 + prefs，纯内存拼装；`readPlatforms` / `readProjectVersion` 只做 `fs.readFile`。零写盘、零子进程、零网络（远程版本命中 scan 的快照）。

**UI**："预览"按钮打开一个只读面板（或列表内展开），展示每行的平台、`当前 → 目标`、以及将执行的命令字符串（`trellis update --force` + cwd）。确认后才提供"开始升级"。

**测试**：`test/trellis-runtime.test.js` 中断言预览路径 **不调用** fake cli 的任何方法，且预览前后项目目录文件 `shasum` 不变。

### D12 平台一致性诊断（轻量）

**背景**：平台列表直接来自 Trellis 的记录文件（D10），**不再需要"目录 vs 记录"的对抗性诊断**——早期版本的"记录会缩水"现象已查明根因：`trellis init` 带 `-s`/`-f` 会绕过增量分支并重建记录（见 D13）。使用官方 `-y` 时记录是**并集**，不缩水。

**唯一保留的诊断**：`staleRecord`

- 记录里有某平台，但映射表内的 `dirPrefix` 对应的**顶层目录不存在** → `staleRecord = true`。
- UI 提示："Trellis 记录中包含 X，但对应目录不存在，记录可能与实际不同步。"
- 提供可复制命令 `trellis init --<platform> -y`（cwd = 项目路径），**Clawd 不自动执行、不改写记录文件**。

**`dirPrefix` 到顶层目录的归一化注意**：`AI_TOOLS.configDir` 有的是多级（`.kiro/skills`、`.github/copilot`、`.agent/workflows`、`.devin/workflows`、`.snow/skills`），但 `hashes` 键的前缀只有**第一段**。因此映射表以第一段为准（`.kiro` / `.github` / `.agent` / `.devin` / `.snow`），探测目录也用第一段。

### D13 新增平台（`trellis init`）

**需求来源**：prd R8 (c)，用户答复"可以选择升级，或者新增平台"。

**受控实验（三组，同一现场：已有 `.claude`+`.pi`+用户本地改动）**

| 命令 | 结果 | `handleReinit` 增量分支 | 记录 |
| --- | --- | --- | --- |
| `trellis init --gemini -y` | `.gemini` 新建 | ✅ `Tracking 153 files` | **并集**（`.claude .pi .gemini .trellis .agents`） |
| `trellis init --gemini -y -s` | `.gemini` 新建 | ❌ full init `Tracking 48 files` | **被重建**为 `.gemini .trellis` |
| `trellis init --gemini -y -f` | `.gemini` 新建 | ❌ full init `Tracking 48 files` | **被重建**为 `.gemini .trellis` |

**结论：新增平台必须只用 `-y`，绝不能带 `-s` 或 `-f`。**
`-s` / `-f` 会让 CLI 跳过"已初始化"的增量分支（`init.js:1511`），退化成全量 init 并从零重建记录，从而使之前登记的平台从记录中消失 —— 后续 `trellis update` 就不再同步它们。

**幂等性**：`trellis init --gemini -y` 重复执行输出 `○ Gemini CLI already configured, skipping`，记录不变。

**命令构造**

```js
// trellis-cli.js
addPlatforms(projectPath, platformIds) {
  const flags = flagsFor(platformIds);   // ["--gemini"]，来自 PLATFORMS 白名单
  return run("trellis", ["init", ...flags, "-y"], { cwd: projectPath });
}
```

**安全边界（重要）**

- renderer **只能传 platform id**（如 `"gemini"`），主进程用 `PLATFORMS` 表**白名单映射**为 `--gemini`。
- 绝不把 renderer 传来的字符串直接拼进 argv —— 否则等于把任意 CLI 参数注入面交给渲染层。
- 未知 id 直接拒绝整次调用（fail closed），不静默忽略。
- **参数后缀固定为 `["-y"]` 常量**，不得接受来自渲染层的任何额外参数。
- 不提供"移除平台"：Trellis 无此命令，删除用户目录属高危，明确不做。

**预览（复用 D11 机制，纯计算）**

- 预览展示：当前已配置平台、**将新增哪些平台**（目标集合 − 当前已配置）、将执行命令 `trellis init --gemini -y`（cwd = 项目路径）。
- 预览零 spawn；用户确认后才真正执行。

**与升级的关系**

- 批量升级**永远只跑 `trellis update`**，绝不在批次里隐式 init。
- "新增平台"是独立的单项目动作（MVP 不做批量新增）。

**错误处理**

- `trellis` 不在 PATH → 全局引导（同 R6）。
- 部分平台失败会以非零退出码结束 → 保留 stdout/stderr，提示用户手动核对；**不做自动重试**（重试可能重复写入）。
- 执行后重新读记录并回报实际新增的平台（**以记录/磁盘为准，不以命令退出码为准**）。

## 6. 数据流（一次完整刷新）
```
用户点"刷新"
  → renderer: invoke("settings:trellis-scan")
  → trellis-ipc handler
  → runtime.scan()
      ├─ prefs 读 trellisScanRoots（只读快照）
      ├─ scanner.scanRoots(roots)           ← 纯读盘，快
      └─ cli.fetchRemoteChannels()          ← 命中 60s 缓存则跳过
  → 逐项算 channel / target / upgradable
  → 返回快照，renderer 渲染表格
```

一次批量升级：

```
用户点"全部升级"
  → invoke("settings:trellis-upgrade-all", { paths })
  → runtime.startBatch(paths)：立即返回 batchId，队列后台跑
  → 每项状态变化 → webContents.send("settings:trellis-progress", …)
  → renderer 订阅回调：更新该行状态徽标
  → 全部结束 → send({ phase:"done", summary })
  → renderer 重新 invoke scan 拉取最新版本号
```

## 7. 错误与降级

| 场景 | 行为 |
| --- | --- |
| `npm view` 失败 / 离线 | `remote = null`，所有 `upgradable = null`，顶部显示"无法获取远程版本 + 重试"。**不阻塞列表渲染** |
| `trellis` 不在 PATH | 全局区显示"未检测到 Trellis CLI" + 安装命令（`npm i -g @mindfoldhq/trellis`）。不抛异常 |
| 某项目 `.trellis/.version` 不可读 | 该项目 `current = null`，行内标"版本未知"，不给升级按钮 |
| 扫描根不存在 / 无权限 | 该根标为"无法读取"，其余根继续 |
| 单项 `trellis update` 失败 | 行内标"失败"+ 可展开原始 stdout/stderr 摘要；批次继续 |
| 命令超时 | 归类为超时错误（照 `updater.js:176`），提示"可能网络受限" |
| 无扫描根 | 空态引导："添加一个目录开始扫描" |

## 8. 兼容性与回滚

- **兼容**：`trellis` 完全是新增子系统，不改动任何既有 agent / hook / state 路径；`prefs` 只加一个数组键。
- **平台**：三平台一致；仅 `shell:true` 在 win32 分支不同。
- **回滚**：删除新增文件 + 摘掉 §3.3 的接线即为完整回滚；`prefs` 残留的 `trellisScanRoots` 是无害死键。
- **打包**：新增的 `src/*.js` 会被既有 `build.files` 通配覆盖（前置检查确认）。

## 9. 未决 / 需 implement 阶段确认

本任务的三项设计选择**已定案**，实现阶段不再重新取舍：

- ~~Q1 版本比较~~ → **已定：实现最小 `compareVersions`**（见 D4）。不做纯字符串相等判断，避免批量升级把本地更新的项目降级。
- ~~Q2 升级策略~~ → **已定：MVP 只用 `--force`**。不提供 `--create-new` / `--skip-all` 的 UI 选择。
- ~~Q3 自动刷新~~ → **已定：纯手动刷新**。禁止启动时任务、定时器、watcher 触发任何 `trellis` 命令（含只读的 `npm view`）。

以下是 implement 阶段第 0 步必须逐项确认的前置检查：
- **前置检查 A**：`preload-settings.js` 的订阅暴露模式（D8）。
- **前置检查 B**：`prefs.validate()` 对未知键的处理（§4.1）。
- **前置检查 C**：i18n 缺失 key 的回退行为（D9）。
- **前置检查 D**：`package.json` 的 `build.files` 是否覆盖新增 `src/*.js`。

## 10. 测试策略
| 层 | 测试文件 | 覆盖 |
| --- | --- | --- |
| 纯逻辑 | `test/trellis-version.test.js` | 通道推断、版本比较边界（prerelease、等值、降级） |
| 探测 | `test/trellis-platforms.test.js` | 21 条 dirPrefix 映射双向断言；未知前缀保留；`IGNORED` 前缀剔除；`flagsFor` 白名单 |
| 读盘 | `test/trellis-scanner.test.js` | tmp fixture：已安装/未安装混合、隐藏目录跳过、`node_modules` 跳过、symlink 不跟随、含空格路径、**平台解析（多/单/缺 manifest/损坏 JSON）与 staleRecord** |
| 执行 | `test/trellis-cli.test.js` | 注入 fake execFile：argv 数组形态、`cwd`、timeout、`--force` 传递、错误包装、win32 `shell` 形态 |
| 编排 | `test/trellis-runtime.test.js` | 远程缓存只查一次、并发峰值 ≤ 3、单项失败不中断、取消后不再启动新项 |
| 契约 | `test/i18n.test.js`（既有） | 7 语言 key parity 自动覆盖 |
| 契约 | `test/prefs*.test.js`（既有） | 新字段默认值与 normalize |

真机手工验证（无法用单测替代）：在含空格路径的项目上跑一次真实升级；`trellis` 未安装时的 UI 降级；离线时顶部提示。
