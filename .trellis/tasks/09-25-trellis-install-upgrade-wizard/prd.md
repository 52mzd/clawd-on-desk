# Settings Trellis 平台安装向导 + 升级预览

## 背景

Settings → Trellis 页（`src/settings-tab-trellis.js`，996 行）现有能力为内联面板形态：
- 项目行平台以纯文字 + badge 展示，**已注册/未注册平台无视觉区分，未注册平台不可点击**
- 「添加平台」是工具栏内联面板（addTarget 状态开关），入口不直观
- 项目行「升级」按钮**直接执行升级**，无预览确认步骤；全局「预览」面板与单项目升级脱节

用户要求：向导化（modal）+ 平台 chip 可交互 + 升级前预览确认。

## 需求

- R1 **平台 chip 高亮区分**：项目行的平台展示改为 chip 群——已注册平台 = accent tint 高亮 chip；catalog 中存在但项目未注册的平台 = muted chip、可点击
- R2 **未注册平台点击安装向导**：点击未注册 chip → modal 向导打开，预选该平台，可追加勾选其他未注册平台 → 预览（显示将新增的平台与将执行的命令）→ 用户确认 → 执行安装（`trellisAddPlatform`）→ 显示结果
- R3 **添加平台入口向导化**：现有「添加平台」内联面板改为打开同一 modal 向导
- R4 **每项目升级预览按钮**：项目行新增「升级预览」→ modal：调 `settings:trellis-preview`（单项目 paths）→ 展示 版本 current → to、channel、upgradable、将执行的命令 → 「确认升级」→ `trellisUpgrade(path)` → 进度与结果展示
- R5 **样式与 dashboard 卡片族一致**：chip 用 `--radius-s` + `color-mix` tint 模式；modal 复用 Settings 现有 soft-btn / backdrop 模式

## 非目标（Out of Scope）

- 不改任何 IPC / 主进程逻辑（9 通道现成够用：preview / add-platform / upgrade-project）
- 不引入 per-file 变更明细——`trellis update --dry-run` 会写 `.version` 被明令禁止，预览只能基于 scan 快照的版本级计划（docs/project/trellis-settings-panel.md §4）
- 不做 timer/watcher/auto-refresh（§5 约束）
- 不动 roots 管理（增删根走现有入口）
- i18n：新文案补 7 语言 key（沿用现有 dashboardTrellis* 命名空间 settings 侧惯例）

## 验收标准

- A1 `npm test` 全绿，失败集合与存量基线一致；trellis 相关测试零修改通过
- A2 已注册平台 chip 高亮、未注册 chip 可点击；点击后向导预选该平台且确认安装成功（macOS 手动 QA）
- A3 升级预览 modal 正确显示 current→to 与命令行预览；确认后升级执行且结果回显；取消不产生任何写
- A4 向导关闭清理完整（无残留定时器/DOM；重复开关无状态泄漏）
- A5 每个新 IPC 调用路径经 `window.settingsAPI.trellis*`（renderer 无裸 ipcRenderer）；预览零写盘
