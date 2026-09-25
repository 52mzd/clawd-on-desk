# Implement Plan：二开 Trellis 集成整合上游最新版并开源

**贯穿全程的不变量**：用户 `main` 分支全程不被修改；不向 `origin`（上游仓库）推送任何内容；所有构建动作在独立 worktree 内进行。

## 阶段 0 · 准备与预检（只读）

- [x] 0.1 确认 fork 尚不存在：`gh repo view 52mzd/clawd-on-desk` → GraphQL “Could not resolve to a Repository”；`gh auth status` = 52mzd（repo / workflow）
- [x] 0.2 `git fetch origin` 后 `origin/main` = `0533435b`，分叉点 = `6449735a`（上游 ahead 84 / 本地 ahead 184，与规划一致）
- [x] 0.3 导出源 `main` HEAD = `f1a9a01c`；工作区 clean（仅本任务自己的未跟踪任务目录）
- [x] 0.4 **基线改造**（见「执行备注」§4）：主仓库 main 的 26 条失败含分叉点旧测试，不可作对照。改跑上游纯态基线 → `/tmp/oss-baseline-upstream-fails.txt`（fail 5）

## 阶段 1 · 导出 worktree 与树构建

- [x] 1.1 `git worktree add /tmp/clawd-oss-export -b oss-export origin/main`（隔离于用户 codes 目录）
- [x] 1.2 **改用无历史三方合并**（见「执行备注」§1）：`git merge-tree --write-tree HEAD main` → tree `28606c89`，退出码 0 无冲突 → `git read-tree -u --reset`。原 `checkout main -- <paths>` 方案实测会回退上游 163 个文件的改动
- [x] 1.3 移除排除路径：`git rm -r --cached --ignore-unmatch .trellis .pi .gitattributes skills-lock.json` + `rm -rf` 同步工作区
- [x] 1.4 `git status --porcelain`：无 `??` 未跟踪条目，无 `.agents/` / `.rlm/` / `.claude/`
- [x] 1.5 `git diff --stat 6449735a..HEAD` = 254 文件 / +46207 −1202（上游 84 提交 + 二开公开面），无 `.trellis` 条目

> **回滚点 R1**：`git worktree remove --force <export-dir>` + 删除 `oss-export` 分支。主仓库零影响。

## 阶段 2 · 清理与修正

- [x] 2.1 `.gitignore`：`.agents/` 上游已有，仅补 `.trellis/`、`.pi/`、`.rlm/`、`skills-lock.json`，并把 `.rlm/` 从 `tools/chroma_key.py` 与 `tools/fix_gray_bleed.py` 之间移出
- [x] 2.2 `AGENTS.md`：删除 `<!-- TRELLIS:START -->`…`<!-- TRELLIS:END -->` 块（266–287 行）；文档索引行与 Trellis Settings 面板约束段保留
- [x] 2.3 **实测否决还原**（见「执行备注」§3）：上游纯态 tracked tree 已 59,748,463 字节（阈值 59,768,832 仅余 ~20KB），导出树 60,756,616 字节，还原会新增 2 条 audit 失败。**保留二开值 60,817,408**（余量 ~60KB）
- [x] 2.4 `README.md`：按 design 草稿在 hero 之后、首段介绍之前插入 fork 声明段
- [x] 2.5 悬空引用：3 处最小澄清（`src/trellis-phase.js` ×2、`test/trellis-phase.test.js` ×1 明确 `active_task.py` 属 Trellis CLI；`docs/project/trellis-settings-panel.md` 删除指向未公开任务目录的 “Source of truth” 句）。其余 `.trellis` 提及均为功能路径构造 / 用户项目目录描述，保留
- [x] 2.6 扫描：树内排除路径零命中；`/Users/Dae`、`Dae@Mac-Studio.local`、`Mac-Studio` 零命中；凭据模式命中项全部为上游既有 redaction 测试 fixture

> **回滚点 R2**：`git checkout -- .` 后重做阶段 1.2–2.5。

## 阶段 3 · 本地验证（不通过不得进入阶段 4）

- [x] 3.1 worktree 内 `npm install --prefer-offline` 独立依赖完成
- [x] 3.2 `npm test`：fail 5，与上游纯态基线集合 **diff 为空**（零新增失败）；tests 11651 / pass 11600 / skipped 46
- [x] 3.3 `HOME` / `CFFIXED_USER_HOME` 隔离启动（避开用户实例的 23333）：`Clawd state server listening on 127.0.0.1:23334`、`GET /state` 200、无错误日志。二开 UI 入口静态确认存在（dashboard.html 396 / settings.html 2 / preload-settings 30 / session-ipc 15 / main 89 命中）。**Dashboard Trellis 视图与 Settings → Trellis 页的交互仍需人工验收**
- [x] 3.4 `git merge-base --is-ancestor origin/main HEAD` 退出码 0；追加逐字节验证：上游 163 个「改而二开未改」文件全部等于 `origin/main`，19 个重叠文件的上游新增 580 行 100% 保留
- [x] 3.5 `LICENSE` = AGPL-3.0 未改动（`git diff HEAD -- LICENSE NOTICE.md assets/LICENSE` 为空）

## 阶段 4 · 单提交与发布

