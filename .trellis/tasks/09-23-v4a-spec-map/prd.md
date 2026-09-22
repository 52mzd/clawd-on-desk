# v4-a 规范地图（Spec Map）

## Problem

`.trellis/spec/` 已积累 trellis-panel-contract（400+ 行）、cross-layer guide（Mistake 1–8）等高价值文档，但在 Dashboard 里完全不可见——用户必须开文件管理器才能查契约。trellis-card 有规范地图能力，我们没有。

## Requirements

- **R1 入口**：Trellis 视图（roots 区下方或顶部 tab 旁）新增「规范」入口；多项目时可见源切换
- **R2 浏览**：overlay 内左侧栏 = spec 目录树（`index.md` + 各 `*.md`），点击右侧渲染
- **R3 渲染**：复用 v3 白名单 GFM 渲染器；标题/代码块/表格/链接必须正确；拒绝执行任何内容
- **R4 源项目标注**：当前 roots 里每个项目各自有一份 `.trellis/spec/`，展示哪份必须在 UI 明示（项目名徽标）
- **R5 零开销**：未打开 overlay 时零 IO、零渲染；文档读取按需、有缓存上限

## Acceptance Criteria

- [ ] 打开规范地图能看到 frontend/index.md、guides/cross-layer-thinking-guide.md 的渲染内容
- [ ] 切换源项目徽标后内容跟随切换
- [ ] 恶意 markdown 探针（script 注入 / onerror / javascript: 链接）全部惰性文本化
- [ ] overlay 关闭后无残留定时器/监听器；重复开关无累积 IO（缓存命中）
- [ ] 新跨层通道按 7 段式补 spec

## Non-Goals

- 不做 spec 编辑、diff、版本历史
- 不做全文搜索（首版目录导航足够）
