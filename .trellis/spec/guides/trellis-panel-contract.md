---
name: trellis-panel-contract
description: Trellis Settings 面板的外部进程契约——argv 冻结、信任门禁、输出解析身份
paths:
  - src/trellis-*.js
  - src/settings-tab-trellis.js
  - test/trellis-*.test.js
  - test/settings-tab-trellis.test.js
---

# Trellis 面板的外部进程契约

## Scenario: 调用外部 CLI 并解析它的输出

### 1. Scope / Trigger

任何「Clawd 主进程 spawn 一个外部 CLI，并把结果呈现给用户」的代码都适用本条。

触发条件（满足任一即需按本 spec 深度实现）：

- 新增/修改 `src/trellis-*.js` 里的命令构造或输出解析
- 新增一个会 spawn 进程的 IPC 通道
- 让渲染层能影响被 spawn 命令的 argv

不适用：纯读盘扫描（`trellis-scanner.js` 的 fs 部分）——它不 spawn，按只读规则审即可。

### 2. Signatures

```js
// src/trellis-cli.js — 工厂，execFile 可注入
createTrellisCli({ execFileImpl?, env?, platform?, timeoutMs? })

// 每条命令一个函数，返回值统一带 ok / output
readGlobalVersion()                     // → { installed: boolean, version: string|null }
fetchRemoteChannels()                   // → { channels: {latest,beta,rc} } | { error }
updateProject(projectPath)              // → { ok, from, to, output }
addPlatforms(projectPath, platformIds)  // → { ok, added: string[], output }
upgradeGlobal(channel?)                 // → { ok, from, to, output }
```

冻结的 argv 常量（**不得合并、不得从渲层拼接**）：

| 常量 | 值 | 用在哪 |
| --- | --- | --- |
| `UPDATE_ARGS` | `["update", "--force"]` | 项目升级 |
| `INIT_ARGS_SUFFIX` | `["-y"]` | 新增平台（**不含 `-s`/`-f`**） |
| `GLOBAL_UPGRADE_ARGS` | `["upgrade"]` | 全局升级（自动） |
| `REMOTE_CHANNELS` | `["latest","beta","rc"]` | 通道白名单（唯一定义） |

### 3. Contracts

**进程调用**

| 项 | 约束 |
| --- | --- |
| API | `child_process.execFile`，argv 恒为数组 |
| `cwd` | 用户路径**只**作 `cwd`；永不进 argv，永不拼 shell 字符串 |
| `env` | 经 `mergedExecutionEnv`（`src/codex-queue-delivery.js`）——当前等价于继承 `process.env`，与 `src/updater.js` 同模式 |
| `shell` | 仅 `platform === "win32"` 时为 `true`（解析 `trellis.cmd`） |
| `timeout` | 必设；超时归类照 `src/updater.js` 的 `ETIMEDOUT` / `ESOCKETTIMEDOUT` / `ERR_TIMED_OUT` |

**IPC 信封**（`src/trellis-ipc.js`）

| 通道 | 入参 | 返回 |
| --- | --- | --- |
| `settings:trellis-scan` | `{ channel? }` | `{ status, roots, channels, remote, scans, projects, global, platformCatalog, channelCatalog }` |
| `settings:trellis-set-roots` | `{ roots }` | `{ status }`（**必经 `settings-controller`**） |
| `settings:trellis-add-platform` | `{ path, platforms: [id] }` | `{ status, added }` |
| `settings:trellis-upgrade-global` | `{ channel? }` | `{ status, from, to }` |

**输出解析（身份契约）**

`trellis --version` 写到 **stdout**，但版本行不保证是 stdout 的第一段。当进程 cwd 含 `.trellis/` 时，CLI 给**每个**命令加前缀横幅（源码：`dist/cli/index.js` 的 `checkForUpdates(cwd)`，读 `<cwd>/.trellis/.version` 与 `VERSION` 常量比对，`console.log` 到 stdout）。两个分支都存在：

| cwd 状态 | stdout 实际内容 | 首匹配读到 |
| --- | --- | --- |
| 项目旧于 CLI | `⚠️  Trellis update available: 0.6.0 → 0.7.0-beta.4` … `0.7.0-beta.4` | **`0.6.0`（项目）❌** |
| 项目新于 CLI | `⚠️  Your CLI (0.7.0-beta.4) is older than project (9.9.9)` … `0.7.0-beta.4` | `0.7.0-beta.4`（CLI）✅ |
| 无 `.trellis/` | 仅 `0.7.0-beta.4` | `0.7.0-beta.4` ✅ |

均以 CLI 0.7.0-beta.4 实测。三条结论：

1. 横幅左侧 = **项目**版本，右侧 / 括注里的括号值 = **CLI** 版本。
2. `--version` 因此是 **cwd 相关**的。
3. **错误是分支相关的**：三种 cwd 状态里只有一种错。“我测过了没问题”在这里毫无证明力——换一个 cwd 就静默读到别的项目的版本。

所以解析必须锚定**形状**（整行仅一个版本号），不得锚定**位置**（第一个版本样 token）。形状规则同时天然忽略第二个分支里嵌在散文中的 `9.9.9`。

### 4. Validation & Error Matrix

