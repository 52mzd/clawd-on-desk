# PRD: win32 全局 Trellis CLI 检测误报未安装

## 背景

Windows 用户已在终端安装 Trellis CLI（`trellis -v` → `0.6.17`），但 Clawd Settings → Trellis 页始终显示「PATH 中未找到 Trellis CLI」并展示全局安装指南。

根因（已定位）：`src/trellis-cli.js` 的 `readGlobalVersion()` 唯一安装发现途径是 `scanTrellisBinPaths()` 的纯 fs 扫描，而该函数在 win32 上直接 `return []`（npm 安装的是 `trellis.cmd` shim，fs 扫描无法模拟 shell 解析）。paths 为空 → `headline === null` → 恒返回 `{ installed: false }`。win32 分支禁用了 fs 扫描，却没有补替代检测路径，尽管 `run()` 在 win32 本就带 `shell: true`、能正确解析 `.cmd` shim。

受影响的下游：`src/trellis-runtime.js` `scan()` 的 `global` 字段；Settings Trellis 页全局卡片的版本显示与升级入口（`upgradeGlobal()` 内部也调用 `readGlobalVersion()` 读升级前后版本，win32 上同样失真）。

## 需求

1. `readGlobalVersion()` 在 win32 上必须能检测到已安装的 Trellis CLI 并解析其版本号。
2. win32 上真正未安装时，仍返回干净的「未安装」状态（`installed: false`、`error: null`），UI 照旧显示安装指南。
3. 检测失败的语义与 POSIX 路径一致：找到了二进制但 `--version` 执行失败/超时 → `installed: false` 且带 `error`。
4. 不改变 POSIX 行为：macOS/Linux 的 fs 扫描、多安装检测（`installs`）、`path` 首命中、`outdated` 标记等一概不动。

## 验收标准

1. `createTrellisCli({ platform: "win32" })` + stub 的 `execFile` 成功返回版本输出（含「整行仅版本号」形状，带横幅前缀也能解析）时，`readGlobalVersion()` 返回 `{ installed: true, version: <CLI 版本>, path: null, installs: [] }`。
2. win32 + stub 返回 ENOENT（shell 找不到 `trellis`）时，返回 `{ installed: false, version: null, error: null, installs: [] }`——错误是状态而非报错。
3. win32 + spawn 其他失败（如超时）时，返回 `installed: false` 且 `error` 非空。
4. win32 上 `run()` 仍以 `shell: true` 执行、argv 严格为冻结的 `VERSION_ARGS`（`["--version"]`），不新增任何 argv 形态。
5. POSIX（darwin/linux）行为与既有测试全部保持不变（既有 `readGlobalVersion` 测试不许改断言）。
6. `test/trellis-cli.test.js` 新增覆盖上述 1–3 的用例；`npm test` 全绿。
7. UI 侧无需改动：`settings-tab-trellis.js` 已兼容 `global.path` 为空（win32 不渲染路径），`installed: true` 后版本号与升级入口自然出现。

## 约束

- 遵循 `.trellis/spec/guides/trellis-panel-contract.md`：argv 冻结（复用 `VERSION_ARGS`，不得从渲染层拼接）、版本解析复用 `parseVersionOutput`（锚定「整行仅版本号」形状，防横幅项目版本污染）、`buildCleanupCommand` 只显示不执行。
- win32 的 `installs` 保持 `[]`、`path` 保持 `null`（fs 多安装检测在 win32 不可行，不做 `where` 探测等扩展）。
- 最小改动：只动 `src/trellis-cli.js` 的 `readGlobalVersion()` win32 分支与测试；不动 `scanTrellisBinPaths` 契约（win32 → [] 保留）。
- 完成后同步更新 spec：`trellis-panel-contract.md` 中 `readGlobalVersion` 的 `win32 installs 恒 []` 契约行需补充 win32 spawn-fallback 语义。
