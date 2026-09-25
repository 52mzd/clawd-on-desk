# 二开 Trellis 集成整合上游最新版并开源

## Goal

把本地二开的「Trellis 集成」内容整合进上游最新版，fork 到用户自己的 GitHub 账号并公开，使二开成果成为可独立使用、可被他人复用的开源仓库。

## Background（调研已确认的事实）

### 仓库与分叉现状

- `origin` **就是官方仓库** `rullerzhou-afk/clawd-on-desk` —— 用户直接在官方仓库 clone 上二开，本地 `main` 跟踪 `origin/main`
- 分叉点 `6449735a`（上游 PR #1028 `fix/issue-1026-opencode-managed-generation`，merge commit）
- 上游领先 **84** 提交（最新 `0533435b` Merge PR #1052 `fix/kimi-agent-pid`）
- 本地二开 **184** 提交，作者全部为 `dae <Dae@Mac-Studio.local>`（无上游提交混入）
- `gh` CLI 已认证账号 **`52mzd`**（`repo` + `workflow` scope，https 协议）

### 二开改动构成

- 总计 406 文件、+47408 −145
- **新增源码**（二开主体）：`src/trellis-{activity,archive,bubble,celebration,checklist,cli,doc-renderer,ipc,phase,platforms,roots,runtime,scanner,version}.js`、`src/dashboard-trellis-panel.js`、`src/recap-trellis.js`、`src/settings-tab-trellis.js`、`src/settings-tab-trellis-wizard.js`、`src/trellis-bubble.html`
- **修改既有文件**：`src/main.js`、`dashboard.html`、`dashboard-renderer.js`、`i18n.js`、`prefs.js`、`state.js`、`permission.js`、`session-hud*`、`settings-*`、`session-ipc.js` 等（hook 点接入，非重写）
- 新增测试：`test/trellis-{version,scanner,runtime,roots,platforms,phase,ipc,doc-renderer,cli,checklist,celebration,bubble}.test.js` 等
- 提交构成：`feat(trellis)` 33、`chore(task)` 57、`docs(spec)` 22、`fix(trellis)` 14、`fix(dashboard)` 6、其余零散
- **`.trellis/` 目录为二开新增**（上游无此目录）：240 个任务文件 + 31 个 scripts + 10 spec + 3 workspace

### 整合可行性（已实测）

- 与上游**重叠文件仅 19 个**（其中核心源码/测试 15 个：`src/{dashboard-renderer,i18n,main,permission,prefs,session-ipc,settings-actions,settings-i18n,settings-ipc,state}.js` + 5 个 test）
- `git merge-tree --write-tree --name-only HEAD origin/main` → **退出码 0，无任何冲突文件**（零文本冲突）
- ⚠️ 零文本冲突 ≠ 语义正确：上游 84 提交可能改变 hook 点周边契约，**必须以「merge 后跑通测试基线」为准**

### 许可与合规（已实测）

- 上游 `LICENSE` = **AGPL-3.0**（强 copyleft）
- fork 开源必须：保持 AGPL-3.0、保留上游版权与许可声明、公开源码
- 本仓库自带 `tools/` 资产策略与 native package 审计，二开不得破坏

### 第三方参照排查：`czm15053/trellis-card`（已实测，结论：无代码复制）

用户在二开过程中把该项目作为**产品形态参照**（任务记录明确写「参照」「只取结构，不取配色」）。合规排查结论：

- 该项目**无 LICENSE**（GitHub API `license=null`，仓库内无 LICENSE 文件）→ 法律上默认保留全部权利，**复制其代码将构成侵权风险**，因此必须确认无代码移植
- 双向标识符比对（trellis-card 546 个 vs 本仓库 8173 个）→ 交集 **44 个全部是标准 Web API 与通用词汇**（`getBoundingClientRect`、`requestAnimationFrame`、`matchMedia`、`translateX/Y`…），**无任何 trellis-card 专有标识符**
- 25-token 连续片段比对（trellis-card 113192 窗口 vs 本仓库 1270132 窗口）→ 相同片段 **112 个，其中含 JS 业务逻辑的 0 个**；性质归类：**55 个 CSS 声明样板 + 53 个 SVG/图标无障碍样板 + 4 个其他**
  - 典型命中：sr-only 的 `clip: rect(0,0,0,0)`、`stroke="currentColor" stroke-width="2" stroke-linecap="round"`（图标固定签名）、`align-items:center; justify-content:center`、`color-mix(in srgb, var(--accent) …)`
  - 均属不可版权保护的通用样板（scenes à faire），分布集中在 `src/settings.css`(53)、`src/session-hud-renderer.js`(34)、`src/dashboard.html`(18)
