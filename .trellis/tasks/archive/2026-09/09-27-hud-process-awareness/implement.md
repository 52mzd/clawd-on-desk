# Implement：HUD 过程级感知

## 顺序清单

1. `src/trellis-activity.js`
   - [ ] `readTailImpl` 可选注入 + 缺省 Node fs 实现（open/stat/read/close）
   - [ ] `readSessionTrace(cwd, rawSessionId)`：sanitized-cwd 推导 → readTail → 逐行预筛+parse → 锚定提取
     （command / workflowStatus / workflowNextAction；Next-Action 截 80 code points）
   - [ ] 轮询循环：绑定任务会话（agentId 为 claude 系）→ per-round 缓存 → TrellisInfo 挂三字段
   - [ ] 顶部 IO 注释块补尾部读一行（D7 表述同步）
2. `src/i18n.js`：`sessionHudTrellisCommand` 7 语言（整行锚定插键，紧邻 sessionHudTrellisPhase* 族）
3. `src/session-hud-renderer.js`：详情行追加「指令 · 步骤」行；三字段缺省时零输出（现状回退）
4. `test/trellis-activity.test.js` 新 describe：
   - [ ] 真实形态 fixture（attachment 行含 workflow-state、user 行含 command-name）→ 提取正确
   - [ ] assistant 行伪迹（thinking/text 含同样字样）→ 不受污染（负向用例，必写）
   - [ ] 尾部半行（截断 JSON）→ 跳过不炸
   - [ ] 窗口外 command（readTail 只回尾部）→ command null
   - [ ] 坏 JSON 行 / ENOENT → 静默 null
   - [ ] readTailImpl 调用计数：每轮每绑定会话恰 1 次；无绑定 0 次
   - [ ] fake fs 写操作计数恒 0（只读断言沿用）
5. `test/session-hud-renderer`（或既有 HUD 行为测试）：有 command 渲染追加行；无 command 与现状一致
6. spec 更新（trellis-panel-contract §「只读感知」）：readSessionTrace 契约 7 段式精简版（锚定形状/尾窗/降级三态）

## 验证命令

```bash
node test/trellis-activity.test.js
node test/session-hud.test.js
node test/session-renderer-behavior.test.js
node test/i18n.test.js
node test/run-tests.js   # 全量；readme-contributors 预存失败除外（8f98410e 时已基线确认）
```

## 风险文件 / 回滚点

- src/trellis-activity.js（轮询循环改动——保持 lifecycleToken 语义，新读挂既有 await 链）
- src/session-hud-renderer.js（详情行高度经 §4.1 实测回传，勿拍常数）
- 回滚：单提交 revert，无持久化/协议变更

## start 前检查

- [ ] implement.jsonl / check.jsonl 已 curate（spec/research 条目）
- [ ] agentId 实际值形态核对（claude 系判定）：main.js 组装侧 grep 确认
