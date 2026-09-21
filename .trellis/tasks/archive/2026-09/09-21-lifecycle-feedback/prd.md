# 生命周期状态感知反馈（v3 #5）

## 范围

Trellis 任务阶段切换（plan → execute → check → finish → done）时给
**即时视觉反馈**，弥补当前只有气泡/HUD 静态文案的滞后感：

1. **阶段过渡动画**：阶段切换瞬间桌宠播放短过渡（复用既有庆祝/通知类
   素材语义；无专用素材时用气泡替代）
2. **阶段气泡**：切换时弹一次性气泡（任务名 + 新阶段），复用 v1 idle
   气泡通道（trellis-bubble.js），加去重（同任务同阶段不重弹）
3. **去抖**：快速连续切换（<10s）只弹最终态

## 约束

- trellis-activity 已有 phase 变化检测（onAggregateChange 聚合面）——
  挂钩现成变化通知，不加轮询
- DND / sleeping 时抑制气泡（既有语义）
- 与 idle 气泡共用去重表语义但键独立（phase 转换 vs idle）
- 过渡动画素材缺失时静默降级为仅气泡
- 7 语言（阶段名已有键，新增过渡气泡模板键）

## 验收

- [ ] task.py start（plan→execute）触发气泡；finish 同理
- [ ] 10s 内多次切换只弹一次
- [ ] DND 下不弹；动画缺失不报错
- [ ] npm test 失败集与基线一致
