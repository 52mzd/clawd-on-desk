# 执行计划 — Clawd Trellis 管理面板

依赖关系：阶段 1 → 2 → 3 → 4 严格串行（后者 import 前者）；阶段 5、6 可在 1-4 之后并行；阶段 7 依赖 6；阶段 8 依赖全部。

每个阶段的验证命令都是独立的，**不要用"整体 npm test 通过"代替阶段验证**——阶段验证要能定位到具体失败模块。

---

## 阶段 0 — 前置检查（不写代码，只读确认）

先回答 design §9 的四项前置检查，答案写进本文件末尾的"前置检查结论"。

- [ ] **A** 读 `src/preload-settings.js`：确认既有订阅暴露模式（是否有白名单 `ipcRenderer.on` 包装 / `contextBridge` 订阅列表），记录要照抄的函数形态
- [ ] **B** 读 `src/prefs.js` 的 `validate()`：确认对未知键是丢弃还是保留（决定回滚残余是否无害）
- [ ] **C** 读 `src/settings-i18n.js` 的取用函数：确认缺失 key 的运行时行为（回落 en / 裸露 key）
- [ ] **D** 读 `package.json` 的 `build.files`：确认新增 `src/*.js` 是否被通配覆盖
- [ ] **E** 读 `src/settings-tab-shortcuts.js` 全文：确认 tab 文件的确切骨架（core 注册名、`render`/`init` 签名、触发重建的 API、事件订阅与退订时机）

**验证**：把结论写进本文件，不要凭猜测进入阶段 1。
**回滚点**：无改动。

---

## 阶段 1 — 版本逻辑（纯函数）

- [ ] 新建 `src/trellis-version.js`
  - `inferChannel(version)` → `"latest" | "beta" | "rc"`（`-beta.` / `-rc.` 判定）
  - `compareVersions(a, b)` → `-1 | 0 | 1`（base 三段数字 → prerelease 规则）
  - `evaluate({ current, channels, channel })` → `{ target, upgradable }`，`channels` 为 null 时全部返回 `null`
- [ ] 新建 `test/trellis-version.test.js`

**验证**：`node --test test/trellis-version.test.js`
**必须覆盖**：等值→不可升级；`0.7.0-beta.3` vs `beta:0.7.0-beta.4`→可升级；本地比远程新→不可升级（不显示降级）；`channels=null`→`upgradable=null`；`0.6.17` 走 `latest` 而非 `beta`。
**回滚点**：删除两个文件即完全回滚。

---

## 阶段 2A — 平台映射表与解析

- [ ] 新建 `src/trellis-platforms.js`
  - 导出 `PLATFORMS`：21 项 `{ dirPrefix, id, cliFlag, label }`（表见 design D10，数据取自 CLI `AI_TOOLS.configDir` 的第一段）
  - `IGNORED_PREFIXES = new Set([".trellis", "AGENTS.md", ".agents"])`
  - `parsePlatforms(hashes)` → `string[]`（入参为 `hashes` 对象；取键的第一段，剔除 `IGNORED_PREFIXES`，经表映射为 id；**未知前缀保留为 `unknown:<prefix>` 而不是丢弃**；结果去重、按 `PLATFORMS` 顺序稳定）
  - `flagsFor(ids)` → `string[]`（如 `["--gemini"]`；未知 id → 抛/返回错误标记，由调用方 fail closed）
  - `staleOf(projectPath, ids)` → `boolean`（记录里有该平台，但 `path.join(projectPath, dirPrefix)` 不是目录）
  - 纯逻辑 + 可选 `fs.existsSync`；零 spawn；任何异常吞掉返回 `[]` / `false`
- [ ] 新建 `test/trellis-platforms.test.js`

**验证**：`node --test test/trellis-platforms.test.js`
**必须覆盖**：
  - **21 条映射双向断言**：`parsePlatforms({ ".gemini/x": "h" })` → `["gemini"]`；`flagsFor(["gemini"])` → `["--gemini"]`；逐条跑全 21 项（防 CLI 改 `configDir` 时静默误报）
  - `IGNORED` 前缀被剔除：`.trellis/workflow.md`、`AGENTS.md`、`.agents/skills/x` 均不出现在结果里
  - 未知前缀保留：`{ ".futuretool/a": "h" }` → 结果含 `unknown:.futuretool`（不丢、不猜成已知平台）
  - 空对象 / `null` / 非对象 → `[]`，不抛
  - 多级 configDir 的归一化：`.kiro/skills/...`、`.github/copilot/...`、`.agent/workflows/...`、`.devin/workflows/...`、`.snow/skills/...` 都归到第一段且命中正确 id
  - `staleOf`：记录有 `.gemini` 但目录不存在 → `true`；目录存在 → `false`
