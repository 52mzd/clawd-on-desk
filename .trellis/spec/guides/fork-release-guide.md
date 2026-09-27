# Fork Release Guide

> **Purpose**: 把 fork 的二开版本发布成可下载的 GitHub Release。
> 上游的「发布契约」测试与 GitHub 的 release 行为有几处会静默绊住 fork。
>
> 来源：2026-09-26 `09-26-fork-release` 首次发版复盘（连踩 6 个坑）；
> 2026-09-27 `v1.1.0-trellis.1.1` 二次发版复盘（导出/资产/notes 三类新坑，见坑 7–9 与「单提交导出模式」）。

---

## 0. 先理解上游的「发布契约」

`npm test` 里有一组测试把**发布**当契约校验，它们默认「版本号 = 上游当前版本」：

| 测试 | 断言 |
|---|---|
| `release-version-contract.test.js` | `package.json` version 硬编码等于上游版本；`docs/project/release-process.md` 必须存在 `### v<version> Draft Smoke Checklist` 章节 |
| `readme-contributors.test.js` | **6 个 README** 的贡献者列表与 `src/settings-i18n.js` 的 `CONTRIBUTORS` **排序后完全相等**；表格版另要求「前 N-1 行满 7 格、末行 1-7 格」且 4 个表格版形状一致 |
| `verify-release-contributors.js`（由 `verify:release` 跑） | `git log <previousTag>..HEAD` 中每个 author 都要能映射到 GitHub handle，且该 handle 出现在 `CONTRIBUTORS` 里 |

**结论（2026-09-27 更新）**：契约测试已适配 fork 版本号，两种模式都可用：

- **模式 A（新默认）——版本号长期保留 trellis 后缀**：`release-version-contract.test.js` 已改为动态读 `package.json` 版本 + pre-release（含 `-`）自动跳过 smoke checklist 断言。fork 版本号不再连锁触发契约失败，发布后无需 revert。迭代规则：`<上游base>-trellis.<线号>.<包号>`，线内出包 +1，同步上游新 tag 后 base 升位、线号重开。
- **模式 B（旧方案）——版本号与上游一致，只用 release tag 区分**：仍可行，但坑 4 的 `previousTag` 回退问题需要按 §0 的方式处理。

⚠️ 模式 A 下 fork 版本号在 semver 里小于同号上游正式版（`1.1.0-trellis.1.1 < 1.1.0`）。fork 不走官方 updater 通道，序列内单调即可；但不要把 fork 版本号和上游 updater 元数据混用。

### 实操建议：先一次跑完全部契约，不要靠 CI 逐个发现

2026-09-26 首次发版时连跑了 **6 轮 CI**（每轮 20+ 分钟）才收敛，每一轮只暴露一个契约失败。
根因是“改版本号 → 推 → 等 CI 报错 → 修一个 → 再推”的串行循环。

**正确做法**：动手前先在**完整历史**的 clone 上本地跑一次

```bash
node --test test/release-version-contract.test.js \
            test/release-contributor-contract.test.js \
            test/readme-contributors.test.js
npm run verify:release
```

一次性看到全部契约要求，而不是让 CI 一个接一个地告诉你。

---

## 坑 7：单提交导出会静默冲掉 fork 线独有的改动

导出的本质是 `git checkout main -- . ':!.trellis' ':!.pi' …` 把本地 main 的树覆盖到 fork 基底上。
**任何只存在于 fork main、不存在于本地 main 的改动（比如直接改在 fork 上的 hotfix、发布杂务里的注册行）都会被覆盖丢失**。

2026-09-27 实录：导出冲掉了 contributors 注册行（映射表 + `CONTRIBUTORS`），被 CI `verify-release-contributors` 拦下。
恢复时文踩了第二个坑：按单个历史提交（`8ffae44d`）的 diff 重放，漏了后续提交在同一行追加的 `hanzhe-one`。

**恢复必须用文件级 diff，不是提交级重放**：

```bash
git diff <fork-base> <export> -- scripts/verify-release-contributors.js src/settings-i18n.js
# 把丢失的行按文件当前状态加回，而不是找某个历史提交的 patch
```

**原则（强约束）**：fork 线上不做任何直接改动，一切变更先进本地 main 再导出。
只有 contributors 有 CI 校验兑底；其他文件被覆盖即静默丢失，无任何报警。
导出后必须本地预检：

```bash
npm run verify:release && node --test test/release-version-contract.test.js
# 私有内容断言（导出树上必须为空）：
git ls-tree <export> .trellis .pi
```

## 坑 8：release notes 的变更清单凭记忆写会漏

2026-09-27 实录：notes 第一版只写了当前会话记忆里的 HUD 修复，漏了 5 个 trellis fork 变更（`-u` 身份、`--tag` 频道升级、并发防抖、重建守卫、后续修复），被用户指出后修正。

