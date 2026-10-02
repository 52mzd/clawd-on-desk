# 实现步骤（worktree：.worktrees/pr-session-titles）

## 代码

- [x] 1. `extractTitleFromTranscript` 重写标题出口：require `../hooks/cursor-session-title`
  的 `extractPromptTitle`；找到第一条真实 prompt 后喂 `raw.trim()` 原文；返回 null 即终局
  （不再往后找）；斜杠命令记录保留（`<command-message>` 包装不算真实 prompt，全文件无真实
  prompt 时回退 command）
  验证：密钥/多行密钥用例（owner 两个复现例分别变「无标题」与只含第一行）
- [x] 2. null 守卫 + try/catch：`entry &&`、`part &&`；整个提取函数体包 try/catch 返回 null
  验证：content 含 null part / 整行 null 的 transcript → 列表完整、该行无标题
- [x] 3. tool_result 结构判断：`Array.isArray(content) && content.some((p) => p && p.type === "tool_result")` 整条跳过；删除子串 includes
  验证："why does tool_result come back empty?" 正常命名
- [x] 4. command 提升到 window 循环外，末尾 `return command`
  验证：>1MiB 文件（大记录 + 斜杠命令开头）→ 标题 `/specrune-init`
- [x] 5. 模块级标题缓存 `Map<path, {mtimeMs, size, title}>`（title 可为 null——取不到也缓存）；
  stat 后查缓存命中直接返回；导出 `clearTitleExtractionCache()` 供测试隔离
  验证：stub 读计数（二次加载零 open/read）、mtime 变化重提取
- [x] 6. 文档两处按 owner 措辞改写
  验证：grep 无旧口径残留

## 验证

- [x] 7. worktree 内全量 `npm test`（含现有四个标题用例不回归）

## 交付

- [x] 8. commit（含 Co-Authored-By 尾行）→ push fork
- [x] 9. PR 逐条回复 review + P1 说明（回复文案先给用户过目再发）
