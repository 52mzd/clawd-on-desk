# Design：多 trellis CLI 检测与清理向导

## 数据流

```
main.js createTrellisCli(env: augmentedCliPath PATH)
  └─ trellis-cli.js readGlobalVersion()
       ├─ scanTrellisBinPaths(executionEnv.PATH)   ← 全量收集（新纯函数）
       ├─ 每个路径 spawn <path> --version          ← 绝对路径，stub 按 bin 路由
       └─ → { installed, version, error, path, installs: [{path, version, active}] }
  └─ trellis-runtime.js scan() 透传 global（零改动，128-143 行整体放进 payload）
  └─ settings-tab-trellis.js buildGlobalSection
       └─ installs.length > 1 → 渲染列表 + buildCleanupCommand + buildCopyButton
```

## D0 关键架构决策：清理命令在 cli 层生成、随 payload 下发

`settings-tab-trellis.js` 是 renderer 脚本（vm 沙箱加载，零 require），不能 import
主进程的 buildCleanupCommand。因此 **installs 条目自带 `cleanup` 字段**（cli 层生成），
renderer 纯渲染零命令生成——与 spec「argv 只在 main 构造、不得从渲层拼接」同一红线。

## D1 扫描收集（src/trellis-cli.js）

**`scanTrellisBinPaths(basePath, options)` → `string[]`（新导出纯函数）**

- 与 `resolveTrellisBinPath` 同一探测逻辑（`statSync().isFile()` follow symlink +
  `accessSync(X_OK)`），但**收集全部**命中（PATH 顺序，不排序）
- win32 → `[]`（spawn 走 shell 解析 .cmd，本探测无法建模——与 resolveTrellisBinPath
  同语义）
- `resolveTrellisBinPath` 重构为 `scanTrellisBinPaths(...)[0] ?? null`（DRY，行为不变）

**`readGlobalVersion()` 重构（工厂内）**

- 先 `scanTrellisBinPaths(executionEnv.PATH)` 拿全量 → 每个路径
  `run(path, VERSION_ARGS, { timeoutMs: versionTimeoutMs })`（绝对路径可直接作 bin，
  execFile 支持；win32 shell 分支同样可行）→ `parseVersionOutput(result.stdout)`，
  失败 → `version: null`
- 组装 `{ installed, version, error, path, installs }`：
  - installs 条目 `{path, version, active, cleanup}`——cleanup =
    `buildCleanupCommand(path)`（active 条目也带，UI 按需取用）
  - 首个命中（index 0）的 spawn 结果 → installed/version/error/path（**与现状语义
    一致**：单装时 `installs=[{...,active:true}]`，`path`/`version` 取它）
  - 无任何安装 → `installed:false, version:null, error:null, path:null, installs:[]`
    ——注意与现状的差异：现状 `installed:false` 带 spawn ENOENT error；新逻辑无 spawn
    发生，error 用 null（「未装」不是错误）。既有测试若断言 error 存在需同步改
  - `active` = `index === 0`（PATH 顺序，与 spawn `trellis` 名字解析的命中序一致）
- spawn 次数 = 安装数（通常 1-3），单装环境零增量

## D2 清理命令生成（src/trellis-cli.js 纯导出，可测）

**`buildCleanupCommand(binPath, options)` → `string | null`**

1. `fsImpl.realpathSync(binPath)` 跟出真身；抛错 → `null`
2. 真身匹配 `^(.+)\/lib\/node_modules\/@mindfoldhq\/trellis\//`（posix 段拼接，
   REMOTE_PACKAGE 常量复用）→ npm 布局 →
   `npm uninstall -g @mindfoldhq/trellis --prefix <prefix>`
   - prefix = 捕获组（`~/.npm-global`、`/usr/local`、`/opt/homebrew` 都符合
     npm prefix 布局）
3. 非 npm 布局 → `rm -f <binPath>`（只删入口 symlink/文件）
4. sudo 判定：npm 布局试 prefix 目录、rm 布局试 binPath 所在目录的
   `accessSync(dir, W_OK)`；不可写（含抛错）→ 命令前缀 `sudo `
5. 路径含空白/引号 → 单引号包裹 + 内部 `'` 转义 `'\''`（shell quote，防命令断裂）

**红线**：本函数只产字符串；全链路无任何执行点（ipc/runtime/settings 均不 spawn 它）。

## D3 UI（src/settings-tab-trellis.js + src/settings.css）

`buildGlobalSection` 版本 + 路径小字之后追加：

- 条件：`Array.isArray(global.installs) && global.installs.length > 1`
- 结构：
  - 标题行 `tf("trellisCliInstallsTitle", { count })`（buildDescRow 同款弱化行）
  - 每条 install 一行（`.trellis-cli-install-row`）：
    `[✓ 生效 | ⚠ 多余·版本] [路径 ellipsis + title] [复制按钮?]`
    - active → `t("trellisCliInstallActive")`，样式 `.is-active`（正面色）
    - 非 active → `t("trellisCliInstallExtra")` + 版本号，样式 `.is-extra`（警示色）
    - 非 active 行 `install.cleanup` 为非空 string → `buildCopyButton(install.cleanup)`
      （命令来自 payload，renderer 零生成）
    - version null 显示 "—"
- CSS：`.trellis-cli-installs` 列表容器 + 行 flex；路径复用 `.trellis-cli-path` 的
  ellipsis 惯例（max-width 可放宽到 280px）
- 单装 / 无 installs 字段：零渲染（现状不变）

## D4 i18n（src/settings-i18n.js，7 语言各加 3 键）

- `trellisCliInstallsTitle`: "Detected {count} CLI installs" / 「检测到 {count} 个 CLI 安装」
- `trellisCliInstallActive`: "Active" / 「生效」
- `trellisCliInstallExtra`: "Redundant (safe to remove)" / 「多余（可清理）」

复制按钮复用现有 `trellisCopy`/`trellisCopied`，不加键。

## 兼容与回滚

- `global.installs` 纯增量：runtime/ipc 零改动透传；老版本 renderer 读新 payload 只多
  忽略一个字段，新 renderer 读老 payload（installs 缺失）不渲染向导
- 回滚点：D1/D2/D3 各自独立可退；最坏 revert 单 commit

## 测试策略

| 层 | 用例 | 文件 |
|---|---|---|
| cli | scanTrellisBinPaths：多命中收集顺序 / 单命中 / 无命中 / win32 空 | test/trellis-cli.test.js |
| cli | readGlobalVersion：双 tmp bin 目录 + stub 按绝对路径路由两版本 → installs 两条、active/version/cleanup 对应；PATH 隔离单装 → installs 一条；无安装 → installed:false + installs:[] | 同上 |
| cli | buildCleanupCommand：npm 布局不可写 prefix（fake fs 拒 W_OK）→ sudo uninstall；可写 prefix → 无 sudo；非 npm 布局 → rm；realpath 抛错 → null；空格路径 → 单引号 | 同上 |
| ipc | scan 投影：fake cli 返回带 installs 的 global → result.global.installs deepEqual | test/trellis-ipc.test.js |
| ui | 多装渲染两行 + 多余行复制按钮 + 标题 count；单装无列表；无 installs 字段无列表 | test/settings-tab-trellis.test.js |
| ui | 复制按钮点击 → clipboard.writeText 收到清理命令 | 同上 |

fixture 技巧：makeExecFileStub 的 handlers 按 bin 键路由——绝对路径即键，天然支持
「每个安装回不同版本」。
