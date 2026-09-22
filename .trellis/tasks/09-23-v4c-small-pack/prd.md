# v4-c 小件打包：waiting 态 + 文档折叠 + 进度刻度条

## Problem

三个独立小件，单独开任务不值得，合并成一个小包交付：

1. **waiting 视觉态**：planning 任务在气泡/HUD 里只有「计划中」文字，无区分度
2. **详情文档无折叠**：v3 的任务详情 overlay 把 prd/design/implement 全文铺开，长任务详情要滚很久
3. **进度只有数字**：徽标是 `2/5` 数字形态，trellis-card 有刻度条形态更直观

## Requirements

- **R1 waiting 态**：phase=planning 的任务在气泡与 HUD 徽标上呈现独立视觉（颜色/图形区别于 working），不新增 REQUIRED_STATES、不动动画状态机
- **R2 文档折叠**：详情 overlay 内每个文档段落（prd/design/implement/research）默认折叠，标题行可点击展开；记住会话内展开状态即可（不持久化）
- **R3 刻度条**：progress 徽标升级为 `2/5` + 微型刻度条（SVG/div），无 progress 时不渲染刻度条
- **R4 降级**：mini mode / 低分屏下刻度条可安全省略（graceful degradation）

## Acceptance Criteria

- [ ] planning 任务气泡/HUD 与 working 有可见区分
- [ ] 打开详情默认收起，展开一段后滚动位置不跳
- [ ] progress=3/7 的任务显示数字 + 7 格刻度条，3 格填充
- [ ] 无 progress 任务不出现刻度条
- [ ] 全量 npm test 与基线 diff=0

## Non-Goals

- 不做跨会话折叠状态持久化
- 不做 waiting 的动画态（纯静态视觉区分）