- 反向佐证：`state-dot`、`pop-in` 在 trellis-card **不存在**（本仓库自造，故 `trellis-card-pop-in/out` 指"trellis 任务卡片"入场动画，非引用该项目）；`lib-*` / `note-progress` 双方均无（PRD 提到的 noty-ui 分支已不存在）；trellis-card 使用的 `gsap` 动画库本仓库**未引入**（符合 AGENTS.md「不引入 JS 动画引擎」）
- **判定**：借鉴的是产品形态、信息架构与 UI 结构（思想），**未移植表达**，无许可义务
- 可选（非强制）：README 致谢参考项目，属社区礼仪而非许可要求

### 开源范围（已决策）

用户决策：**工作流框架一并排除**（"这个是我自己的开发流程，不需要公开"），并要求"类似 .pi、.rlm 这种目录都要排除"。

#### 公开（功能本体）

`src/`、`test/`、`docs/`（含 `docs/project/trellis-settings-panel.md`）、`hooks/`、`themes/`、`agents/`、`assets/` 等上游既有目录的二开增量，以及根级 `AGENTS.md`（见下）。

#### 排除（精确清单，已 `git ls-files` / `--ignored` 实测）

| 路径 | 状态 | 排除理由 |
|---|---|---|
| `.trellis/` | 被跟踪 **291** 文件 | 工作流框架 + 任务记录 + journal |
| `.pi/` | 被跟踪 **21** 文件 | 个人 agent 配置 |
| `.gitattributes` | 二开新增（A） | **纯 Trellis 工作流文件**：整份内容是 `.trellis/workspace/*/journal-*.md merge=union`，且注释引用未公开的 `.trellis/spec/cli/backend/directory-structure.md` |
| `skills-lock.json` | 二开新增（A，83 行） | 个人 agent 环境的第三方 skills 锁文件（`emilkowalski/skills` 等哈希），与 Trellis 集成功能无关 |
| `.agents/`、`.rlm/`、`.claude/` | **未被跟踪**（已在 `.gitignore`） | 防误加：方案 A 若用 `git add -A` 会连带提交 |
| `AGENTS.md` 的 `<!-- TRELLIS:START -->`…`<!-- TRELLIS:END -->` 块 | 二开新增块 | 该块声明"本项目由 Trellis 管理"并引用 `.trellis/{workflow,spec,workspace,tasks}` 与 `.agents/skills/` —— 全部不公开，**在 fork 里会同时造成悬空引用与误导** |

#### 需回退的二开改动（排除 `.trellis/` 后不再成立）

- `tools/repository-asset-policy.json`：二开把 `thresholds.trackedTreeHardBytes` 由 `59768832` 提到 `60817408`（57→58 MiB），原因是 `.trellis/` 的 291 个跟踪文件撑大了 tracked tree。排除后体积回落，**应还原为上游原值以保持上游契约**（`src/`、`test/`、`docs/`、`AGENTS.md` 的二开内容保留）
- `AGENTS.md`：保留二开的 Trellis **功能**说明（文档索引行、Trellis Settings 面板约束段 —— 均是功能权威描述），仅删除上面那个 Trellis 工作流块

#### `.gitignore` 处理

二开对 `.gitignore` 的改动只有两条：`!docs/project/trellis-settings-panel.md`（**保留**，这是二开功能的文档）、`.rlm/`（**保留**，防误加）。另外二开把 `.rlm/` 插入到了 `tools/chroma_key.py` 与 `tools/fix_gray_bleed.py` 之间，把两条相邻的 tools 规则拆开了 —— 顺手修正位置即可。

### 隐私痕迹与历史约束（决策的必然后果）

- `.trellis/` 下 **18 个文件**含本机身份/路径：`/Users/Dae`、`Dae@Mac-Studio.local`
  （`.trellis/workspace/clawd/journal-1.md`、`workspace/index.md`、`spec/*` 3 个、`workflow.md`、`tasks/archive/**/task.json` 多个）
