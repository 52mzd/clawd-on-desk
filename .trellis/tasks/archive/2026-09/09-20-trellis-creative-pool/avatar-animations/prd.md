# 阶段化身与多任务动画（R3 / R3.1）

## 背景与范围

创意池 v1 的 R3/R3.1 项。Trellis 任务阶段（planning / executing / checking /
finishing）目前只体现在 HUD 徽标文字上，宠物本体无感知。本任务把阶段
信息接入宠物渲染层，做两件事：

1. **R3 阶段配件**：绑定任务处于 `planning` 阶段时，宠物戴 `wizard-hat`
   （思考帽）；处于 `executing` 且活跃并行任务 ≥2 时进入 juggling tier。
2. **R3.1 并行任务 juggling**：`parallelCount >= 2` 且宠物 state 为
   working 时，选用 2+ tier 的 juggling 素材（复用 subagent 的分层机制，
   不新造状态、不加 REQUIRED_STATES）。

## 约束

- 不改 `src/state.js` 的状态机：juggling 走既有 tier 选择路径
  （subagent tier 的选择函数参数化，trellis 并行数作为新输入源之一）
- 配件走 `src/renderer.js` 既有 `accessoryDescriptor` 机制，不新开图层
- 用户手动选择的配件优先级 > 阶段自动配件；阶段配件是 ephemeral 的，
  不写 prefs
- 主题无该配件时静默降级（同 `mini-working` 降级语义）
- 零开销红线（R4）：无 Trellis 数据时渲染层不新增任何轮询或定时器

## 验收标准

- [ ] planning 阶段宠物戴 wizard-hat（Clawd 主题），切换到 executing 后消失
- [ ] 两个 Trellis 任务并行 executing 时宠物播放 juggling tier 动画
- [ ] 用户手动配件不被阶段配件覆盖
- [ ] `npm test` 全量失败集与基线一致；新增单测覆盖 tier 选择与配件优先级
- [ ] Calico / Cloudling 无 wizard 配件时无报错、无 JS console error
