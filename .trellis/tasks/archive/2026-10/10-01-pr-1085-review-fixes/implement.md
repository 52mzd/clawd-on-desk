# 实现步骤（worktree：.worktrees/pr-session-grouping）

## 代码

- [x] 1. `findTranscriptAcrossProjects` 三态化 + 索引化：返回 true / false（全树扫过未找到）/ null
  （无法完整扫描：subdirs 不可读，或任一子目录 readdir 失败且最终未命中）；索引
  `Map<"<id>.jsonl", dirPath[]>` 挂在 projectEntriesCache（专用键），无 cache 时建一次性索引；
  查表命中后仍 lstat 校验
  验证：`node --check src/session-history-loader.js` + 新增三态单测
- [x] 2. `probeTranscript` ENOENT 分支接入跨目录查找（true/false/null 直通）；「目录不存在」
  分支保持 `=== true ? true : null`；函数头注释按两条路径分开写 `false` 语义
  验证：用例「cwd 项目目录在、transcript 在另一目录」→ true；全未命中 → false
- [x] 3. 抽 `isExistingDirectory`（绝对路径 + lstat isDirectory，语义与 resolveResumeTarget 逐字节一致）
  供 resolveResumeTarget 与分组共用；`group = profileVerified && transcript === true && isExistingDirectory(record.cwd)`
  验证：用例 cwd 消失 → other、resumeDisabledReason 不变；resolveResumeTarget 现有用例不回归
- [x] 4. i18n 7 语言折叠文案点明未确认 + dashboard 测试断言跟改
  验证：相关测试通过
- [x] 5. 文档两处（agent-runtime-architecture.md / theme-state-ui.md）
  验证：grep 确认无「最多 25 条」旧口径残留

## 验证

- [x] 6. worktree 内全量 `npm test`

## 交付

- [x] 7. 只读脚本统计本机 `cwd=/` 记录的跨目录命中数（临时脚本，不入库）
- [x] 8. commit（worktree 内，含 Co-Authored-By 尾行）→ push fork
- [x] 9. PR 逐条回复 review + cwd=/ 统计结果（回复文案先给用户过目再发）
