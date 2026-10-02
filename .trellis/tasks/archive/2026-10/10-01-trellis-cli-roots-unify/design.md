# Design：Trellis CLI 发现修复三连

## 现状与根因（已实证）

- GUI app 继承 launchd PATH；`src/trellis-cli.js` 的 `augmentedCliPath` 补
  `/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`，由 `src/main.js:5295`
  注入 `createTrellisCli` 的 env
- npm 全局安装落点随 Node 来源变化（官方 pkg → `/usr/local`；Homebrew ARM →
  `/opt/homebrew`；nvm → `~/.nvm/versions/node/<v>/bin`；volta/pnpm/bun/自定义
  prefix 各有目录）——除前两个外全是 GUI 盲区
- `readGlobalVersion()` spawn `trellis --version`，解析形状锚定（spec
  trellis-panel-contract §输出解析），显示的是「它调用的那个 CLI」的版本，无路径线索
- Dashboard roots 存 `~/.clawd/trellis-roots.json`（`src/trellis-roots.js`，
  "Deliberately NOT prefs"），入口只有面板 picker 与会话发现
  `autoRegisterDiscoveredRoot`（`src/main.js:2502`）；Settings 的
  `trellisScanRoots`（`src/prefs.js:473`）只喂 Settings 升级面板

## D1 PATH 扩充（`src/trellis-cli.js`）

```js
const GUI_PATH_EXTRA_DIRS = Object.freeze([
  "/opt/homebrew/bin",       // Homebrew, Apple Silicon（既有）
  "/usr/local/bin",          // Homebrew Intel / 官方 pkg（既有）
]);

// POSIX only，追加在 GUI_PATH_EXTRA_DIRS + ~/.local/bin 之后
// ~/.npm-global/bin   — npm 官方排障文档推荐的自定义 prefix（用户实机场景）
// ~/.bun/bin          — bun
// ~/Library/pnpm      — pnpm 全局 bin
// ~/.volta/bin        — volta
```

- nvm 枚举：`fs.readdirSync(path.join(home, ".nvm", "versions", "node"),
  { withFileTypes: true })` 过滤真目录，每个追加 `<dir>/bin`；版本名倒序
  （`localeCompare(b, undefined, { numeric: true })`），新版本先命中
- 纯度：现有函数只拼字符串；nvm 枚举引入 fs，签名加 `options.fs`（默认
  `require("fs")`）保持可测，且复用现有 `options.home`
- 兼容性：全部追加在既有列表尾部；win32 在既有早退分支返回，输出不变

## D2 亮出 CLI 路径

```js
// src/trellis-cli.js
resolveTrellisBinPath(basePath, { platform, fs, home })
  → string | null
```

- 与 spawn 同一 PATH：`readGlobalVersion` 内部从 `executionEnv.PATH` 起步
  （main 注入的即 augmented 结果），逐目录找 `trellis`：
  `fs.statSync` isFile（follow symlink，`/usr/local/bin/trellis` 是 npm 软链）+
  `fs.accessSync(p, fs.constants.X_OK)`；win32 直接 `null`
- `readGlobalVersion()` 返回 `{ installed, version, error, path }`
- 链路零改：`trellis-runtime.scan()` 的 `global` 整体透传 →
  `settings:trellis-scan` 信封 → `settings-tab-trellis.js` `buildGlobalSection`
  在版本 span 后追加 `<span class="trellis-cli-path">`（textContent = path，
  title = path），样式追加在 `src/settings.css` `.trellis-version` 附近
  （小字号、弱色、等宽字体）
- 无新 i18n 键：路径不是文案；无值不渲染该 span

## D3 目录互通（单向喂新）

```
settings:trellis-set-roots (trellis-ipc.js)
  └─ applyUpdate ok → options.syncScanRoots(roots)   ← 注入回调，ipc 层不认 store
       └─ main.js: syncScanRootsToDashboard(roots)
            ├─ scanner.scanRoots(roots) → projects.filter(p => p.installed)
            ├─ store.registerScanRoots(paths)         ← trellis-roots.js 新方法
            └─ 有新增 → notifyTrellisRootsChanged()   （main.js:2528 既有推送）
```

- `trellis-roots.js` 新增 `registerScanRoots(paths)`：批量 `add`，收集结果，
  返回 `{ status: "ok", added: n, skipped: { duplicate, limit } }`；语义为幂等喂新
- 启动存量同步：`main.js` 在 `_trellisRootsStore.load()` 与 settingsController
  就绪后调用同一 `syncScanRootsToDashboard(getSnapshot().trellisScanRoots)`，
  不推送 roots-changed（Dashboard 尚未开窗）
- 不级联删除：`settings:trellis-set-roots` 的移除路径不触碰 store（roots 可能
  源于面板 picker / 会话发现，级联会误伤）
- 失败容忍：`syncScanRoots` 回调内部 try/catch，异常只 warn，不影响
  `set-roots` 返回 `{ status: "ok", roots }`

## 兼容性与回滚

- 全部为追加式改动：PATH 只增不改序；`readGlobalVersion` 只加字段；scan 信封只加
  字段（renderer 向后兼容）；`registerScanRoots` 为新方法
- 回滚 = revert 单个 commit，无存储迁移、无 prefs schema 变化

## 测试策略

| 断言点 | 文件 |
| --- | --- |
| 四个固定目录按序追加在既有目录后 | `test/trellis-cli.test.js` |
| nvm 版本目录全量追加、新版本优先、缺失不抛错、无空段 | `test/trellis-cli.test.js` |
| win32 输出与现状逐字节一致 | `test/trellis-cli.test.js` |
| `resolveTrellisBinPath`：命中软链/X_OK/找不到/win32 null | `test/trellis-cli.test.js` |
| `readGlobalVersion` 返回 `path` 字段（fake fs/exec） | `test/trellis-cli.test.js` |
| `registerScanRoots` 幂等/limit/计数 | `test/trellis-roots.test.js` |
| `set-roots` ok 后 `syncScanRoots` 收到归一化 roots；controller 失败不调用 | `test/trellis-ipc.test.js` |
| 版本行渲染 CLI 路径 span；`path` 空则无该节点 | `test/settings-tab-trellis.test.js` |

启动存量同步（main.js 三行组装）不单测，依赖 `registerScanRoots` 与
`scanRoots` 的既有单测覆盖。
