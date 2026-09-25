# Settings Trellis 平台安装向导 + 升级预览 — 执行计划

前置：design.md 已定稿。每步后跑 `npm test`（基线 diff 法）。

## W1 向导 modal（新文件）

- [x] 1.1 新建 `src/settings-tab-trellis-wizard.js`：ClawdTrellisWizard 单例（openAddPlatform / openUpgradePreview / close），backdrop+modal 骨架、ESC/backdrop 关闭、innerHTML 全走 escapeHtml、无顶层 timer/insertBefore
- [x] 1.2 安装流：checkbox 群（未注册平台、预选）→ 预览（trellisPreview platforms 参数）→ addPlan 渲染（新增清单+命令行）→ 确认（trellisAddPlatform）→ 结果回显
- [x] 1.3 升级流：打开即预览（trellisPreview paths）→ 版本计划渲染 → upgradable=false 只读 → 确认（trellisUpgrade）→ 进度事件回显 → 完成
- [x] 1.4 settings.html：引入 script + `.trellis-wizard-*` / `.trellis-chip*` CSS（token 引用既有 --radius-s/--dur/--ease）
- 验证：`node --check`；手动打开两类向导走通

## W2 tab 改造

- [x] 2.1 项目行平台 chip 化（registered/unregistered/stale 三态；未注册+stale 点击进向导）
- [x] 2.2 「添加平台」改 `openAddPlatform(project)`；删除 addTarget 内联面板及其处理函数
- [x] 2.3 项目行「升级」改 `openUpgradePreview(project)`
- [x] 2.4 i18n ×7 语言新 key
- 验证：`npm test`；被删面板的测试断言同步更新

## W3 静态守卫 + 收尾

- [x] 3.1 新增 `test/settings-tab-trellis-wizard-static.test.js`：escapeHtml 强制、无 insertBefore/顶层 setTimeout、IPC 仅经 window.settingsAPI、close() 清理存在
- [x] 3.2 macOS 手动 QA 全流程（含取消路径、重复开关）
- [x] 3.3 spec 沉淀（renderer-guidelines 三条 CLI 契约 + trellis-panel-contract 状态文件版本化契约）+ commit

## 回滚点

W1–W3 单 commit 整体 revert；W2 依赖 W1，W3 依赖 W2。
