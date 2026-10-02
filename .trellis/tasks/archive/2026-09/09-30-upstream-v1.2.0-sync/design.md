# Design: 上游 v1.2.0 同步

## 策略选择

**merge origin/main into 本地 main**（非 rebase）：298 个二开提交逐个 rebase 不现实；
merge 一次解决全部冲突，历史完整保留。本地 main 是二开主干（fork 发布走 commit-tree
导出，不受影响）。

## 冲突裁决表（merge-tree 干跑实测）

| 文件 | 裁决 | 理由 |
| --- | --- | --- |
| `.gitignore` | 并集：上游 `!docs/releases/release-v1.2.0.md` + 本地 trellis 白名单/`.rlm/` | 双方不同 hunk，无语义交叉 |
| `docs/project/theme-state-ui.md` | 上游全收 + 保留本地 Trellis juggling lift 行 | 上游是 Whale-chan/idleVisualOptions 文档更新；本地行独立段落 |
| `package.json` | version → `1.2.0-trellis.1.0`，其余取上游 | deps/scripts 零差异，唯一冲突行是 version |
| `package-lock.json` | 取上游版本，两处 version 改 `1.2.0-trellis.1.0`，`npm install` 校正 | 冲突同源于 version 字段 |
| `scripts/verify-release-contributors.js` | 上游映射赢 + 保留 fork 自己的 null 排除 | `new Map(Object.entries({...}))` **后写键覆盖前写**：本地把 gzx/s.jin 映射 null 若保留在上游映射之后，会静默覆盖上游的正式注册——gzx19990101（#1053）、jin-codes 已有上游 PR，不再符合"无上游 PR 不入墙"排除口径，必须删这两条 null；`dae@mac-studio.local`、`52mzd@users.noreply.github.com`、`200491821+hanzhe-one`（hanzhe-one #1059 已进上游，执行时跑 verify 实证后决定去留）保留 null |
| `test/release-version-contract.test.js` | 取本地 | 本地动态断言 `require("../package.json").version` + pre-release skip 是上游硬编码 `1.2.0` 的泛化超集，天然兼容合并后版本 |

## 自动合并区（需人工复核语义）

- `AGENTS.md`：上游 v1.2.0 文档同步 × 本地二开重写——合并后通读一遍。
- `src/main.js` / `src/state.js` / `src/i18n.js` / `src/settings-window.js` 等：依赖测试全量跑验证。
- `src/settings-window.js` / `src/dashboard.js` 的 acceptFirstMouse：上游 PR #1071 即
  fork 提交，双方改动一致，无冲突。
- `hooks/session-history.js`：上游 #1060 follow-up（SubagentStop 写入端状态机：
  `nothing-to-settle`/`no-active-evidence`/settle 不动 lastEventAt），本地未动 →
  干净采纳。与 issue #1069（cwd=/）无关，与后续读取端分组 PR（改 loader）不冲突。
- `src/session-history-loader.js`：上游未触碰，fork 版（含 #1072 残留）原样保留，
  分组 PR 基线不受影响。

## 版本口径

合并后 `1.2.0-trellis.1.0`：fork 命名惯例的延续（`<上游版本>-trellis.<序号>`）。
不触发发版流程（bump→导出→tag→dispatch 属于后续独立动作）。

## 回滚

merge 提交前任何失败：`git merge --abort` 回到 751719d7。提交后：merge 是单个
提交，`git reset --hard 751719d7` 可整体撤销（工作区 .pi/.trellis 脏文件不在
merge 触碰面，不受影响）。