**回滚点**：删除两个文件。

---

## 阶段 2B — 扫描器

- [ ] 新建 `src/trellis-scanner.js`
  - `readProjectVersion(projectPath)` → `string | null`（读 `<p>/.trellis/.version`，trim，任何错误 → null）
  - `readHashes(projectPath)` → `object | null`（读 `<p>/.trellis/.template-hashes.json`；解析出 `hashes` 对象；任何错误 → `null`，**不得抛异常**）
  - `readPlatforms(projectPath)` → `string[]`（`parsePlatforms(readHashes(p) ?? {})`）
  - `scanRoot(root)` → `{ root, readable: boolean, projects: [...] }`（每项带 `platforms`、`staleRecord`）
  - 过滤规则见 design D2：非目录跳过、`.` 开头跳过、`node_modules` 跳过、**symlink 先判先跳**
- [ ] 新建 `test/trellis-scanner.test.js`（用 `fs.mkdtemp` 造 fixture）

**验证**：`node --test test/trellis-scanner.test.js`
**必须覆盖**：已安装/未安装混合且顺序稳定；`.hidden` 与 `node_modules` 被跳过；symlink 指向外部含 `.trellis` 的目录时**不出现**在结果里；含空格与 `&`、`'` 的目录名可正常扫描；根不存在时不抛异常。
**平台专项**（design D10 / D12）：
  - fixture 写 `{"__version":2,"hashes":{".claude/x":"h",".pi/y":"h",".trellis/z":"h"}}` → `platforms = ["claude-code","pi"]`
  - 记录含 `.gemini` 但无 `.gemini` 目录 → `staleRecord === true`
  - 记录的平台目录都存在 → `staleRecord === false`
  - manifest 缺失 / 非 JSON / `hashes` 非对象 → `platforms = []`、**不抛异常**
  - **回归用例**：fixture 内同时放 `.template-hashes.json`（含 `.claude`/`.pi`）与对应目录 → 结果与 `trellis platforms` 的语义一致（不依赖任何目录名猜测）
**回滚点**：删除两个文件。

---

## 阶段 3 — CLI 执行层

- [ ] 新建 `src/trellis-cli.js`，导出工厂 `createTrellisCli({ execFileImpl, env, platform, timeoutMs })`
  - `readGlobalVersion()` → `{ installed, version }`（`trellis --version`）
  - `fetchRemoteChannels()` → `{ channels } | { error }`（`npm view @mindfoldhq/trellis dist-tags --json`，`JSON.parse` 后只取三个已知通道）
  - `updateProject(projectPath)` → `{ ok, from, to, output }`（`["update", "--force"]`，`cwd = projectPath`）
  - `upgradeGlobal()` → `{ ok, from, to, output }`
  - `addPlatforms(projectPath, platformIds)` → `{ ok, added[], output }`：args 为 `["init", ...flagsFor(ids), "-y"]`，cwd = projectPath（见 design D13）
  - **后缀常量只允许 `INIT_ARGS_SUFFIX = ["-y"]`**：**不得**出现 `-s` / `-f`。实测两者都会绕过 `handleReinit` 增量分支、退化为 full init 并重建 `.template-hashes.json`，使旧平台从记录中消失
  - **白名单校验**：`platformIds` 逐项必须在 `PLATFORMS` 表内，任一未知 → 整次调用返回 `{ok:false, error:"unknown-platform"}`，不拼进 argv
  - **不要**提供 `runDryRun` / `--dry-run` 封装：`trellis update --dry-run` 会写 `.trellis/.version`，不是只读命令（见 design D11）
- [ ] `env` 走 `mergedExecutionEnv`（来自 `src/codex-queue-delivery.js`），不要自己拼 PATH
- [ ] 新建 `test/trellis-cli.test.js`（注入 fake `execFileImpl`）

**验证**：`node --test test/trellis-cli.test.js`
**必须覆盖**：argv 恒为数组且含 `--force`；`cwd` 等于传入路径；
**新增平台专项**：`addPlatforms(dir, ["gemini"])` → argv **恰为** `["init","--gemini","-y"]`（不含 `--force`、不含 `-s`、不含 `-f`）；`cwd` = 传入路径；传入未知 id（如 `"--evil"` 或 `"pi; rm -rf /"`）→ 返回 `{ok:false}` 且 **fake execFile 未被调用**；`timeout` 已设置；`platform==="win32"` → `shell:true`，其余 → 无 `shell`（或 `false`）；非零退出码 → `{ok:false}` 且保留 stdout/stderr；`--version` 输出解析（含 `v` 前缀与换行）；`npm view` 返回非 JSON → `{error}` 而非抛异常。
**回滚点**：删除两个文件。

