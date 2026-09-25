# Dashboard UI apple-design 重构

## 背景

Dashboard（Sessions 列表 + Trellis 面板 + quick mode）当前 CSS 约 71K 字符内联在 `src/dashboard.html`（3178 行），按历史迭代分块追加（"v5-a"、"v7 R10" 注释可考），存在：

- 4 个 `:root` 各自为政；token 只覆盖颜色/字体，`border-radius` 硬编码 76 处、`box-shadow` 大量硬编码，无时长/缓动/间距 scale
- 动效零散：唯一动效 token 是 `--trellis-press: 120ms`；transition 多为一次性补丁，无 enter/exit 对称、无 reduced-motion 兜底
- 视觉层级靠边框/灰阶堆叠，缺少 Apple 式材质（磨砂浮层）与深度语言

目标：按 `apple-design` skill 的设计逻辑（响应即时性、可中断动效、材质与深度、光学排版、reduced-motion）系统性重构视觉层，**不改功能、不改 DOM 结构契约、不改 IPC**。

## 需求

- R1 **统一 token 层**：合并为亮/暗两套单一 `:root`，补齐圆角、阴影、间距、时长、缓动 scale；消灭散落硬编码（颜色/圆角/阴影收敛到 var 引用）
- R2 **材质与深度**：顶栏/浮层改为 `backdrop-filter` 磨砂材质（blur + saturate + 半透明底），内容卡片用 surface 分层；阴影按表面尺寸分级（大面更深）；亮顶边高光
- R3 **动效系统**：定义统一缓动库（默认临界阻尼近似 `cubic-bezier(0.32,0.72,0,1)` 类、momentum 轻回弹 `--trellis-press` 保留）；enter/exit 同路径对称（从右进从右出）；列表条目入场错峰；hover/active 即时反馈（pointer-down 即响应）
- R4 **光学排版**：标题负 tracking、正文近 0；行高按字号反比；保持系统字体栈不变；状态色体系保留（Claude 橙 accent / running 绿 / done 蓝）但收敛到材质友好的半透明底色应用（badge/tint 层）
- R5 **可达性**：`prefers-reduced-motion` 全套 cross-fade 降级；focus-visible 焦点环；`prefers-reduced-transparency` 提供更实底材质
- R6 **平台兼容**：三平台（macOS/Windows/Linux）Chromium 渲染层一致；Dashboard 为不透明普通窗口（非透明 pet 窗口），`backdrop-filter` 不受 Windows DWM 透明窗口陷阱影响；quick mode 宿主（WebContentsView opacity parking）行为不受 CSS 改动干扰
- R7 **左栏分类卡片化 + 层级继承统一（09-25 追加）**：计划/执行/检查/收尾/归档五个分类头从「轻量分隔条」升级为卡片形态；分类→根任务→子任务→孙任务的每一级有统一的 UI 逻辑对齐与视觉继承（同族语言、逐级弱化），不再出现「分类头与任务卡不同层」的割裂感。注：左栏无「规范/关联」分组（仅右栏文档树有），待用户确认是否需要新增

## 非目标（Out of Scope）

- 不改 DOM 结构/ID/类名契约中 renderer 依赖的部分（签名防抖渲染、quick mode 数字映射、static guards 测试锚点）
- 不改任何 IPC / preload / 主进程逻辑
- 不引入 CSS 框架/预处理器/TS；不拆分内联 `<style>` 为外部文件（维持每窗口单 html 现状）
- 不新增用户可见文案（i18n 冻结）；不改状态色语义映射

## 验收标准

- A1 `npm test` 全绿，尤其 `test/` 中 dashboard 相关 static guards（[hidden] cascade、wireTrellisDocCollapse call sites、类名选择器匹配）零修改通过
- A2 token 收敛度：`border-radius`/`box-shadow`/`transition` 时长在新增区块零硬编码（全 var 引用）；既有区块迁移完成
- A3 亮/暗两套 `prefers-color-scheme` 下视觉完整；`prefers-reduced-motion` 下无 slide/spring 仅 cross-fade
- A4 quick mode 进入/退出（数字映射、opacity parking、来源恢复）在 macOS/Windows 手动 QA 无回归
- A5 三平台视觉抽查：macOS（本机）、Windows/Linux 以代码审查 + 截图对比说明（Windows-first 环境约束，见 Testing 约定）
