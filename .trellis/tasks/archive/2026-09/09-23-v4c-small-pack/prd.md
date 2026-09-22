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

- [x] planning 任务气泡/HUD 与 working 有可见区分（预存彩色 phase 徽标 + one-shot 气泡，见 Revision）
- [x] 打开详情默认收起，展开一段后滚动位置不跳（预存 tab 化已覆盖，见 Revision）
- [x] progress=3/7 的任务显示数字 + 7 格刻度条，3 格填充（appendTrellisProgressWithTicks，≤12 直格、超限按比例）
- [x] 无 progress 任务不出现刻度条（buildTrellisProgressTicks 返回 null）
- [x] 全量 npm test 与基线 diff=0（39 预存红两次全量比对一致；codex-log-monitor 单跑 125 全绿确认为并发 flaky）

## Non-Goals

- 不做跨会话折叠状态持久化
- 不做 waiting 的动画态（纯静态视觉区分）

## Revision (2026-09-24, pre-implementation audit)

开工前核查发现 R1/R2 的预设已不成立：

- **R1 已被覆盖**：HUD 与 Dashboard 行内均已有彩色 phase 徽标
  （`trellis-plan` 蓝 / `trellis-check` 紫 / `trellis-done` 灰，
  session-hud.html L271-292 + TRELLIS_PHASE_BADGE）；phase 变化另有
  one-shot 气泡 + 10s 去重。planning 与 working 的可见区分已存在。
- **R2 已被覆盖**：详情文档早已 tab 化（activeTab，一次只显示一个
  文档），不存在「全文铺开」。

本任务范围收窄为 **仅 R3 刻度条**（真实差距）：活跃行/归档行/详情
overview 的 `2/5` 数字旁加微型刻度条，无 progress 不渲染。R1/R2 的
验收条目按已覆盖处理，不重复实现。