**规范**：fork 变更清单必须从 git 历史机械枚举，禁止凭记忆：

```bash
# 上次导出时间之后的非私有功能提交
 git log --since="<上次导出时间>" main --no-merges --format="%h %ad %s" \
  --date=format:"%m-%d %H:%M" -- src hooks test agents themes scripts assets extensions \
  | grep -v "chore: record journal\|docs(spec)"
```

注意甄别两类：fork 自己的变更（进 notes「Fork 新增与修复」）与同步进来的上游提交（进 notes「同步上游」）。
上游提交可通过 origin/main 的 tag 间日志交叉确认。

## 坑 9：本地上传 ~1GB 资产受限于上行带宽，连瑰超时

2026-09-27 实录：`gh release create/upload` 一次性传 12 个安装包（~1GB），本地上行仅 ~150KB/s，600s × 2 均超时中断，还留下两个残缺 draft。

**解法（已落地为常驻基础设施）**：`attach-release-artifacts.yml` 维护 workflow，在 GitHub runner 内网把 Build & Release run 的 installer artifacts 直接转传到 release（2 分钟完成）：

```bash
gh workflow run attach-release-artifacts.yml -R <owner>/<repo> --ref main \
  -f tag=<tag> -f run_id=<build_run_id>
gh run watch <attach_run_id> -R <owner>/<repo>
```

本地下载/上传只留给小文件（yml/blockmap）或无 runner 可用的场景。
中断留下的残缺 draft 要先删干净再重建（同名 tag 可挂多个 draft）。

## 单提交导出模式（fork 的隐私边界）

本地 main 与 fork main 是**两条平行线**，同步靠导出而不是 merge/push：

- **本地 main**：真实开发线，跟踪 `.trellis/`（workspace/spec/journal）与 `.pi/`（agent 配置）等私有内容
- **fork main**：公开导出线，一棵干净的单提交快照树

**绝不能直接 `git push fork main`** —— 会把 340+ 个私有文件暴露到公开仓库。

导出流程（2026-09-27 验证过的完整序列）：

```bash
git fetch fork main
git checkout -b tmp-export <fork-main>
# 1. 覆盖非私有路径（排除私有目录 + fork 特有文件）
git checkout main -- . ':!.trellis' ':!.pi' ':!.gitignore' ':!README*.md'
# 2. .gitignore：fork 版 ignore .trellis/.pi（导出树必须用它）；追加 release note 白名单行
# 3. README：五个非 ko-KR 直接用 fork 版（含 fork 声明块/贡献者表格）；
#    README.ko-KR.md 若上游动过，用 fork 版 + git show <上游提交> -- README.ko-KR.md | git apply -3 三方融合
# 4. 隐私断言 + 预检（见坑 7）
git commit -m "feat(trellis): re-export on upstream <sha> as <tag> …"
git push fork tmp-export:main
git tag <tag> && git push fork <tag>
```

导出提交的 author 必须是 noreply 身份（坑 2）；本地仓库已配 `git config user.email <id>@users.noreply.github.com`。

## 坑 1：`docs/**` 是逐文件白名单，新增 release note 会被静默忽略

`.gitignore` 用 `docs/**` 忽略一切，再逐文件 `!docs/releases/release-vX.Y.Z.md` 放行。

**症状**：`npm run verify:release` 报 `missing release note: docs/releases/release-vX.Y.Z.md`，而文件**明明就在工作区** —— 因为它从没进过 git。

**判据**：`git status --short` 里**看不到**刚创建的那个 release note = 被忽略了。

**修复**：在 `.gitignore` 白名单区补一行 `!docs/releases/release-v<version>.md`。

---

## 坑 2：commit author 会把本机 git 身份写进公开历史

仓库默认 identity 常是 `you@Your-Mac.local`。fork 是**公开**的，这个 email 会永久留在 `git log`。

**预防**：提交时显式指定

```bash
git -c user.name="<name>" -c user.email="<id>@users.noreply.github.com" commit …
```

**已经写进去了**：用 `filter-branch` 只重写自己的提交范围，再 force push

```bash
git fetch --depth=10 origin     # shallow clone 必须先加深，否则 <sha>^ 无法解析
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --env-filter '
  if [ "$GIT_AUTHOR_EMAIL" = "you@Your-Mac.local" ]; then
    export GIT_AUTHOR_EMAIL="<id>@users.noreply.github.com"; GIT_AUTHOR_NAME="<name>"
  fi
  if [ "$GIT_COMMITTER_EMAIL" = "you@Your-Mac.local" ]; then
    export GIT_COMMITTER_EMAIL="<id>@users.noreply.github.com"; GIT_COMMITTER_NAME="<name>"
  fi
' <sha>^..HEAD
git for-each-ref --format='%(refname)' refs/original/ | xargs -n1 git update-ref -d
```

