# v7 R9: 规范地图整合进左右栏 split 视图

## 背景（用户反馈，2026-09-24 第二轮）

R8 把规范地图从 overlay 改成了 project bar 下的内嵌面板，但用户反馈"还是独立的"——
面板叠在任务列表上方，与 split 左右栏形态割裂。要求：规范地图**直接整合左右栏模式**，
打开时就是 split 视图本身。

## 改动

- `buildTrellisSpecCard` 换用 `.trellis-split-section` 框架（`trellis-spec-split`）：
  左侧文件列表（master）、右侧文档内容（detail），与任务 split 同高/同边框/同滚动。
- `renderTrellisViewBody`：`panelOpen === "spec"` 时 spec 卡**替换**任务 split
  （不是叠加）；关闭（✕ / 再点 📐 / ⚙ / ⛓ 互斥切换）后任务列表原样回来。
  ⛓ 网络全景保持顶部抽屉（信息密度低，不需要 master-detail）。
- 删除 `buildTrellisSpecPanel` 与 `.trellis-spec-panel` 样式；CSS 改为
  `trellis-spec-card.trellis-spec-split`（flex:1、min-height:0、header/body 分隔线）。
- 视图签名已含 spec 抽屉态（R8），loading→result 翻转照常重渲染。

## 验收

1. 点 📐：任务 split 消失，同槽位出现 spec 左右栏（文件列表 | 文档内容）
2. ✕ / 再点 📐 / 切 ⚙ 或 ⛓：spec 视图关闭，任务 split 恢复
3. R6 徽标（行数 / 待填 / ⛛N 引用）在 split 形态下不变
4. `npm test` 失败集与 HEAD 一致
