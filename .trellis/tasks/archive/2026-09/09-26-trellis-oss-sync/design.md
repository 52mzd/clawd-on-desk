# Design：二开 Trellis 集成整合上游最新版并开源

## 方案总览

**方案 A（已决策）**：从上游最新拉独立分支，把二开公开内容以**单个提交**叠加，推送到 fork。

用户开发分支 `main` **全程不被触碰** —— 这是本任务最重要的安全边界。

## 决定方案简单度的三个已实测事实

| 事实 | 影响 |
|---|---|
| 双方均无文件删除（二开删除 0 / 上游删除 0） | 导出树是**纯叠加**：上游树 + 二开覆盖，无需处理「应删未删」 |
| 上游历史不含 `.trellis/`、`.pi/` | 单提交方案下「历史无泄漏」是**结构保证**，不需要 `filter-repo` |
| `git merge-tree` 零冲突（19 个重叠文件全部自动合并） | 叠加无需人工解冲突；但**语义正确性仍须测试验证** |

## 隔离策略

在独立 `git worktree` 中构建导出树，主仓库工作区完全不受影响。

```bash
git worktree add <export-dir> -b oss-export origin/main
```

- 该 worktree 需要独立 `npm install`（跑测试用，避免污染主仓库 `node_modules`）
- 完成后整块 `git worktree remove` 清理

**明确禁止**：`git merge main` / `git rebase main`。二者都会把 main 的 184 个提交历史（含 `.trellis/`）带进导出分支，直接违反 R4。

## 树构建（只取内容，不取历史）

```bash
# 1. 起点 = 上游最新
git worktree add <export-dir> -b oss-export origin/main

# 2. 用 main 的最终树内容覆盖（不引入任何 main 历史）
cd <export-dir>
git checkout main -- src test docs hooks themes agents assets scripts \
                      extensions pwa perf ci build tools \
                      package.json package-lock.json AGENTS.md .gitignore

# 3. 确保排除路径不在索引与工作区
git rm -r --cached --ignore-unmatch .trellis .pi .gitattributes skills-lock.json
rm -rf .trellis .pi .gitattributes skills-lock.json
```

**必须用显式路径白名单，禁止 `git add -A` / `git add .`** —— 这是防误加未跟踪个人目录（`.agents/`、`.rlm/`、`.claude/`）的第一道防线。

## 清理与修正清单

| # | 目标 | 动作 |
|---|---|---|
| 1 | 排除路径 | 确保 `.trellis/`、`.pi/`、`.gitattributes`、`skills-lock.json` 不在检出与索引中 |
| 2 | `.gitignore` | 补 `.trellis/`、`.pi/`、`.agents/`、`.rlm/`、`skills-lock.json` 规则；把二开误插的 `.rlm/` 从 `tools/chroma_key.py` 与 `tools/fix_gray_bleed.py` 之间移出 |
| 3 | `AGENTS.md` | 删除 `<!-- TRELLIS:START -->`…`<!-- TRELLIS:END -->` 块；**保留**二开的 Trellis 功能说明（文档索引行 + Trellis Settings 面板约束段） |
| 4 | `tools/repository-asset-policy.json` | `thresholds.trackedTreeHardBytes` 还原 `59768832` |
| 5 | `README.md` | 顶部加 fork 声明段（草稿见下） |
| 6 | 悬空引用 | 见「悬空引用实况」 |

## README fork 声明（草稿）

置于标题区之后、原介绍之前，不重写原 README 正文：

```markdown
> **这是 fork。** 基于 [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)
> 上游最新版，新增 **Trellis 工作流集成**：Dashboard 任务视图、Settings 安装/升级向导、
> 宠物状态联动（并行任务杂耍、规划期巫师帽、相位气泡、完成庆祝）。
> 功能权威说明见 `docs/project/trellis-settings-panel.md`。许可沿用上游 AGPL-3.0。
```

可选追加对 `czm15053/trellis-card` 的致谢（属社区礼仪，无许可义务）。

## 悬空引用实况（修正了规划期的高估）

规划期称「246 处提及 `.trellis/`」，实测拆分后结论不同：

| 类别 | 数量 | 处理 |
|---|---|---|
| 代码中的路径构造（`path.join(root, ".trellis")` 等） | `src/*.js` 21 处 | **全部保留** —— 这正是功能实现：读写**用户项目**的 `.trellis` |
| 注释中描述**用户项目**目录结构（`".trellis/tasks/<name>"`、`.trellis/spec/**/*.md`） | 13 处之绝大多数 | **全部保留** —— 功能语义描述，公开后完全正常 |
| 注释中引用**本仓库私有/外部工具**路径 | 约 2 处：`src/trellis-phase.js`、`test/trellis-phase.test.js` 引用 `.trellis/scripts/common/active_task.py` | 该文件属 Trellis CLI（外部工具），保留；必要时补一句「Trellis CLI 的 `active_task.py`」使读者无需该文件也能理解 |

**结论**：悬空引用不是规模问题，无需批量改写；按最小改动原则只做必要措辞澄清。

## 契约与兼容

- 上游 **84 提交全部保留**：导出分支基于 `origin/main`，其历史即上游历史
- `LICENSE` / `NOTICE.md` **不改动**：维持 AGPL-3.0 与上游版权声明
- 不改上游既有代码逻辑：本次只做「排除 + 回退 + 文档」
- 二开功能源码（`src/trellis-*.js` 等）与测试**原样保留**

## 验证策略

| 验收 | 手段 |
|---|---|
| A2 上游 84 提交完整 | `git merge-base --is-ancestor origin/main HEAD` 必须成立 |
| A3 测试基线 | `npm test` 与 macOS 存量 26 条基线比对，零新增失败 |
| A4 无排除路径/隐私残留 | 树扫描 + 全历史扫描零命中；单提交方案下历史 = 上游历史 + 1 提交，结构上干净 |
| A5 许可 | `LICENSE` 首行 AGPL-3.0；`NOTICE.md` 存在 |
| A6 真机 | `npm start` 启动无错，且 Dashboard Trellis 视图 / Settings Trellis 页可用 |
| A7 悬空引用 | 见上表结论 |

## 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| 上游 84 提交改变 hook 点语义 → 测试新增失败 | 阶段 3 全量测试必须先过，未过不得进入阶段 4 | 未推送前删除 worktree 即可，主仓库零影响 |
| 覆盖时误改上游新文件 | 显式白名单 + 提交前 `git status` / diff 审查 | 同上 |
| fork 误建为 private | 推送后用 `gh repo view` 复核 `visibility=public` | 可改可见性 |
| 误把未跟踪个人目录带入 | 白名单式 add + 补齐 `.gitignore` + 提交前扫描 | 同上 |

**贯穿全程的不变量**：不修改用户 `main` 分支、不向 `origin` 推送任何内容。

## 发布流程

1. `gh repo fork rullerzhou-afk/clawd-on-desk --clone=false` → 产出 `52mzd/clawd-on-desk`
2. 导出 worktree 添加 fork remote 并推送分支
3. 复核：公开可见性、上游完整性、README 声明生效

## 已推迟 / 不做

- 不向上游提 PR / 不回贡
- 不做 `filter-repo` 历史重写（方案 A 已从结构上避免）
- 不重写二开功能实现
- 不处理 fork 后续与上游的持续同步策略（可另开任务）