- ⚠️ **关键约束**：`.trellis/` / `.pi/` 的内容**已存在于 184 个提交的历史中**。只要推送这段历史，其内容即可通过 `git log` 访问 —— **因此「排除 .trellis」不能只靠删除文件，必须在推送前处理历史**
- 提交分类实测（184 个）：**纯元数据提交 110 个**（只改 `.trellis/`、`.pi/`、`.agents/`）、混合提交 37 个（代码 + 元数据）、纯代码提交 37 个
  → 以 path-filter 重写历史后：110 个空提交消失，**约保留 74 个代码提交**
- 悬空引用风险：`src/` 6 文件、`test/` 8 文件、`docs/project/trellis-settings-panel.md` 合计 246 处提及 `.trellis/{spec,tasks,...}`。其中绝大多数是**功能实现路径构造**（读写用户项目的 `.trellis` 目录，公开后完全正常），真正需要处理的是**注释/文档中指向未公开 spec 的引用**

## Requirements

- **R1** fork 官方仓库到用户 GitHub 账号（`52mzd`），保留上游完整历史
- **R2** 以上游最新版为基线整合二开内容（dry-run 已证零文本冲突）
- **R3** 落实开源范围：公开功能本体，按上面「排除清单」逐路径剔除（含方案 A 下防误加未跟踪目录）
- **R4** 历史从上游最新拉新分支、以单个干净提交表达二开（方案 A），确保被排除路径的内容不可通过 git 历史访问
- **R5** 处理悬空引用：`AGENTS.md` 的 Trellis 工作流块删除；`docs/project/trellis-settings-panel.md` 保持公开；其余指向未公开 `.trellis/spec` 的注释引用给出明确处理
- **R6** 回退 `tools/repository-asset-policy.json` 的 `trackedTreeHardBytes` 到上游原值
- **R7** 推送到 fork 并公开
- **R8** 整合后通过测试基线，且不破坏上游既有契约与资产审计

## Acceptance Criteria

- **A1** 用户 GitHub 上存在 `clawd-on-desk` 的公开 fork，目标分支为「上游最新 + 二开内容」
- **A2** 上游 84 个提交全部包含在内（分叉点之后无遗漏）
- **A3** 二开功能在整合后可运行：`npm test` 失败集合与既定基线一致（macOS 存量 26 条环境相关失败），无新增失败
- **A4** 仓库内**及其全部 git 历史中**不含 `.trellis/`、`.pi/`、`.agents/` 路径，且不含本机身份/路径/凭据痕迹（扫描零命中，含 `git log -p` 层面验证）
- **A5** LICENSE 仍为 AGPL-3.0，上游版权声明保留
- **A6** 二开功能在上游最新版上经真机验证可启动（Electron `npm start` 无错）
- **A7** 悬空引用已有明确处理结论并落实

## Out of Scope

- 不向上游提 PR / 不回贡（本次目标是 fork 开源，非 upstream contribution）
- 不重写或重构二开功能实现
- 不做二开功能的进一步开发（本任务只做整合与发布）
- 不公开工作流框架（用户明确决策）

## Open Questions

**（已全部解决，无阻塞项）**

| # | 问题 | 结论 |
|---|---|---|
| Q1 | fork 的 README 是否声明二开 | ✅ **方案 A**：README 顶部加 fork 声明段，不重写正文 |
| Q2 | 历史处理方式 | ✅ **方案 A**：从上游最新拉分支 + 单个导出提交 |
| Q3 | fork 目标分支名 | ✅ `main`（默认值，用户无异议） |

### 由用户意图推定、已采纳的决策

- `.gitattributes`、`skills-lock.json`、`.agents/`、`.rlm/` → 排除（用户已明确「类似 .pi、.rlm 这种目录都要排除」）
- `AGENTS.md` 的 Trellis 工作流块 → 删除（属工作流框架，用户已排除）
- `tools/repository-asset-policy.json` 阈值 → 还原上游值（排除 `.trellis/` 的必然结果）
- `docs/project/trellis-settings-panel.md` → 公开（二开功能的权威文档，且 `.gitignore` 已白名单）
