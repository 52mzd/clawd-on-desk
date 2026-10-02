# PRD：按 owner review 修订 PR #1085（分组跨目录/性能/confirmed 判据）

## 背景

rullerzhou-afk 在 PR #1085 给出 review：三处必改 + 一处可选文案 + 文档同步 + 一项数据统计请求。
工作分支 `pr/session-history-grouping`（worktree `.worktrees/pr-session-grouping`）。
修完推 52mzd fork 更新 PR，逐条回复 review。

## 需求（owner review 全集）

1. **ENOENT 分支接入跨目录查找**：`probeTranscript` 的 `<id>.jsonl` ENOENT 分支先跑
   `findTranscriptAcrossProjects`，全树未找到才 `false`。`false` 语义升级为「cwd 项目目录在、
   所有项目目录里都没有该 ID」。**三态 fail-open**（eugenewang5425 review 补充，owner 认可）：
   readdir 失败 ≠ 确定缺失，必须归 `null`——`findTranscriptAcrossProjects` 改返回
   true（命中）/ false（全树扫过未找到）/ null（无法完整扫描），部分子目录不可读且未命中也归 null。
2. **性能索引**：跨目录查找改为每次加载建一次 `Map<"<id>.jsonl", dirPath[]>` 索引，查表命中
   再 lstat 校验。总开销 = 每目录一次 readdir，与记录数无关（owner 实测 200×100 场景 ~190ms → ~50ms）。
3. **confirmed 判据加 cwd 存在**：抽 `resolveResumeTarget` 的 cwd 检查（绝对路径 + lstat 是目录）
   为共用小函数；`confirmed = transcript === true && cwd 现存`。不满足的行照常返回、进 other，
   按钮不禁用（resumeDisabledReason 语义不变）。
4. **i18n 文案（可选，采纳）**：折叠按钮文案点明未确认（owner 示例「另有 {n} 条未确认可恢复的会话」），7 语言。
5. **文档同步**：`docs/project/agent-runtime-architecture.md` Local Claude Session History
   （「最多 25 条」→ 主列表 confirmed 上限 + 跨目录查找描述）；`docs/project/theme-state-ui.md`
   Session History 同步。
6. **统计（owner 请求）**：本机 history store 中 `cwd=/` 的记录里有多少会被跨目录查找命中；
   结果如实回复（若量大，owner 倾向写入端处理，读取端不加规则）。

## 验收标准

- [ ] 新用例「cwd 有自己的项目目录、transcript 在另一目录」→ probe true、cwd 目录存在时进 confirmed
- [ ] 同场景 cwd 目录不存在 → 进 other（跨目录命中但 cwd 没了）
- [ ] ENOENT 分支：全树扫过未找到 → false；readdir 失败（subdirs 不可读或部分子目录不可读且未命中）→ null
- [ ] 结构断言：全部未命中时每目录 readdir 恰一次（fs stub 计数，非 ms 计时）
- [ ] 现有 old-checkout 用例改造：先建出 cwd 目录再断言 confirmed（保住「跨目录命中 → confirmed」覆盖）
- [ ] 7 语言文案更新，dashboard 测试断言跟改
- [ ] 文档两处更新
- [ ] worktree 全量测试通过
- [ ] 推 fork 更新 PR + 逐条回复 review（含 cwd=/ 统计结果）

## 非目标

- `$TMPDIR` 会话特殊处理（owner 明确：transcript 存在即 confirmed，唯一可靠判据）
- #1086 的 P1 组合问题（标题提取侧，归 #1086 任务）
- 读取端为 `cwd=/` 加分组规则（等 owner 按统计结果定方向）
