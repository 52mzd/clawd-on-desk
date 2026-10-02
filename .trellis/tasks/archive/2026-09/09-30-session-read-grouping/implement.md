# Implement: 会话历史读取端分组（upstream PR）

- [x] 1. 建 worktree：`.worktrees/pr-session-grouping` 分支 `pr/session-history-grouping` 基于 `origin/main`；worktree 内 `npm install`
  - 验证：`git log -1` 为 48a34f01；`node -e "require('./src/session-history-loader.js')"` 无错
- [x] 2. loader 分组：`loadResumableSessionHistory` 全量拉取 + probe 全跑 + confirmed/other 分组 + `group` 字段；移除 over-read
  - 验证：session-history-loader.test.js 既有用例改造后全绿 + 新增分组/满额挤出用例
- [x] 3. probe 跨目录：cwd 目录 ENOENT 分支扫其他项目目录（目录列表一次 readdir 缓存）；命中 true / 未命中 null
  - 验证：新增 worktree 场景用例（跨目录命中 → true；daemon 场景 → null → other 组）
- [x] 4. renderer 折叠组 + i18n：`appendSessionHistory` 按组渲染；other 组默认收起、计数、点击展开；i18n 七语言新键；dashboard.html 样式
  - 验证：dashboard-session-history.test.js 既有 :288 用例改造（flag 在、可点不变）+ 折叠交互新用例；i18n 键完整性测试通过
- [x] 5. 全量测试 + 性能测量：worktree 内 `npm test`；probe 全量（≈200 条）耗时实测
  - 验证：全绿；耗时数据记录（写进 PR 描述）
- [x] 6. 提交分支 + push 到 52mzd fork 的 pr 分支 + `gh pr create`（PR 描述：背景 #1069/#1072、方案、测试、性能、$TMPDIR 边界）
  - 验证：PR URL 返回；diff 仅六个目标文件；【push/PR 前须用户确认】
- [x] 7. 收尾：主工作区核对无裹挟；journal；archive
  - 验证：`git log` 顺序正确；fork main 无 diff
