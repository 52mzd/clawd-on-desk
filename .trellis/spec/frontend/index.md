# Frontend (Renderer Process) Guidelines

> 本项目"前端" = Electron 渲染进程页面群。无框架、无 TS、CommonJS、原生 DOM。

---

## 项目前端形态（先读这个）

- **无 React/Vue/TS**（package.json 已验证）。每个窗口/浮层一个 `*-renderer.js`，配套 `.html` + CSS（独立 `.css` 或 html 内联 `<style>`，两种形态并存）
- 渲染进程与主进程之间**只经 preload `contextBridge` 暴露的 API** 通信（如 `window.dashboardAPI.*`），`nodeIntegration` 关闭
- 外来内容（agent 上报、task/spec markdown、文件路径）是不可信输入，渲染防线见 [renderer-guidelines.md](./renderer-guidelines.md)

## Guidelines Index

| Guide | 内容 | 适用场景 |
|-------|------|---------|
| [Directory Structure](./directory-structure.md) | 每窗口一 renderer + preload + html/css 配对布局 | 新增窗口/浮层 |
| [Renderer Guidelines](./renderer-guidelines.md) | DOM 构建、signature 重渲染、overlay 状态对象模式、事件清理、HUD 颜色主题变量、UI 格式两轮触发器 | 写/改任何 renderer |
| [IPC Guidelines](./ipc-guidelines.md) | preload 暴露、严格 payload、信任帧、运行时类型校验 | 新增渲染↔主进程通道 |
| [i18n Guidelines](./i18n-guidelines.md) | 七语言键完整性、取词约定 | 任何用户可见文案 |
| [Quality Guidelines](./quality-guidelines.md) | 语法检查、test runner、渲染器测试、审查线 | 提交前 |

## 跨层 UI 工作的思维入口

涉及渲染进程 ↔ 主进程 ↔ 磁盘的功能（如 Trellis 视图），先读
[guides/cross-layer-thinking-guide.md](../guides/cross-layer-thinking-guide.md)；
Trellis 面板专属契约见
[guides/trellis-panel-contract.md](../guides/trellis-panel-contract.md)。
