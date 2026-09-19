# Implement — 任务气泡 + 下一步引导

## 阶段 0：前置确认（不写代码）

- [x] 定位纯函数：`require("./update-bubble.js").__test.computeUpdateBubbleBounds` 已导出（L775），自带 avoidRects 避让/workArea 钳制；permission.js 的 stack 定位器不适用（未导出且语义不同）
- [x] idle 信号：state.js 无对外 onState 回调；main.js `normalizeVisualRequest`（L1507，logicalState = `_state.getCurrentState()`）是 state 变化在 main 的汇聚点（renderer 每次动画切换必走）→ 气泡触发挂这里 + `onTrellisUpdate`
- [x] i18n 占位符：无统一 format 函数，约定是 `.replace("{done}", …)` 逐个替换（sessionHudContextUsageTooltip 同模式）
- [x] avoidRects：computeUpdateBubbleBounds 入参自带；rects 来源对齐 update-bubble 现有消费者（permission stack bounds + HUD bounds getter）

## 阶段 1：纯函数 + i18n

- [ ] `src/trellis-phase.js`：`deriveNextStepHint(trellisInfo)`（D2 表）
- [ ] `src/i18n.js`：`trellisHintPlan/Execute/Finish` × 7 语言
- [ ] `test/trellis-phase.test.js` 表驱动用例（含 params 插值断言）
- [ ] 验证：`node --test test/trellis-phase.test.js test/i18n.test.js`

## 阶段 2：气泡模块

- [ ] `src/trellis-bubble.js`：工厂（全注入）、门槛短路、去重 Set、show/4s-hide、relayout（复用 update-bubble 定位纯函数）
- [ ] 静态 HTML/样式（thought-bubble 尾巴纯 CSS，无外部资产）
- [ ] `test/trellis-bubble.test.js`（D10 用例）
- [ ] 验证：`node --test test/trellis-bubble.test.js`

## 阶段 3：接线 + tooltip

- [ ] `src/main.js`：idle 信号 + onTrellisUpdate 驱动 `maybeShowTrellisBubble()`；DND/mini/petHidden 翻转回调 → hide；before-quit 销毁
- [ ] `src/session-hud-renderer.js`：chip `title`（任务名 — 引导行）
- [ ] HUD 行为测试补 title 断言
- [ ] 验证：trellis 系分项全绿 + main-contract 退出序列锚定

## 阶段 4：真机验证

- [ ] dev 启动 + CDP：绑定任务 → 桌宠 idle → 气泡出现/4s 消失/不重复
- [ ] HUD chip hover → tooltip 文案（zh 环境）
- [ ] DND 开 → 不弹/立即消失
- [ ] `.trellis/` shasum 前后零写入
- [ ] 气泡避让：手动弹 permission bubble 时气泡位置让位（观察一次）

## 阶段 5：收尾

- [ ] trellis-check 全量（增量 + spec 对照）
- [ ] spec：panel-contract 只读感知 Scenario 增「气泡/引导」消费者条目（沿用既有字段，不新增数据面）
- [ ] 提交：feat 主链 + docs(spec)
- [ ] finish-work 归档

## REVIEW GATE

- [ ] 阶段 0 结论回写本文件（定位函数导出面/通知路径/占位符形态）
- [ ] 阶段 2 完成后：气泡视觉（截图）请用户过目
