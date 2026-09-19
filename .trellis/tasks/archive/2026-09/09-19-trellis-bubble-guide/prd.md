# 创意池轻量双件：任务气泡 + 下一步引导

## Goal

桌宠在 idle 时以 thought-bubble 气泡闪现当前绑定的 Trellis 任务名，并附一行工作流「下一步」引导；同时在 HUD trellis 徽标上以 tooltip 常驻同样的引导文案。让用户不看终端也能感知「任务进行到哪、下一步该做什么」。

## Requirements

### R1 任务气泡（thought-bubble，自绘窗口）

- 触发：桌宠进入 idle 且当前会话绑定 trellis 任务（trellis-activity 缓存非空）时弹出
- 内容：任务 title + 一行阶段引导文案（R2 规则表）
- 形态：自绘 BrowserWindow 气泡（跨平台一致，不用系统 Notification）；thought-bubble 风格带小尾巴；跟随桌宠定位，避让 Session HUD 与 permission stack（沿用 update-bubble 的避让/重排机制）
- 消失：约 4s 自动消失，或点击气泡/桌宠立即消失
- 去重：同一任务在一个 Clawd 会话内最多弹一次（不重复打扰）
- 门槛：DND / petHidden / mini 模式不弹（与庆祝动画同门槛）

### R2 「下一步」引导规则表（气泡与 HUD tooltip 共用一份纯函数）

| 绑定任务阶段 | 引导文案（en 示例） |
|---|---|
| planning | "Plan ready — start the task to execute" |
| execute (in_progress) | "Executing n/m steps" |
| finish (completed, 未归档) | "Looks done — archive to wrap up" |
| done / 无绑定 | 不弹（归档场景已由庆祝动画覆盖） |

### R3 HUD tooltip（常驻零打扰通道）

- HUD trellis 徽标增加原生 tooltip（title 属性），hover 显示 R2 引导文案 + 任务名
- 不新增可见元素/不占 HUD 布局空间

### R4 硬约束

- 只读红线：零写入 `.trellis/`、零 spawn、零网络、零新 hook
- 零新增轮询：气泡与 tooltip 只消费 trellis-activity 既有缓存与 snapshot 字段
- i18n 7 语言全集（en/zh/zh-TW/ko/ja/pt-BR/es），parity 测试强制
- 不改 REQUIRED_STATES；不占用/复用庆祝动画通道（requestClickReaction）

## Acceptance Criteria

- [ ] idle + 绑定任务 → 气泡出现一次（任务名 + 引导行），~4s 或点击后消失
- [ ] 同一任务在同一 Clawd 会话内不重复弹
- [ ] DND / petHidden / mini 下完全不弹气泡
- [ ] HUD 徽标 hover → tooltip 显示任务名 + 引导文案，7 语言完整
- [ ] planning→start / execute→进度 / finish→归档 三档文案映射正确，done/无绑定不弹
- [ ] 气泡定位避让 HUD 与 permission stack（permission bubble 增删后气泡重排或让位）
- [ ] 全程 `.trellis/` 树零写入（shasum 验证）
- [ ] 测试：规则表纯函数单测、气泡生命周期/去重/门槛单测、i18n parity

## Out of Scope

- Dashboard Trellis 任务页、Trellis 日报（recap 红线待审）、活动流（hook 违反只读）
- 配件自动佩戴 / 杂耍庆祝动画（创意池 P2 另议）
- 引导的自动执行（只提示，永不代用户跑 task.py）