---

## 阶段 4 — 编排与并发

- [ ] 新建 `src/trellis-runtime.js`，导出 `createTrellisRuntime({ cli, scanner, prefsSnapshot, emit, platform })`
  - `scan()`：读 roots → 扫描 → 单次远程查询（60s TTL 缓存）→ 组装快照
  - `preview(paths)` → `plan[]`（**纯计算**：平台 + from + to + 将执行命令；**不调用 cli 任何方法**，见 design D11）
  - `startBatch(paths)` → `{ batchId }`；内部信号量上限 3；逐项 `emit(progress)`
  - `cancelBatch()`：置标志 + kill inflight，不再启动新项
  - `upgradeProject(path)` / `upgradeGlobal()` 单发路径
  - `invalidateRemoteCache()`（供"重试"按钮）
- [ ] 新建 `test/trellis-runtime.test.js`（fake cli，可控延迟）

**验证**：`node --test test/trellis-runtime.test.js`
**必须覆盖**：
  - 一次 `scan()` 内 `fetchRemoteChannels` 只被调用一次
  - 第二次 `scan()` 命中 TTL 缓存，仍只调用一次
  - **`preview()` 不调用 fake cli 的任何方法**（断言调用计数为 0），返回的 plan 含正确的 from/to/command
  - 峰值并发 ≤ 3（fake cli 里记录同时 inflight 计数）
  - 1 项失败不影响其余项完成，summary 计数正确
  - `cancelBatch()` 后 inflight 被 kill，队列中未启动项不再启动
  - 远程查询失败时快照里 `upgradable` 全为 `null`（不是 `false`）
**回滚点**：删除两个文件。

> **REVIEW GATE 1**：阶段 1-4 全部测试通过后暂停一次，汇报给用户确认纯逻辑层行为（尤其 D4 版本比较与 D5 并发语义），再进入接线。

---

## 阶段 5 — prefs 字段

- [ ] `src/prefs.js`：`SCHEMA` 内新增 `trellisScanRoots`（`type:"array"` + `defaultFactory: () => []` + `normalize: normalizePathList`）
- [ ] **不** bump `CURRENT_VERSION`（无迁移需求）；若阶段 0 的 B 项结论要求，再补迁移分支
- [ ] 补/扩 `test/prefs*.test.js`：默认值为 `[]`、normalize 会去重与规整路径

**验证**：`node --test test/prefs.test.js`（或仓库实际的 prefs 测试文件名）
**回滚点**：还原该字段；若已落盘，残余 `trellisScanRoots` 依阶段 0-B 结论决定是否无害。

---

## 阶段 6 — IPC 接线

- [ ] `src/preload-settings.js`：按阶段 0-A 确认的模式新增
  - `trellisScan()` / `trellisPickRoot()` / `trellisSetRoots()` / `trellisPreview()` / `trellisUpgradeProject()` / `trellisUpgradeAll()` / `trellisCancelBatch()` / `trellisAddPlatform()` / `trellisUpgradeGlobal()`
  - `onTrellisProgress(cb)` + 返回退订函数
- [ ] 新建 `src/trellis-ipc.js`：照 `src/settings-ipc.js` 的 `handle()` + disposers 模式注册 design §4.2 的通道
  - 每个 handler 自带 try/catch，错误 → `{ status:"error", message }`
  - `trellis-pick-root` 用 `dialog.showOpenDialog({ properties: ["openDirectory"] })`，取消 → `{ status:"cancel" }`
  - **IPC 信任门禁（fail closed）**：`settings-ipc.js` 导出 `isTrustedEvent`，`trellis-ipc.js` 注入并**在 handler 之前**校验；注入缺失或抛错 → 所有通道返回 `{status:"error", message:"untrusted-sender"}`。未授权调用不得 spawn 进程、不得写 prefs
  - `trellis-set-roots` **必须经 settings-controller 写 prefs**，不得自行落盘
  - `trellis-add-platform` 的 `platforms` 入参**必须**在 `trellis-ipc.js` 层做白名单校验（未知 id → `{status:"error"}`），再交给 cli；**不接受任何来自渲染层的额外 argv**
  - 进度 `emit` → `webContents.send("settings:trellis-progress", …)`
