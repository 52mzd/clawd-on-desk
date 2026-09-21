# 文档阅读器（v3 #3）

## 范围

任务详情卡片扩展为文档阅读视图：

1. **可读文档**：PRD / DESIGN / IMPLEMENT / 验收报告 / research 文档
   （任务目录内 `*.md` 全列，tabs 或下拉切换）
2. **受限 GFM 子集渲染**（自写，零依赖）：
   - 标题（h1-h4）→ div 分级样式
   - 段落、行内 code、粗斜体（`**` `*` `` ` ``）
   - 表格（GFM pipe table：表头/分隔行/数据行）
   - 任务清单（`- [ ]` / `- [x]`，含缩进层级，只读）
   - 折叠分区（`## ## ` 嵌套章节 或 `<details>` 透传语义：用标题层级
     实现章节折叠按钮即可，不解析原生 HTML）
   - 代码块（``` 围栏）→ 等宽字体块，内容全转义
   - 链接 → 纯文本显示（不渲染可点链接，避免导航面）
3. **嵌套滚动**：长文档在详情卡片内滚动（max-height + overflow-y）

## 约束（红线）

- **createElement + textContent only**，禁 innerHTML/insertAdjacentHTML；
  渲染器纯函数（md 文本 → DOM 树构建器调用序列），可快照单测
- 未知语法原样文本展示（fail-open 显示，不 fail-crash）
- 文档内容 ephemeral：不落盘、不进 prefs、不进日志
- 归档任务的文档同样可读（taskPath 已参数化）
- 单文档尺寸上限（如 1MB）超限截断提示
- 7 语言（"文档" 标签等键）

## 验收

- [ ] 打开任一归档任务：能读到 PRD 表格 / implement checklist 正确渲染
- [ ] 恶意 md（HTML 注入、超长行、未闭合围栏）不崩、不执行
- [ ] 渲染器单测覆盖每个 GFM 子集元素 + 恶意用例
- [ ] npm test 失败集与基线一致