**校验**（注意 `refs/remotes/origin/*` 在 force push 前仍指向旧提交，会误报残留）：

```bash
git log refs/heads/main --format='%ae' | sort -u | grep -i '<local-domain>'
```

---

## 坑 3：贡献者契约是「三处一致」，改一处必须改三处

引入新贡献者（例如你自己）时，**三处必须同时改**：

1. `scripts/verify-release-contributors.js` 的 email → handle 映射表
2. `src/settings-i18n.js` 的 `CONTRIBUTORS` 数组（**唯一数据源**）
3. **全部 6 个 README** 的贡献者列表（`README.md` / `zh-CN` / `zh-TW` / `ja-JP` / `ko-KR` / `es`）

**只改 1、2 不改 3** 的后果：`readme-contributors.test.js` 在**三个平台**的 `npm test` 里同时失败，而 CI 日志要等很久才可读 —— 极容易误判成"随机失败"。

**表格形状约束**（4 个表格版 README）：前 N-1 行必须满 7 个 `<td>`，末行 1-7 个，且四个文件**形状完全一致**。把 2 个贡献者加在末行（4→6 格）是安全操作。

**中文版是纯 `<a>` 列表**（无表格），只需在末尾追加同款 `<a href>` 行。

---

## 坑 4：预发布版本号会让 `previousTag` 回退，把上游未发布的提交也纳入检查

`previousReleaseTag()` 用 **semver** 找「比当前版本小的最新 tag」。而 semver 里 **`1.1.0` > `1.1.0-trellis.1.0`**（预发布 < 同号正式）。

于是 `1.1.0-trellis.1.0` 让 `v1.1.0` **被过滤掉**，`previousTag` 回退到 `v1.0.0` → 检查范围从 `v1.1.0..HEAD` 扩成 `v1.0.0..HEAD` → **上游在 v1.1.0 tag 之后合入但尚未发版的提交**也被要求登记。

**症状**：`Release contributor verification failed: release contributor @<someone> is missing…`，而这个人你根本不认识（他是上游未发布提交的作者）。

**两种解法**：
- **保持版本号与上游一致**（推荐，见 §0）：`previousTag` 正常落在 `v1.1.0`，范围只剩你自己的提交
- 或把上游未发布的贡献者也登记进三处（治标，语义上超前）

**⚠️ shallow clone 上的验证结果不可信**：`git log <tag>..HEAD` 在 `--depth 1` 下会被截断，让本该失败的检查"通过"。下结论前先 `git fetch --unshallow`（或至少 `--depth=10`）。

---

## 坑 5：GUI 启动的 App 拿不到 shell 的 PATH（打包版专属）

**症状**：打包版报「PATH 中未找到 trellis CLI」，而 `npm start` 完全正常。

**原因**：macOS 从 Finder 启动的 App 继承 **launchd 的默认 PATH**（`/usr/bin:/bin:/usr/sbin:/sbin`），**不含** `/usr/local/bin`、`/opt/homebrew/bin`、`~/.local/bin` —— 而 CLI 通常就装在那里。

**既有解法**：`src/focus.js` 对 orca CLI 就是这么处理的（显式追加候选目录）。

**本次修复形态**：
- `src/trellis-cli.js` 新增并导出 `augmentedCliPath(basePath, { platform, home })`（追加 `/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`，去重；Windows 原样返回）
- `src/main.js` 的调用点传入 `env: { PATH: augmentedCliPath(process.env.PATH) }`

**判据**：`trellis-cli.js` 注释写着「It does not repair a GUI app's PATH — callers that need extra lookup paths must pass them in `env` themselves」。
**凡是 `execFile` spawn 外部 CLI 的地方，都要检查调用点有没有传 PATH 覆盖。**

### 系统性扫查结论（2026-09-26 实测）

对全仓 spawn 点做了一遍排查，**同类问题的既有解法是「显式候选路径」**，各模块的采用情况：

| 模块 | 候选路径 | 状态 |
|---|---|---|
| `src/focus.js` | 6 处（`resolveTmuxBin`、`orcaCliCandidates`、`buildCmuxBinPath`…） | ✅ 早已处理 |
| `src/agent-installation-detector.js` | 3 处 | ✅ 早已处理 |
| `src/codex-queue-delivery.js` | 1 处（`resolveCodexQueueExecutableCandidates`） | ✅ 早已处理 |
| `src/trellis-cli.js` | 2 处（本次新增） | ⚠️ **曾是唯一遗漏** |

**结论**：trellis 是唯一遗漏点，已修。新增 spawn 外部 CLI 的模块时，**先 grep 这四个模块的写法，别重新发明**。