- [ ] `src/main.js`：require 并调用注册器（沿用既有 runtime 接线块）

**验证**：`node --test test/settings*.test.js`；再手工确认 Settings 窗口打开无控制台报错（`npm start`）
**回滚点**：摘掉 main.js 的注册调用，通道即失效；renderer 尚未引用，不会崩。

---

## 阶段 7 — UI

- [ ] 新建 `src/settings-tab-trellis.js`（骨架照 `src/settings-tab-shortcuts.js`）
  - 区块 1：扫描根列表（添加按钮 → `trellisPickRoot`；每项可移除 → `trellisSetRoots`）
  - 区块 2：工具条（刷新 / 预览 / 全部升级 / 取消 / 远程版本与重试）
  - 区块 2.5：预览面板（平台、`当前 → 目标`、将执行命令；只读）
  - 区块 2.7：平台筛选（多选 21 平台，筛列表）与**新增平台**入口（选目标平台 → 预览"将新增 X / 将执行 `trellis init --x -y`" → 确认执行）
  - 区块 3：项目表（名称、路径、**已配置平台**、当前版本、目标版本、状态徽标、操作）
  - 区块 4：全局 CLI（当前版本 / 远程版本 / 升级按钮 / 未安装引导）
  - 订阅 `onTrellisProgress` 更新行状态；**tab 不可见或销毁时退订**
  - 无扫描根 → 空态引导；远程失败 → 顶部警示条
- [ ] `src/settings.html`：加 `<script src="settings-tab-trellis.js">`（在 `settings-renderer.js` 之前）
- [ ] `src/settings-renderer.js`：tab 定义数组加一项（id `trellis`）+ 对应 `init` 调用
- [ ] `src/settings-window.js`：`ALLOWED_TABS` 加 `trellis`
- [ ] `src/settings-icons.js`：加 `trellis` key
- [ ] `src/settings-i18n.js`：加 `tabTrellis` 文案组 × **7 语言**（`en / zh / zh-TW / ko / ja / pt-BR / es`，无 zh-CN），key 顺序与 arity 完全对齐

**验证**：
  - `node --test test/i18n.test.js`（locale parity 必须通过）
  - `node --test test/settings*.test.js`
  - 手工：`npm start` → 打开 Settings → 切到 Trellis tab → 添加一个目录 → 列表出现 → 切 tab 再切回来 UI 不重复订阅/不错乱

**回滚点**：删除 tab 文件 + 还原 5 处接线。

---

## 阶段 8 — 集成与真机验证

- [ ] `npm test` 全量通过
- [ ] 手工验收（逐条对照 prd 的 Acceptance Criteria）：
  - [ ] 添加目录 → 列出全部直接子目录，已安装项版本号与 `cat <p>/.trellis/.version` 一致
  - [ ] 重启 Clawd 后扫描根仍在
  - [ ] 观察日志/计数：一次刷新只发生一次 `npm view`
  - [ ] 单项升级一个落后项目 → 版本号变为目标通道版本，徽标转"最新"
  - [ ] "全部升级"并发 ≤ 3；人为让一项失败（如只读目录），其余完成且给出汇总
  - [ ] 取消批量 → 不再启动新项
  - [ ] 用户能预览升级（平台 / `当前 → 目标` / 将执行的命令），且**预览前后全项目 shasum 无任何变化**
  - [ ] 列表展示每个项目的**已配置平台**，与该项目 `.trellis/.template-hashes.json` 的 `hashes` 键前缀（剔除 `.trellis`/`AGENTS.md`/`.agents`）一致；在 21 平台全配置的项目上与 `trellis platforms` 输出一致
  - [ ] **新增平台**：对已配置 `.claude` 的项目执行"新增 Gemini"→ `.gemini` 出现、面板平台列出现 `Gemini CLI`；**执行前先在 `.claude/agents/trellis-implement.md` 加一行本地改动，执行后该行仍在**
  - [ ] 新增平台后 `.template-hashes.json` 是**并集**（旧平台前缀仍在），不是只剩新平台
  - [ ] 重复执行同一"新增平台"→ CLI 输出 `already configured, skipping`，记录不变、目录不变
  - [ ] 新增平台在执行前有预览（将新增平台 + 将执行命令），且未确认前零写入
  - [ ] Clawd 在任何路径下都未改写 `.template-hashes.json`（可用 `shasum` 在整轮操作前后比对）
  - [ ] 平台多选筛选生效：只勾 `Pi` 时列表只保留含 Pi 的项目
  - [ ] 全局区显示真实 `trellis --version`；升级入口可执行
  - [ ] **含空格路径**的项目可扫描且可成功升级
  - [ ] 全程不点击时，任何项目 `.trellis/` 内容不变（`shasum` 对比）
  - [ ] 离线 / 无扫描根 / 目录不可读 三种降级都有明确 UI 反馈
  - [ ] 切到 7 种语言各看一遍新 tab 无裸露 key