- [x] 4.1 逐文件 `git add -- <path>`（93 条，禁 `-A`）→ 单次 commit（amend 后 `5ebefd3e`，93 文件 / +24950 −145），author `dae <52mzd@users.noreply.github.com>`（避免 `Dae@Mac-Studio.local` 入历史）
- [x] 4.2 提交前扫描零命中（排除路径 / 本机身份 / 真实凭据）；提交后追加：导出分支全历史路径零命中、可达 23347 对象 blob 内容扫描零命中
- [x] 4.3 `gh repo fork rullerzhou-afk/clawd-on-desk --clone=false` → `https://github.com/52mzd/clawd-on-desk`
- [x] 4.4 添加 fork remote，`git push fork oss-export:main` → `0533435b..5ebefd3e  oss-export -> main`
- [x] 4.5 复核全绿：`visibility=PUBLIC`、`isFork=true`、`defaultBranchRef=main`、parent=`rullerzhou-afk/clawd-on-desk`；远端 `.trellis`/`.pi`/`skills-lock.json` 均 404；README fork 声明（英文）可见；**远端 compare `ahead_by:0 behind_by:1`** = GitHub 自证 fork 仅比上游多 1 个提交

## 阶段 5 · 收尾

- [ ] 5.1 清理：移除 worktree、临时文件、探针
- [ ] 5.2 逐条核对 PRD 验收标准 A1–A7 并报告结果与残余风险

## 验证命令速查

```bash
# 上游完整性
git merge-base --is-ancestor origin/main HEAD && echo "上游完整 ✓"

# 排除路径零命中（树）
! git ls-tree -r --name-only HEAD | grep -qE '^\.(trellis|pi)/|^\.gitattributes$|^skills-lock\.json$'

# 排除路径零命中（全历史）
! git log --all --name-only --format= | grep -qE '^\.(trellis|pi)/'

# 本机身份零命中
! git grep -nE '/Users/Dae|Dae@Mac-Studio\.local' HEAD -- . | grep -q .

# 测试基线
npm test 2>&1 | grep -E "^✖" | sed 's/ ([0-9.]*ms)//' | sort -u > /tmp/oss-after.txt
diff /tmp/oss-baseline.txt /tmp/oss-after.txt && echo "零新增失败 ✓"
```

## 危险操作清单（禁止）

- 禁止 `git merge main` / `git rebase main` 到导出分支 —— 会引入含 `.trellis/` 的历史
- 禁止 `git add -A` / `git add .` —— 会连带未跟踪个人目录
- 禁止向 `origin` push 任何内容（那是上游仓库，且用户无推送权限）
- 禁止修改用户 `main` 分支（含 checkout 切换导致的工作区变更）
- 禁止 `push --force` 到任何 remote

## start 前检查

- [x] `prd.md` / `design.md` / `implement.md` 三者一致，无未决阻塞问题
- [x] `implement.jsonl` / `check.jsonl` 含真实 spec/研究条目（非种子行）
- [x] 用户已明确批准最终规划摘要

---

## 执行备注（实际执行与规划的 4 处偏差，均已验证）

### §1 树构建：`checkout main -- <paths>` → 无历史三方合并（**规划的实质缺陷**）

`git checkout main -- src test docs hooks themes agents …` 会把这些路径整体替换为 main 版本。
main = 分叉点 + 二开，因此**上游 84 提交在其中的改动全部回退**：

- 上游改了 182 个文件；其中 163 个「上游改而二开未改」的文件会被回退（含 `hooks/*` 26 个、`src/*` 31 个、
  `agents/registry.js`、`assets/*` 6 个、`scripts/*` 4 个、`ci` 1 个）
- 19 个重叠文件（`src/state.js`、`src/permission.js`、`src/prefs.js` 等）会丢弃上游 580 行新增

改用：`git merge-tree --write-tree HEAD main`（base = merge-base = `6449735a`）→ 退出码 0、零冲突 →
`git read-tree -u --reset <tree>`。HEAD 仍是 `origin/main`，不引入 main 历史。
验证：163 文件逐字节等于 `origin/main`；19 个重叠文件上游新增 580 行 100% 保留。

### §2 基线：主仓库 main 的 26 条失败不是有效对照

主仓库 main 缺少上游 84 提交，其 Dashboard / hud / `Windows terminal focus` / `#1026` 等 17 条失败在
导出树（含上游修复）中自然通过。正确对照 = `origin/main` 纯态：**fail 5**（`/tmp/oss-baseline-upstream-fails.txt`）。
导出树（阈值修正后）= 同样 10 行输出，`diff` 为空。

### §3 `trackedTreeHardBytes` 不能还原为上游原值

| 状态 | tracked bytes | 阈值 59,768,832 |
|---|---|---|
| `origin/main` 纯态 | 59,748,463 | 余 ~20 KB（上游自身就贴线） |
| 导出树（上游 + 二开） | 60,756,616 | **超限 988 KB** |
| 二开值 60,817,408 | 60,756,616 | 余 ~60 KB ✔ |

二开新增 38 个文件共 636,112 字节即为超出主因。还原会新增 2 条 audit 失败（违反 A3），**故保留二开值**。
注意余量仅 ~60 KB：下次上游同步若增长超过该值，该 gate 会再次失败（上游自身余量也只有 ~20 KB）。

### §4 执行范围

已执行 阶段 0 / 1 / 2 / 3 + 4.1–4.5（含 fork 与 push）。阶段 5 部分完成：
worktree `/tmp/clawd-oss-export` **暂保留**（含已 `npm install` 的依赖，便于后续微调后重推，避免重建成本）；
确认用户满意后再执行 `git worktree remove`。另：临时基线 worktree `/tmp/clawd-oss-baseline` 已自行清理（非计划内产物）。

**4.1 amend 说明**：README 由中文声明改为英文后 `git commit --amend --no-edit`，hash `841b2126` → `5ebefd3e`；
改后重跑 `npm run audit:assets` 确认仍为 0 error / 1 warning（tracked 60,756,678 字节，阈值余量 ~60 KB）。
4.5 的远端 `compare` 结果（`ahead_by:0 / behind_by:1`）是比本地 `merge-base --is-ancestor` 更强的上游完整性证据。