**另一类天然安全**：调用系统内置绝对路径（`/usr/bin/open`、`ps`、`osascript`、`mdfind`、`sqlite3`）——
launchd 默认 PATH 包含 `/usr/bin:/bin`，不需要候选路径。

### 预防：打包版冒烟

开发模式（`npm start`）从终端启动、继承 shell PATH，**永远测不出这类问题**。
凡是改动“启动外部 CLI”的代码，发布前必须**从 Finder 双击打包后的 App** 验证一次，
或者至少确认调用点传了 PATH 覆盖。

---

## 坑 6：pre-release 不计入 `latest`，`/releases` 页面只显示「Create a new release」

**症状**：release 明明创建成功（`gh release list` 能看到、assets 齐全），但打开 `/releases` 页面顶部只有「Create a new release」引导。

**原因**：该页面顶部是 **Latest release** 区，而 **pre-release 不算 latest**。
证据：`gh api repos/<owner>/<repo>/releases/latest` 返回 **404**。

**修复**：`gh release edit <tag> --prerelease=false` —— 之后 `latest` 能解析、页面顶部正常显示。

**trade-off**：未签名的包标成正式版，必须在 release notes 里把「未签名 + 逐平台绕过方法」写清楚。

---

## 构建与发布的操作要点

### 触发构建

上游 `build.yml` 有两条路径，**fork 必须用手动那条**：

```bash
# ❌ 推 v* tag → macOS job fail closed（fork 没有那 5 个签名 secrets）
# ✅ 手动触发 → mode=adhoc，macOS 可构建
gh workflow run build.yml -R <owner>/<repo> -f artifact_validation_only=true
```

`artifact_validation_only=true` 跳过 `npm test`、只跑 package validation tests。
**但 `validate-release` job 里的 `verify:release` 不受该开关影响、总会跑** —— 所以坑 1–4 必须真的解决。

### 下载 artifacts

```bash
gh run download <runId> -R <owner>/<repo> -n <artifact-name> -D <clean-dir>
```

- **不带 `-n` 时遇到一个坏 artifact 会整体中止** → 逐个 `-n` 下载
- 失败时换**干净目录**重试（`file exists` 冲突会伪装成别的错误）
- 同一 run 被 retry 后 `artifacts` 列表会**变化**（旧 attempt 条目消失）→ 构建完成后尽快下载

### 创建 / 更新 release

**优先用 runner 内网转传（坑 9，已落地）**：

```bash
# 创建空 draft（不传资产，秒完成）
gh release create <tag> --draft --title "…" --notes-file <file>
# runner 内网把 build artifacts 挂上去
gh workflow run attach-release-artifacts.yml -R <owner>/<repo> --ref main \
  -f tag=<tag> -f run_id=<build_run_id>
# 核对资产齐全后发布
gh release edit <tag> --draft=false
```

仅小文件或无 runner 时才本地上传：

```bash
gh release upload <tag> -R <owner>/<repo> --clobber <assets…>
# 校验「release 上的包 == 本地新构建」
gh release view <tag> --json assets --jq '.assets[] | select(.name=="<file>") | .digest'
shasum -a 256 <file>
```

### 本地跑测试前先去污染环境变量

宿主工具（如 Orca）注入的 `CODEX_HOME` 会让安装检测类测试假失败
（2026-09-27 实录：5 个测试报 `false !== true`，根因是读到了 orca/codex-runtime-home）：

```bash
env -u CODEX_HOME npm test
```

---

## 快速检查清单

发布前：

- [ ] 版本号策略已选：模式 A（长期保留 trellis 后缀）或模式 B（与上游一致）；模式 A 迭代规则 `<上游base>-trellis.<线>.<包>`
- [ ] 新 release note 已加入 `.gitignore` 白名单，且 `git status` 能看到它
- [ ] commit author 是 noreply 身份（不是 `*@*.local`）
- [ ] 新贡献者已同时登记到：映射表 + `CONTRIBUTORS` + **6 个 README**
- [ ] 导出树隐私断言：`git ls-tree <export> .trellis .pi` 为空
- [ ] 导出后本地预检：`npm run verify:release` + 契约测试（完整历史 clone）
- [ ] notes 的 fork 变更清单来自 `git log --since=<上次导出>` 机械枚举（坑 8），不是记忆
- [ ] 本地跑过 `env -u CODEX_HOME npm test`
- [ ] 所有 spawn 外部 CLI 的调用点都传了 PATH 覆盖（坑 5）

发布后：

- [ ] `gh api .../releases/latest` 能解析到目标 tag（否则页面显示「Create a new release」）
- [ ] release assets 数量与安装包清单一致（三平台全量 = 13 个）
- [ ] 资产文件名带完整 fork 版本号（如 `1.1.0-trellis.1.1`）
- [ ] 手动触发过构建时 workflow 已恢复 `active`
