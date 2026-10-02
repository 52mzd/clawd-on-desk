# PRD: 会话历史读取端分组（upstream PR）

## 背景

- issue #1069：daemon 会话（cwd=/）大量写入 session-history，按"最近活动"排名占据恢复列表前排，真实会话被挤出前 25 名（`DEFAULT_HISTORY_LIMIT`）。
- PR #1072 被拒：写入端过滤结构性不可行（cwd 来自 stdin payload，hook 无信号区分 daemon）；把 transcript-missing hint 升级为禁用越过维护者 "hint, don't block" 设计线。
- 维护者指明方向：**读取端分组**——恢复列表全部探测、真会话排前面、不可恢复/不可信行折叠收起。

## 需求

- R1 **loader 全量探测分组**：拉全量历史（store cap 200），每条过 `probeTranscript`；probe=true 行（confirmed）保持现排序截前 `limit` 条为主列表；false / null / profile-unverified 行（other）全部返回，每行携带 `group` 字段。
- R2 **probe 跨目录找**：记录 cwd 的项目目录不存在时，按 sessionId 扫 `~/.claude/projects/` 其他项目目录找同名 transcript（`claude --resume <id>` 本就按 ID 跨目录找）；命中 → true（救回 worktree 会话）。
- R3 **renderer 折叠组**：Dashboard 恢复列表按 group 分两块；other 组默认收起，显示"其他 N 条"，点击展开；Resume 按钮行为不变——false 行照旧可点（hint 不 block）。
- R4 **七语言 i18n**：新增文案 en / zh-CN / zh-TW / ko / ja / pt / es 全量补齐（键完整性契约）。
- R5 **测试改造**：既有用例按分组后形态改断言；新增分组/跨目录/满额挤出回归用例。
- R6 **以 upstream PR 交付**：基于 `origin/main`（48a34f01）干净分支，不含 fork 定制与 #1072 残留。

## 约束

- 上游口径优先：`resumeDisabledReason` 语义不变（仅 `profile-unverified`）；不引入任何写入端改动。
- `probeTranscript` fail-open 原则不变：不可判定读作 null，绝不读作 gone。
- 交付形态是给 rullerzhou-afk/clawd-on-desk 的 PR，代码风格/注释密度与上游一致（英文注释）。

## 验收标准

- AC1 构造 >25 条记录其中含 false 行：confirmed 组满额 25 条真实行全部可见，false 行不再挤出任何真实行。
- AC2 worktree 场景（记录 cwd 目录 ENOENT、transcript 存在于另一项目目录）：probe 跨目录命中返回 true，该行进主列表。
- AC3 折叠组：默认收起显示计数；展开后 other 行可见且各自保留 transcript-missing flag；false 行 Resume 可点（disabled=false）。
- AC4 i18n 七语言新键全部在位（键完整性测试通过）。
- AC5 `npm test` 全绿。
- AC6 PR 分支 diff：仅触及 loader / dashboard-renderer / i18n / dashboard.html / 三个测试文件，无 fork 定制混入。
