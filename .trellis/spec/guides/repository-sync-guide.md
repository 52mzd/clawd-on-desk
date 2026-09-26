# Repository Export & Sync Guide

> **Purpose**: 把「本地开发分支」导出成「发布/同步形态」时，避开 git 的静默回退与检查盲区。
>
> 来源：2026-09-26 `09-26-trellis-oss-sync` 任务复盘（规划者的方案有实质缺陷，由实现者实测纠正）。

---

## 陷阱 1：`git checkout <branch> -- <paths>` 会静默回退上游改动

### 场景

要从上游最新拉一个干净分支，再把本地二开内容叠加上去（"上游 + 我的改动"导出）：

```bash
git worktree add <dir> -b export origin/main
cd <dir>
git checkout main -- src test docs hooks ...   # ❌ 错误做法
```

### 为什么错

`main` = **分叉点 + 二开**。`checkout main -- <paths>` 把这些路径**整体替换**成 `main` 的版本，
等于把「上游在这些路径上的全部改动」**回退到分叉点**。

实测（09-26）：上游改了 182 个文件，其中 **163 个「上游改而二开未改」的文件会被整体回退**
（`hooks/*` 26、`src/*` 31、`agents/registry.js`、`assets/*` 6、`scripts/*` 4、`ci` 1 …），
19 个重叠文件还会丢掉上游新增的 **580 行**。

### 检查盲区（真正危险的地方）

**`git merge-base --is-ancestor origin/main HEAD` 照样通过** —— 导出分支的**历史**确实基于 `origin/main`，
只是**文件内容**被回退了。所有"只看历史、不看内容"的验证都发现不了：

- `git log` / `git rev-list --count`：正常
- GitHub compare 的 `ahead_by` / `behind_by`：正常
- 甚至"上游提交都在"的结论也成立

### 正确做法：无历史三方合并

```bash
git worktree add <dir> -b export origin/main
cd <dir>
git merge-tree --write-tree HEAD main     # base = merge-base，输出合并后的 tree oid
git read-tree -u --reset <tree-oid>       # 应用结果；HEAD 不动，不引入 main 历史
git rm -r --cached --ignore-unmatch <要排除的路径>
rm -rf <要排除的路径>
```

- `merge-tree` 以 merge-base 为 base 做**真三方合并** → 上游改动保留、二开改动叠加
- `read-tree` 只写索引与工作区，**不产生 merge commit** → 导出分支历史仍是「上游 + 1」

### 判据（内容级验证，缺一不可）

> **导出/同步后，验证不能只看历史关系，必须对比内容。**
>
> 1. 上游「改而本分支未改」的文件与上游**逐字节相同**（`cmp`）
> 2. 重叠文件中，上游新增的行 **100% 保留**（按行计数）
> 3. 测试失败集合与**上游纯态基线**一致（见陷阱 3）

---

## 陷阱 2：同一份策略文件在不同形态下需要不同的值

`tools/repository-asset-policy.json` 的 `trackedTreeHardBytes` 是仓库体积硬阈值。
本地开发态与导出发布态的 tracked tree 不同，因此阈值**不同源**：

| 形态 | 阈值 | 原因 |
|---|---|---|
| 本地 `main` | `65011712`（62 MiB） | 额外跟踪 `.trellis/`（291 文件，~1.3 MB） |
| 导出 / fork | `60817408` | 不含 `.trellis/` |

**两个方向的错误都要显式核对**：

- 把本地态值带进导出 → 体积回落，阈值**过宽而静默失去 gate 意义**
- 把发布态值带回本地 → 体积上涨，**直接报错**（4 条 audit 测试失败）

**上游自身余量极小**：09-26 实测上游纯态 59,748,463 vs 上游阈值 59,768,832，**仅余 ~20 KB**。
所以上游每次发布都可能微调该值 —— merge 上游时若该文件冲突，以「本地态」值为准。

---

## 陷阱 3：基线必须取自正确的对照态

判断"我的改动有没有引入回归"时，基线必须取自**同一基线的纯态**：

- ❌ 拿「本地 main（分叉点 + 二开）」的失败集合，对照「上游 + 二开」的失败集合
  → 分叉点之后**上游修好的 bug** 会表现为"我的改动修好了它"，反之亦然
- ✅ 先单独 checkout `origin/main` 跑一次得到**上游纯态基线**，再对照目标态

09-26 实测：本地 main 基线 **26** 条 vs 上游纯态基线 **5** 条，差异 17 条**全部来自上游修复**、
与二开无关。用错基线会把上游的修复误读成自己的功劳或自己的回归。

**推论**：任何"零新增失败"的结论，都必须写清楚**基线取自哪个态**，否则结论不可复现。

---

## 快速检查清单

导出/同步前：

- [ ] 用 `merge-tree` + `read-tree`，**不用** `checkout <branch> -- <paths>`
- [ ] 明确列出排除路径，用**显式路径白名单** add（禁止 `git add -A`）
- [ ] 确认策略文件（阈值等）取的是**目标形态**的值

导出/同步后：

- [ ] 上游非重叠文件逐字节相同
- [ ] 重叠文件的上游新增行全部保留
- [ ] 测试失败集合与**上游纯态基线**一致
- [ ] 排除路径在树内与**导出分支历史**中都零命中
- [ ] 本机身份（用户名/邮箱/绝对路径）在树内容与 commit author 中都零命中

---

## 下一步：发布

导出/同步完成后，要把结果发布成可下载的 GitHub Release 时，
读 [Fork Release Guide](./fork-release-guide.md)。
上游的发布契约测试与 GitHub 的 release 行为另有 6 个坑：`docs/**` 逐文件白名单、
commit author 泄漏本机身份、贡献者三处一致、semver `previousTag` 回退、
GUI 启动拿不到 shell PATH、pre-release 不计入 `latest`。
