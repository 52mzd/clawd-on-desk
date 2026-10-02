# Design: 会话历史读取端分组（upstream PR）

## 改造边界（五处，均在 worktree 内基于 origin/main）

| 层 | 文件 | 改动 |
|---|---|---|
| loader | `src/session-history-loader.js` | `loadResumableSessionHistory` 循环重写（全量+分组）；`probeTranscript` 跨目录扩展 |
| runtime | `src/session-history-runtime.js` | 零改动（`getHistory()` 的 `.map` 展开 `{...row}`，`group` 字段自动透传） |
| renderer | `src/dashboard-renderer.js` | `appendSessionHistory` 按组渲染折叠区；`createSessionHistoryCard` 不动 |
| i18n | `src/i18n.js` | 新键（other 组标题/计数），七语言 |
| 样式 | `src/dashboard.html` | 折叠区样式（内嵌 style） |
| 测试 | `test/session-history-loader.test.js` / `test/dashboard-session-history.test.js` | 既有断言改造 + 新用例 |

## 核心契约

### loadResumableSessionHistory 返回形态

```js
// 前 limit 条：group:"confirmed"（probe=true，保持现排序）
// 之后全部：group:"other"（false / null / profile-unverified）
[...confirmed.slice(0, limit), ...other]
```

- over-read（`limit + activeRawSessionIds.size`）逻辑移除：全量拉取后 active 过滤先于分组，confirmed 组内截 limit。
- `resolveResumeTarget` 不动：按 historyKey 从全量 store 查，信任面不变。

### probeTranscript 三态语义扩展

| 场景 | 现行为 | 新行为 |
|---|---|---|
| cwd 项目目录在 + transcript 存在 | true | true（不变） |
| cwd 项目目录在 + transcript ENOENT | false | false（不变） |
| cwd 项目目录不存在（ENOENT） | null | **跨目录扫描**：projectsDir 下任一目录有 `<sessionId>.jsonl` → true；未命中 → null |
| profile 未验证 / 非 claude-code | null | null（不变） |

- 未命中维持 null 而非 false：目录布局是 Claude Code 私有细节，跨目录扫不到 ≠ 确定性不存在（fail-open）。
- daemon 记录（cwd=/，任何目录都无其 transcript）→ null → 落 other 组。**分组靠 group 归类实现隔离，不靠 probe 宣判**——这是与被拒 #1072 的本质区别。

## 关键决策

| 决策 | 理由 |
|---|---|
| profile-unverified 行归 other 组 | 不可信行与不可恢复行同折叠；`resumeDisabledReason` 语义不变（仍 disabled），仅位置变化 |
| 跨目录扫描缓存 projectsDir 目录列表 | 一次 `readdirSync` 供本次 load 共享；200 条 × 每条 lstat 的成本可控 |
| 不排除 $TMPDIR 项目目录（`-private-var-folders-…-T`） | 与 `claude --resume` 跨目录语义一致：能恢复就应显示。PR 描述中说明此边界供维护者裁断 |
| 折叠状态：会话内局部 state，不持久化 | KISS；Dashboard 重开默认收起符合"主列表优先"意图 |
| renderer 复用 createSessionHistoryCard | other 组卡片与主列表同构，仅容器不同（DRY） |

## 性能预算

probe 调用 25 → ≤200 次（每次 2 lstat；跨目录路径额外 1 readdir 共享 + N lstat）。实测 Dashboard 刷新耗时写入 PR 描述。

## 分支与交付

```
git worktree add .worktrees/pr-session-grouping -b pr/session-history-grouping origin/main
```

- 完成后 push 到 52mzd/clawd-on-desk-trellis（它是 upstream 的 GitHub fork，52mzd 可 push）的 `pr/session-history-grouping` 分支——只推 PR 分支，不动 fork main，不违反"fork 只走导出发布"纪律对 main 的保护。
- `gh pr create --repo rullerzhou-afk/clawd-on-desk --head 52mzd:pr/session-history-grouping`
- **push 与 PR create 是外发动作，执行前需用户确认。**
- worktree 内 `npm install` 一次供测试。

## 风险

- probe 成本上升：实测兜底；若显著，缓存策略升级（mtime 目录裁剪）留 PR 讨论。
- 折叠组交互无既有样式参照：dashboard.html 内嵌样式最小化补齐。
- fork main 里的 #1072 残留（transcript-missing 禁用 + 根目录 guard）本 PR 不处理；PR 合并回 fork 后另立任务清理。

## 回滚

PR 分支独立，worktree 删除即回滚；fork main 不受影响。
