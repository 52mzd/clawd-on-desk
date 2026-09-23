# v5-a 弹窗放大 + 可复制 + 入场动画

## Problem

任务详情/规范地图/关联网络 overlay 太小（`.trellis-detail-card` 固定 `min(420px,100%) ×
min(520px,100%)`），PRD 长文档只能在小窗里滚；且 `body { user-select: none }` 全局禁选，
markdown 正文无法复制（dashboard.html L59 vs L1556——仅别名编辑框局部放开过）。

## Requirements

- **R1 放大**：doc 类卡片（detail/spec/network）升级为近全屏弹层——`min(880px, 92vw) ×
  min(760px, 88vh)`，保留遮罩与居中；小屏（Dashboard 本身 <900px 宽）自动回落当前小卡
- **R2 可复制**：`.trellis-detail-doc` / `.trellis-spec-doc` / `.trellis-network-card` 内
  `user-select: text` 局部放开（正文可选择复制）；按钮/交互件保持 none 防误选
- **R3 华丽入场**：overlay 打开时卡片 scale(0.92→1) + opacity(0→1) + 轻微 translateY
  弹入（cubic-bezier 回弹），遮罩 fade；关闭对称淡出。纯 CSS keyframes，一次性，
  `prefers-reduced-motion: reduce` 时跳过
- **R4 零回归**：signature 防重渲染不破坏动画（动画挂在卡片元素上，replaceChildren
  重建时自然重放——signature 命中时不重建，无闪烁）

## Acceptance Criteria

- [x] 大卡近全屏 calc(100%-48px)×calc(100%-64px) cap 880×760；<980px 媒询回落 420×520；percent-only 无 vw/vh（zoom-safe，settings-renderer-browser-env 355 全绿）
- [x] .trellis-detail-doc/.trellis-spec-doc/.trellis-spec-list/.trellis-network-card user-select:text；header/按钮保持 none
- [x] pop-in cubic-bezier(0.34,1.3,0.5,1) 0.26s + 遮罩 fade；对称 close fade-out（animateTrellisOverlayClose 定时器 140ms，关→开竞态 cancel）；reduced-motion 全跳过
- [x] 全量与基线 diff=0（两次）

## Non-Goals

- 不做文档编辑/保存
- 不做弹层内搜索
