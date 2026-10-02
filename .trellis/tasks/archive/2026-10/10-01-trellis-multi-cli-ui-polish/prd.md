# 多装 CLI 列表 UI 重排——两行结构 + 胶囊徽标 + 命令块缩进

## Goal

用户实机反馈「可以了，但是 ui 真的很难看，没对齐，逻辑混乱」：判定逻辑已认可（10-01-trellis-multi-cli-revise），纯视觉层重排。把多装列表从单行五段横排改为两行结构，outdated 命令块缩进加底色。

## Requirements

- R1 行1 = 路径（左，mono，flex:1 ellipsis）+ 版本号（右，tabular-nums）：版本右缘跨行对齐，徽标不再与版本同行
- R2 行2 = 胶囊徽标行（左对齐，rank 在前、active 在后）：badge 形态照抄 `.agent-badge` 胶囊语言（padding 2px 8px / radius 10px / 深浅色两套背景），中文徽标 11px、不做 uppercase
- R3 徽标三态配色借用 `.agent-badge` 现成色板：最新=绿、旧版（可清理）=amber、Clawd 当前使用=accent 品牌橙
- R4 outdated 命令行缩进 + 底色块 + 圆角，明确隶属于该条目；条目间留 margin 分隔
- R5 判定逻辑、payload 形态、i18n 文案零变更；renderer 仍纯渲染（不生成任何判定/命令）

## Acceptance Criteria

- [x] 双装 payload 渲染：每个安装两行（路径+版本行、徽标行），版本号右对齐（CSS 右置 + tabular-nums）
- [x] 徽标为胶囊样式（有底色、圆角、padding），三态色区分；rank 徽标先于 active 徽标渲染
- [x] outdated 条目的命令块带缩进与底色；条目间有视觉分隔（CSS）
- [x] 既有测试断言语义保持：texts 断言（路径/版本/徽标文案/命令文本/copy→剪贴板）、`trellis-cli-install-cmd` 精确 class 匹配、legacy payload 降级、单装零渲染
- [x] 定向测试（settings-tab-trellis）+ 全量 `npm test` 通过
