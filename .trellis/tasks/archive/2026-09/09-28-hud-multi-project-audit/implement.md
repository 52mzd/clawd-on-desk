# Implement：HUD 多项目分节 + 过程级感知阶梯扩窗

## 执行清单（按序）

### R1 过程级感知修复（三根因）

- [ ] 1. `src/trellis-activity.js`：`readSessionTrace` 改阶梯循环（`TRACE_TAIL_STEPS = [512,1024,2048,4096,8192]` KB；ws 命中即停 / command 命中即停 / 全空才扩）；`TRACE_TAIL_BYTES` 常量退役
- [ ] 2. `src/session-hud-renderer.js:416-426`：第三行门槛放宽为任一过程信号存在；ws-only 分支显示「Status — Next-Action」，command 分支维持原 i18n 文案
- [ ] 3. `test/trellis-activity.test.js`：新增用例——真实 ws 注入块之后填充 ≥2MB tool_result 文本（assistant 行混 `<command-name>`/`<workflow-state>` 伪迹、`prompt_snapshot` 型 attachment 混 command 字样），断言扩窗后 ws 提取成功、伪迹仍被忽略；既有伪迹用例保持通过
- [ ] 4. `test/session-hud*.test.js` / `session-renderer-behavior.test.js`：ws-only（无 command）时第三行渲染「Status — Next-Action」的断言
- [ ] 5. `.trellis/spec/guides/trellis-panel-contract.md`：IO 预算段改阶梯表述 + 信号源实测结论（当前版本 jsonl 无 command 痕迹，ws 为唯一可靠源）

### R2 面板分项目分节

- [ ] 6. `src/trellis-activity.js`：`readHudTaskPanel(anchorCwd)` 改多 root——`collectKnownRootCwds()` 去重到 root、锚定 root 前置、项目 ≤5、每项目 archived ≤3、返回 `{ status, projects }`；无 root → `{ status: "missing" }`
- [ ] 7. `src/main.js:5330-5340`：handler 透传新形状（信任门 `isTrustedEvent` 不动）
- [ ] 8. `src/session-hud-renderer.js`：`createTrellisPanel` 分节渲染（节标题 `trellis-panel-project`、行点击用节 cwd）；`toggleTrellisPanel` 简化（打开即 fetch，missing 关面板，去 per-cwd refetch 分支）
- [ ] 9. 测试：`test/trellis-activity.test.js` readHudTaskPanel describe 组改多项目断言（两 root fixture：锚定前置、cap、去重）；HUD renderer 侧既有面板用例按新形状更新
- [ ] 10. 全量测试 + 基线对比（9 个 Electron GUI fixtures 固有失败外零差异）

### 真实场景验收（用户）

- [ ] 11. 重启 app（先 TaskStop b367r15yi 再 npm start），本会话处于 trellis 流程时，确认面板 header 第三行 ≤5s 显示「planning — Load `trellis-brainstorm`…」（ws 信号）；另一项目会话活跃时面板分两节

## 验证命令

```bash
node --test test/trellis-activity.test.js
node --test test/session-hud.test.js test/session-renderer-behavior.test.js test/session-hud-style.test.js
node --test   # 全量，对比基线
```

## 风险文件与回滚点

- `src/trellis-activity.js`：R1/R2 都改；回滚 = revert 对应 commit（两 commit 分开：R1 一个、R2 一个）
- `src/session-hud-renderer.js`：渲染重写面较大，注意 `reportTrellisDetailHeight` 与 `trellis-panel-*` CSS class 复用
- spec 修订随 R1 commit 一起走

## start 前检查

- [ ] prd/design/implement 三件套齐（本文件）
- [ ] inline 工作流（无 sub-agent dispatch），`implement.jsonl`/`check.jsonl` 留空即可