| 条件 | 行为 |
| --- | --- |
| `isTrustedEvent` 未注入 | **全部**通道 → `{status:"error", message:"untrusted-sender"}`；不 spawn、不写 prefs |
| `isTrustedEvent` 抛错 | 同上（**不得**把 guard 的异常串透传给渲染层） |
| `platformIds` 含表外 id | `{ok:false, error:"unknown-platform"}`；**execFile 不被调用** |
| `channel` 非 `REMOTE_CHANNELS` 成员 | `{ok:false, error:"unknown-channel"}`；**execFile 不被调用**（ipc 与 cli **各校验一次**） |
| 退出码非 0 | `{ok:false}`，**保留原始 stdout/stderr** |
| `--version` 输出无「整行仅版本号」的行 | `{installed:true, version:null}`（不是 `installed:false`） |
| `--version` 的 cwd 含 `.trellis/` | 解析仍取 CLI 版本；但 UI 显示的“已安装版本”含义变窄（见下） |
| 远程查询失败 / 离线 | `remote.error` 有值，`channels` 与 `target` 为 `null` → 渲染「未知」，**绝不当成「已最新」** |

### 5. Good/Base/Bad Cases

- **Good**：`upgradeGlobal("beta")` → argv `["upgrade","beta"]`；`upgradeGlobal()` → `["upgrade"]`
- **Base**：`--version` 输出只有 `0.7.0-beta.4` → 解析得 `0.7.0-beta.4`
- **Bad**：`addPlatforms(dir, ["gemini"])` 产出 `["init","--gemini","-y","-f"]`——`-f` 会让 CLI 跳过 `handleReinit` 增量分支、**从零重建** `.template-hashes.json`，使已登记平台从记录中消失，之后 `trellis update` 静默不再同步它们

### 6. Tests Required

| 断言点 | 位置 |
| --- | --- |
| 无 guard → 全通道 `untrusted-sender` 且 cli 调用计数全 0 | `test/trellis-ipc.test.js` |
| guard 抛错 → 同上（**新分支**，不是只测 guard 缺失） | `test/trellis-ipc.test.js` |
| 不可信 sender 被拒、可信 sender 仍可调用 | `test/trellis-ipc.test.js` |
| `upgradeGlobal()` argv 恰为 `["upgrade"]` | `test/trellis-cli.test.js` |
| `upgradeGlobal("beta")` argv 恰为 `["upgrade","beta"]` | `test/trellis-cli.test.js` |
| 未知 channel → `{ok:false,error:"unknown-channel"}` 且 execFile 未被调用 | `test/trellis-cli.test.js` |
| `addPlatforms` argv 恰为 `["init","--gemini","-y"]`（不含 `-s`/`-f`） | `test/trellis-cli.test.js` |
| 未知 platform id → 不构建 argv | `test/trellis-cli.test.js` |
| 更新横幅（项目旧于 CLI）下取右侧版本，且断言 `!== "0.7.0-beta.3"` | `test/trellis-cli.test.js` |
| 第二个横幅分支（CLI 旧于项目，版本嵌在散文里）也取 CLI 那行 | `test/trellis-cli.test.js` |
| 不可解析输出 → `installed:true, version:null` | `test/trellis-cli.test.js` |

### 7. Wrong vs Correct

#### Wrong — 锚定位置，读到另一个主体的版本

```js
const VERSION_OUTPUT_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
function parseVersionOutput(text) {
  const m = String(text || "").match(VERSION_OUTPUT_RE);   // 第一个版本样 token
  return m ? m[0] : null;                                 // ← 可能是【项目】版本
}
```

横幅存在时返回 `0.7.0-beta.3`（项目的），而 CLI 实为 `0.7.0-beta.4`。更糟的是：**升级任意项目都会改变这个读数**，于是 bug 表现为「全局 CLI 版本莫名其妙变了」。而且它**只在“项目旧于 CLI”这个分支错**，另两个分支碰巧对——所以随手测一下很可能测不出来。

#### Correct — 锚定形状，跳过横幅

```js
const VERSION_LINE_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
function parseVersionOutput(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {      // 倒序：末行仅版本号者胜
    const t = lines[i].trim();
    if (VERSION_LINE_RE.test(t)) return t.replace(/^v/, "");
  }
  const m = lines.join("\n").match(VERSION_OUTPUT_RE);  // 兜底：形如 "trellis v0.7.0"
  return m ? m[0] : null;
}
```

横幅行永远不是「整行仅版本号」，因此该形状对三个方向的横幅都成立（项目旧于 CLI、新于 CLI、无横幅）。

### 附带：跨层教训

**同一份人类可读输出里常混着不同主体的数字。** 信任之前先确定「这个数是谁的」，并把解析锚在不歧义的**形状**上，而不是**位置**上。位置会随无关状态（这里是 cwd）改变；形状不会。

**分支相关的错误比稳定错误更危险。** 这里的错误只在三种 cwd 状态中的一种出现，另两种碰巧正确。“我手动试过，是对的”在此毫无证明力。设计断言时要问：“这个错误在哪些输入下**不**出现？”——只覆盖“会错”的那一侧，并把另一侧也写成用例，否则重构时很容易把它改回错的。

**实测的证伪（本 spec 的测试有效性证据）**：把 `parseVersionOutput` 临时改回位置锚定后重跑：

```
✖ reads the CLI version, not the project version in the startup banner   ← 被抓
✔ reads the CLI version from the other banner branch too                 ← 碰巧通过
```

即：**两个分支用例里只有一个能抓到该 bug**。所以“有一个用例失败了”不等于“测试够了”；反过来，若当初只写了分支 B，这次 bug 会全程绿灯。

同一个 `--version` 既是 cwd 相关的，就意味着「已安装版本」只在**工具找不到项目的 cwd** 下才有唯一含义。若将来复用这个函数，必须显式保证 cwd 干净（`/tmp` 或应用目录），否则会静默读到某个项目的版本。建议在任何复用点旁写下这个前提。
