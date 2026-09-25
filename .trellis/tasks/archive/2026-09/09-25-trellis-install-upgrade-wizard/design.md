# Settings Trellis 平台安装向导 + 升级预览 — 技术设计

## 0. 研究事实（行号来自 09-25 只读研究）

| 事实 | 位置 | 影响 |
|---|---|---|
| 9 个 trellis IPC 通道全在 `src/trellis-ipc.js`，每通道前置 `isTrustedEvent` 门禁 | `trellis-ipc.js` L154–164, L173–276 | **IPC 零改动**，前端直接消费 |
| `settings:trellis-preview` 入参 `{channel?, paths, platforms?}`，返回 `{status, plan, addPlan?}`；plan = per-project `{current, to, channel, upgradable, command}`；addPlan = per-project `{path, name, platforms, added, command}`；**无 per-file 明细** | `trellis-ipc.js` L214–227, `trellis-runtime.js` L155–201 | 升级预览展示 = 版本计划 + 命令行；平台预览 = added 清单 + 命令行 |
| 平台目录 21 条 `{dirPrefix, id, label…}`；installed 状态 = `.template-hashes.json` 记录；stale = 配置目录缺失 | `trellis-platforms.js` L31–57, L134–147；`trellis-scanner.js` L53–98 | 未注册 = catalog − project.platforms；stale 平台单独标记 |
| doctor-modal 是专用 IIFE，不可参数化；但 backdrop+innerHTML+进出场动画+closeModal 清理+soft-btn 模式可复制 | `settings-doctor-modal.js` L655–702, L611–642 | 新建轻量向导 modal，复用 CSS 类与生命周期模式 |
| 项目行平台渲染、addTarget 内联面板、onUpgradeProject 直升 | `settings-tab-trellis.js` L535–641, L745–751, L878–885 | R1/R3/R4 的改造点 |
| vm 测试沙箱无 timer/DOM 高级 API（dashboard 侧教训同源） | `test/dashboard-*.test.js` 模式 | 向导 JS 全部惰性探测宿主 API；避免顶层 timer |

## 1. 架构：新文件 + 三处小改

```
src/settings-tab-trellis-wizard.js   [新增 ~380 行] 向导 modal（安装平台 / 升级预览 双模式）
src/settings-tab-trellis.js          [改] 项目行 chip 化 + 调 wizard + 移除 addTarget 内联面板
src/dashboard.html 不动；settings.html [改] 引入 wizard script + 少量 CSS（chip/modal 类）
src/i18n.js                          [改] 新 key ×7 语言
```

**不动**：trellis-ipc.js、trellis-runtime.js、settings-controller.js、preload。

## 2. 向导 modal 设计（`ClawdTrellisWizard`）

模仿 doctor-modal 生命周期，全局单例：

```js
globalThis.ClawdTrellisWizard = {
  openAddPlatform(project, preselectId),   // R2/R3：安装平台向导
  openUpgradePreview(project),             // R4：升级预览向导
  close(),
}
```

- **挂载**：`settings.html` 既有 modal root（无则 body 直挂 backdrop div）；innerHTML 模板 + escapeHtml
- **安装向导流**：打开 → 展示未注册平台 checkbox 群（预选 preselectId）→ 点「预览」调 `trellisPreview({paths:[path], platforms:[checked]})` → 渲染 addPlan（将新增 N 平台 + 命令行 `trellis init --<platform> -y` 形态展示）→ 「确认安装」→ `trellisAddPlatform(path, ids)` → 成功/失败回显 + 「完成」关闭
- **升级预览流**：打开即调 `trellisPreview({paths:[path]})` → 渲染 current→to、channel、命令行 → `upgradable` 为 false 显示「已是最新」不可确认 → 「确认升级」→ `trellisUpgrade(path)` → 轮询既有 progress 事件（订阅与 tab 一致）→ 完成回显
- **清理**：close() 移除监听、清空 innerHTML；ESC/backdrop 点击关闭；无 setInterval（进度靠既有事件推送）
- **argv 安全**：预览的 command.args 仅作**展示**（escapeHtml 后 <code> 渲染），永不执行；执行只走既有 IPC

## 3. chip 化（R1）

项目行平台区改为：

```
[已注册: accent tint chip] [已注册…]
[未注册: dashed border muted chip +] （点击 → openAddPlatform(project, id)）
stale 平台：chip 上加 ⚠ 前缀、点击同样进向导（重装语义）
```

CSS 新类（settings.html 或复用 dashboard 已有 token 若同窗口）：
`.trellis-chip`（radius-s + 11px/600 + padding 1px 7px）
`.trellis-chip-registered`（color-mix accent 14% 底）
`.trellis-chip-unregistered`（transparent 底 + dashed border、hover 微亮）

## 4. settings-tab-trellis.js 改造点

1. 项目行平台渲染函数（研究 L745 区域调用链）→ 改为 chip 群构建（catalog ORDER 遍历：registered / unregistered / stale 三态）
2. 「添加平台」按钮 → `ClawdTrellisWizard.openAddPlatform(currentProject)`；删除 addTarget 内联面板 + closeAddPlatform + onPreviewAddPlatform/onConfirmAddPlatform（被向导取代）
3. 项目行「升级」按钮 → 改调 `ClawdTrellisWizard.openUpgradePreview(project)`
4. 批量升级/全局升级流程**不动**

## 5. i18n（×7 语言）

`settingsTrellisWizardTitle / settingsTrellisWizardInstallPreview / settingsTrellisWizardConfirmInstall / settingsTrellisWizardUpgradePreview / settingsTrellisWizardConfirmUpgrade / settingsTrellisWizardUpToDate / settingsTrellisWizardCancelled`

## 6. 测试

- 向导文件做**静态守卫**（沿用 dashboard 模式）：无 `insertBefore`、无顶层 `setTimeout`、`trellisPreview` 调用仅经 `window.settingsAPI`、innerHTML 前必 escapeHtml
- 现有 `test/settings-tab-trellis*.test.js` 若锚定被删内联面板的选择器 → 同步更新断言（预期改动集中）
- 手动 QA：macOS 全流程（chip 点击→预览→装→升→取消路径）

## 7. 回滚

单 commit（wizard 新文件 + tab 改造 + i18n + 测试），可整体 revert；revert 后回到内联面板形态。