**验证**：`npm test`
**回滚点**：整体删除新增文件 + 还原接线。

---

## 阶段 9 — 收尾

- [ ] `.trellis/spec/` 按需补充（本仓库 spec 层为 frontend；如新增了可复用约定则记录）
- [ ] 更新 `docs/`：如有用户可见行为，考虑在 `docs/guides/` 或 README 功能列表补一句
- [ ] commit（遵循仓库既有 commit 风格）

---

## 前置检查结论

（阶段 0 完成后填写）

- A（preload 订阅模式）：`src/preload-settings.js` 用 **模块级 `Set` + 单个 `ipcRenderer.on(channel, …)` 注册一次**，回调遍历 Set 并逐个 `try/catch`；`contextBridge.exposeInMainWorld` 里暴露 `onXxx(cb)`，形如 `if (typeof cb !== "function") return () => {}; xxxListeners.add(cb); return () => xxxListeners.delete(cb);`。订阅者拿到退订函数。例外：`onAnimationPreviewPosterReady` 用一次性 `ipcRenderer.on` + `removeListener` 返回退订（阶段 6 照抄 Set 形态即可）。
- B（prefs 未知键处理）：**丢弃**。`validate()`（`src/prefs.js:617`）从 `getDefaults()` 起手，只遍历 `SCHEMA_KEYS`，raw 中的未知键既不被读取也不被回写。所以回滚后残留的 `trellisScanRoots` 会被旧版 Clawd 静默丢弃，属无害死键；反向（旧 prefs 缺键）走 `defaultFactory` → `[]`，无需迁移分支。
- C（i18n 缺失 key 行为）：`src/settings-ui-core.js:302` 的 `t(key)` 为 `dict[key] || STRINGS.en[key] || key` —— **先回落 en，en 也缺则原样返回 key**（裸露 key 到 UI）。因此 7 语言必须同时补齐，parity 断言（`test/i18n.test.js`）会先失败。
- D（build.files 覆盖）：`package.json` 的 `build.files` 含 `"src/**/*"`，新增 `src/trellis-*.js` **已被通配覆盖**，无需改打包配置。
- E（tab 骨架要点）：`src/settings-tab-shortcuts.js` 是 IIFE `(function initSettingsTabShortcuts(root) { … })(globalThis)`；模块级闭包变量 `state/runtime/readers/helpers/ops/i18n` 在 `init(core)` 里从 `core` 解构赋值，最后执行 `core.tabs.<id> = { render }`；`t(key)` 走 `helpers.t(key)`；`render(parent)` 只 `document.createElement` + `parent.appendChild`（无 innerHTML）；DOM 事件用 `addEventListener` 且用 `listenersAttached` 标志防重复挂载；跨 tab 的长期订阅应在 render 时挂、销毁时退订。阶段 7 照此骨架。

---

## REVIEW GATE 2 — 独立质量检查结论（阶段 7 后）

**结论：无阻断项。** 12 条铁律全部成立；全量测试失败文件集合 64:64 与基线完全一致（零新增）；新增测试全绿（trellis 6 文件 108 用例 + tab 8 + i18n 24 + prefs 207 + preload 5）。
真机 E2E（真实 `trellis` CLI v0.7.0-beta.3，全部在 `/tmp` fixture）已验证：扫描过滤、平台与 `trellis platforms` 逐条一致、预览零写盘零 spawn、`addPlatforms` argv 精确为 `["init","--gemini","-y"]` 且记录变并集、用户改动保留、批量并发峰值 = 3、取消后不再启动新项、特殊字符路径升级成功、CLI 缺失时无异常。

### 必须补做（阶段 7.5）

