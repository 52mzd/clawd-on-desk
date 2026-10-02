# PRD：按 owner review 修订 PR #1086（标题规则对齐/4 bug/缓存）

## 背景

rullerzhou-afk 在 PR #1086 给出 review：核心要求「标题规则与 live 完全一致」+ 四个 bug +
缓存（必做）+ 文档同步。工作分支 `pr/session-history-titles`（worktree `.worktrees/pr-session-titles`）。
修完推 52mzd fork 更新 PR，逐条回复 review。

## 需求（owner review 全集）

1. **标题规则对齐 live（最主要）**：找到第一条真实 prompt 后，把 trim 过的**原文**交给
   `hooks/cursor-session-title.js` 导出的 `extractPromptTitle`（第一非空行 / 命中
   PROMPT_TITLE_SECRET_RE 不给标题 / 40 字）。返回 null（命中密钥）→ 不给标题且**不再往后找**
   下一条 prompt。不再自行 `replace(/\s+/g, " ")` 拼行 + 截 80 字。
2. **null 健壮性**：`content.find` 回调加 `part &&`；`entry.type` 前加 `entry &&`（整行
   JSON `null`）；整个 `extractTitleFromTranscript` 包 try/catch，任何意外返回 null，
   绝不让一行坏数据清空整个「最近会话」列表。
3. **tool_result 按结构判断**：`content` 数组含 `type: "tool_result"` 块的条目整条跳过，
   不再对用户输入做子串匹配（"why does tool_result come back empty?" 必须正常命名）。
4. **大文件不丢斜杠命令**：`command` 声明提到 window 循环外，循环结束 `return command`
  （现状仅 `read >= size` 才返回，>1MiB 文件丢已找到的命令名）。
5. **缓存（必做）**：路径 + mtime（+size）为键缓存提取结果，**取不到也缓存**；让 Dashboard
   刷新近乎零成本（owner 实测：首条 prompt 在 1MiB 之后时单次 80–110ms，且每次刷新同步重跑）。
6. **文档同步**：`agent-runtime-architecture.md`「loader 只作存在性提示、不读取内容」与
   `theme-state-ui.md`「不展示完整路径或对话内容」不再成立，按 owner 措辞改写（loader 读已确认
   transcript 的第一条用户输入、按 live 同一规则生成标题、只用于显示不写入历史；卡片显示
   session ID 前 8 位）。

## 验收标准

- [ ] 密钥 prompt（含 ghp_ token / AWS key）→ 无标题；多行 prompt 第二行密钥 → 标题只含第一行内容
- [ ] `content` 数组含 null part / 整行 null → 不抛异常，列表完整返回
- [ ] 提到 "tool_result" 的正常提问正常命名
- [ ] >1MiB 文件中先有斜杠命令 → 标题保留 `/命令名`
- [ ] 已有标题绝不覆盖；probe 非 true 行不提取（现状行为不回归）
- [ ] 缓存：同批会话二次加载零文件读（stub 计数）；mtime/size 变化后重提取；取不到也缓存不重试
- [ ] 现有四个标题用例保持通过（owner 本地已验证）
- [ ] 文档两处更新；worktree 全量测试通过
- [ ] 推 fork 更新 PR + 逐条回复 review（回复文案先给用户过目）

## 非目标

- P1（与 #1085 合并后的跨目录路径组合问题）：owner 未列入本 PR 清单，且本分支探测不含跨目录
  查找、当前无实际影响——PR 回复中说明已确认、待 #1085 落地后跟进，不在本分支做投机改造
