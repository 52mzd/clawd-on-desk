# v7 R9fix: spec split CSS 选择器失配修复

## 问题（用户截图反馈"一塌糊涂"）

R9 把 spec 卡换成 `trellis-view-section trellis-split-section
trellis-spec-split` 三个类，但 CSS 写的是复合选择器
`.trellis-spec-card.trellis-spec-split`——`trellis-spec-card` 类根本没挂上，
整套列方向样式（header 横条 + body 内部左右分栏）零命中。卡片退回
`.trellis-split-section` 的 `flex-direction: row`：标题/✕ 与文件列表、
文档区全部并排挤进一行，右侧空壳，布局崩坏。

## 修复

- 选择器改单类 `.trellis-spec-split`，并显式覆盖
  `.trellis-split-section` 的 `row` 方向与 `.trellis-view-section` 的
  `margin-bottom:18px`（卡片要顶满槽位）。
- renderer 类名不动（三个类保留，断言兼容）。

## 验收

- 📐 打开：header 一条横带，下方左（240px 文件列表）右（文档）两栏，
  同高滚动；任务 split 关闭时原样恢复
- `npm test` 失败集与 HEAD 一致（11044/10978/20 预存）