- [ ] **#1 目录不可读降级无 UI 反馈**（AC 明确点名）：`runtime.scan()` 已返回 `scans[].readable`，但 tab 从不消费。需在扫描根列表与项目表上区分「读不到」与「没有子目录」
- [ ] **#2 R3 通道覆盖未接线**：`runtime` 的 `channelOverride`/`channelFor()` 是**不可达死代码**。需接 IPC 入参 + tab 全局通道下拉（latest/beta/rc）
- [ ] **#3 R10 修复命令拿不到**：stale 平台已被记录占用，被 add-panel 的 `!configured.has(id)` 过滤掉 → 用户在 UI 内无法取得 `trellis init --<platform> -y`。需在 stale 提示处直接给可复制命令
- [ ] **#4 stale 文案错误陈述**：当前展示「记录中包含 <全部平台>，但对应目录不存在」，而只有部分平台缺失。需让 scanner 暴露 `staleIds` 子集
- [ ] **#5 信任判定抛错时透传内部错误**：design §4.2.1 要求 guard 缺失**或抛错**都返回 `untrusted-sender`；当前 catch 会把 guard 的异常原样交给 `errorResult()`。需在 guard 外再包一层
- [ ] **#6 「全部升级」忽略平台筛选**：`upgradablePaths()` 不看 `filterIds`，会升级用户看不见的项目。需与筛选联动（并让按钮计数反映实际范围）

### 顺带（低成本）

- [ ] **#8 `batchRunning` 竞态**：应在 `await` **之前**置位，避免批次早于应答结束时按钮永久可用
- [ ] **#10 `CHANNELS` 重复定义**：tab 的 `["latest","beta","rc"]` 与 `trellis-cli.js` 的 `REMOTE_CHANNELS` 各一份，需从 scan 结果取
- [ ] **#11 `mergedExecutionEnv` 注释过强**：该 helper 只是 `{...process.env, ...env}`，并不解决 GUI PATH 缺失；需修正注释而非改行为

### 已知且按设计接受（不再改）

- **#7** `scans` 与 `projects` 载荷重复 —— 接受（便于 #1 实现）
- **#12** 真实 `trellis update --force` 写回的是 **CLI 自身版本**，非 channel 的 `target`。→ **PRD 的 AC 表述已据此修正**
- **#13** `unknown:` 平台不参与筛选 —— 接受（R8 只要求展示不丢弃）
- **D5** 并发上限「可下调不可上调」—— 接受（design D5 定为 3）

## 全局风险提示

1. **`trellis update` 无参是交互式的**——任何调用路径都必须带 `--force`（或 `--create-new` / `--skip-all`），否则会在无 TTY 下挂到超时。
2. **不要用"跑 `trellis update` 是否报错"判断是否已安装**——非 Trellis 目录会进入 init 引导流程。判定只认 `.trellis/.version`。
3. **`upgradable: null` 与 `false` 语义不同**，渲染层不得把 null 当 false 显示成"已最新"。
4. **语言是 7 种不是 8 种**（无 zh-CN）；i18n parity 测试会立刻抓到错位。
5. **路径只作 `cwd`**，永远不进 argv、不进 shell 字符串。
6. **`trellis update` 没有平台参数**（实测 `--help` 仅 `-f/--force`、`-s/--skip-all`、`-n/--create-new`，且**不接受 `-y`**）——它只为 `.template-hashes.json` 里登记的平台同步模板。平台选择只能是展示 / 筛选语义，不要试图用临时改写平台目录或记录文件来"限定升级平台"。
7. **新增平台只带 `-y`**：`trellis init --<platform> -y`。**带 `-s` 或 `-f` 都会绕过 `handleReinit` 增量分支**（`init.js:1511`），退化为 full init 并**从零重建记录**，使旧平台从记录中消失、后续 update 不再同步它们。路径常量必须分开定义。
8. **renderer 只能传 platform id，主进程做白名单映射**：绝不让渲染层传来的字符串直接进 argv；后缀固定为 `["-y"]` 常量。
9. **平台映射表必须覆盖 21 项且可测**：数据源是 CLI 的 `AI_TOOLS.configDir` 第一段；`test/trellis-platforms.test.js` 逐条断言，CLI 改动时测试失败而非静默误报。未知前缀保留为 `unknown:<prefix>`，不丢弃。
10. **`.trellis/.template-hashes.json` 是平台配置的权威来源**，Clawd 只读不写：不得改写它，也不得据"目录存在"自行推断平台（早期版本基于目录猜测的方案已废弃 —— 记录与 CLI 自身语义一致，是唯一事实）。
11. **禁用 `trellis update --dry-run`**：实测它会写 `.trellis/.version`（项目版本 ≠ CLI 版本时）。预览只能纯计算。同理不要写任何封装把 `--dry-run` 暴露给 UI。
