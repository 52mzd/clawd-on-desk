# QA Notes — 平台 code-review-first 说明（P4.2/P4.3）

日期：2026-09-25 · 环境：macOS 开发机（Windows/Linux 无真机）

## 静态抽查结论（可机械验证部分）

- **动画属性面**：14/14 `@keyframes` 仅涉及 transform/opacity/filter；transition 属性集合 = {background(-color), border-color, box-shadow, color, opacity, transform}——无 layout 属性进入过渡，1s 重建循环不产生持续合成层
- **will-change**：0 处（无残留 GPU 层提示）
- **scroll-behavior**：0 处 smooth（scrollGuard 恢复语义未被触碰）
- **backdrop-filter**：仅 `.trellis-detail-overlay` scrim 一处 + reduced-transparency 兜底分支
- **`prefers-reduced-motion`**：4 处（原 3 处局部 + P3 新增 session 卡入场降级块）
- **`prefers-reduced-transparency`**：1 处（scrim 退实底 rgba .72 + 去 blur）

## 平台差异审查（Windows / Linux）

| 关注点 | 判断 | 依据 |
|---|---|---|
| backdrop-filter 于 Windows | 安全 | Dashboard 为不透明普通窗口（`dashboard-host.js` darwin/win32 走 BaseWindow+WebContentsView、Linux BrowserWindow），与 pet 透明窗口的 DWM 陷阱无关（AGENTS「Language 子菜单截断」仅限透明+alwaysOnTop 场景） |
| color-mix 于 Linux | 安全 | Electron Chromium ≥111 全平台一致；文件内既有 43 处 color-mix 为存量先例，本次仅按同模式追加 |
| overlay `position: fixed` | 安全 | Linux BrowserWindow 宿主路径既有测试覆盖（dashboard.test.js 187/187） |
| quick mode | 未动 | opacity parking / 数字映射 / revision 栅栏全部在主进程（dashboard-quick-mode.js），本次零触碰；CSS 仅改静态视觉 |
| 布局属性 | 未动 | .card grid 模板、padding、min-height 保持原值，仅加 shadow/transition |

## 需真机确认的残余风险（pending）

1. **quick mode 往返**（4.1）：数字映射、opacity parking、来源恢复需 macOS 手动跑一次完整流程
2. **Windows 高对比度主题**下 `prefers-reduced-transparency` 的 scrim 实底观感
3. 磨砂 scrim 在 Linux 合成器（尤其无 GPU 会话）下 blur(8px) 性能——已有 reduced-transparency 逃生门

结论：无平台阻断项；视觉回归面收敛在「新 shadow/tint 观感」主观层。
