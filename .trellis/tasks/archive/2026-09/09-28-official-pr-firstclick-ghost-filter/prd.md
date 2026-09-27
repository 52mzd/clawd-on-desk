# 官方 PR：acceptFirstMouse + 幽灵会话过滤

## 背景

- issue #1069（官方 rullerzhou-afk/clawd-on-desk）已报幽灵会话问题：
  恢复列表展示 transcript 已消失的死会话，`resolveResumeTarget` 对
  `cwd="/"` 放行。当时走 issue 路线未带补丁。
- fork 已修 acceptFirstMouse（26e331ff，macOS 后台第一击双击问题），
  官方基线仍存在，修法与官方 `permission.js` 既有写法一致。
- 用户指令：两个都推官方 PR，**发 PR 前先在 issue #1069 评论说明**。

## 交付物

1. **issue #1069 预告评论**（先行）：说明将提交两个 PR（acceptFirstMouse
   顺带提及；幽灵会话过滤为主），附一句修法摘要。
2. **PR1 acceptFirstMouse**：基于 `origin/main` 的干净分支 cherry-pick
   `26e331ff`（4 文件：dashboard.js / settings-window.js + 两个测试），
   push 到 fork remote 的 `pr/*` 分支，`gh pr create` 指向官方。
3. **PR2 幽灵会话过滤**：基于 `origin/main` 的干净分支：
   - `loadResumableSessionHistory`：`transcript === false`（确定性缺失）
     的行 `continue`，不进恢复列表；`null`（未知）仍展示——fail-open
     语义不动
   - `resolveResumeTarget`：cwd 为文件系统根（`path.parse(cwd).root ===
     cwd`）时 return null
   - 测试加进官方 `test/session-history-loader.test.js`（false 滤出 /
     null 仍展示 / cwd 根拒绝），PR 描述带 `Fixes #1069`

## 验收标准

- [ ] issue #1069 有预告评论
- [ ] 两个 PR 在官方仓库可见，diff 只含官方文件（零 fork 基建泄漏）
- [ ] PR2 分支上 `node --test test/session-history-loader.test.js` 全绿，
      且全量相关套件（dashboard/settings-window/loader）无回归
- [ ] 本地 main 与 fork/main 不动（PR 分支独立，走 worktree）
- [ ] fail-open 红线不回归：`transcriptPresent === null` 行仍提供

## 边界 / 不做

- 不动 probeTranscript 的三态语义与渲染层的标记逻辑（PR2 只在 loader
  层过滤，UI flag 留给官方决定去留）
- 不拒绝 homedir 作为 resume cwd（在 home 跑 claude 合法），只拒文件系统根
- Trellis/.trellis 改动不入 PR 分支
