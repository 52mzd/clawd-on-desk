# Directory Structure

> 一窗口一 renderer，配对 preload + html + css。单文件可达 4000+ 行，横向拆分靠"功能域内聚"而不是框架组件。

---

## 布局规则

```
src/
  main.js                    # 主进程 composition root（唯一 ipc 注册器接线处）
  session-ipc.js             # 全部 dashboard:trellis-* 等 handler 的统一入口
  preload-dashboard.js       # dashboard 窗的 contextBridge 暴露
  dashboard.html             # DOM 骨架 + 内联 <style>（dashboard 的 CSS 在这里）
  dashboard-renderer.js      # dashboard 窗全部渲染逻辑（~4200 行）
  session-hud-renderer.js    # HUD 浮层 renderer
  session-hud.html           # HUD 内联样式
  settings.css               # settings 的 CSS 是独立文件（两种形态并存）
  trellis-doc-renderer.js    # 共享白名单 markdown 渲染器（多窗复用）
  styles.css / bubble.css …  # 宠物主窗/气泡等样式
```

## 新增窗口/浮层的检查单

1. **renderer 文件独立**：新窗 = 新 `*-renderer.js`，不往现有 renderer 里塞。规模上 `dashboard-renderer.js` 4168 行是当前上限信号，超过考虑按功能域提出共享渲染器（参照 `trellis-doc-renderer.js` 的拆法）
2. **CSS 跟窗走**：小窗用 html 内联 `<style>`（dashboard.html / session-hud.html 形态）；复杂样式表用独立 `.css`（settings.css 形态）。不要新建全局 css 再让多窗引
3. **preload 成对**：新窗的 API 暴露加在该窗自己的 preload；channel handler 加 `session-ipc.js`（统一信任帧入口），不要绕开另注册
4. **共享渲染器放 `src/` 根**：多个 renderer 复用的纯渲染逻辑（如 markdown、SVG 图标）提为 `xxx-renderer.js` 模块，CJS `require` 直接引

## 反模式

- ❌ 在 `renderer.js`（宠物主窗）里加 Dashboard 功能——窗口职责不混
- ❌ 渲染器之间互相 require——共享逻辑下沉为共享模块，renderer 只消费
- ❌ `__dirname`/`require("fs")` 出现在 renderer 文件——渲染进程无 Node（除 preload）
