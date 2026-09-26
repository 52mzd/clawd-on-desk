# Implement Plan：Trellis 安装向导支持 `-u` 开发者身份

**贯穿全程的不变量**：`-u` 缺省时行为与现状**完全一致**（回退到目录名）；加平台场景零回归。

## 阶段 1 · CLI 层：统一回退链

- [x] 1.1 `src/trellis-cli.js` 新增 `resolveUserName(projectPath, candidate)`
      —— 顺序：`normalize(candidate)` → `normalize(basename(projectPath))` → `"clawd"`；
      `normalize` 规则：`trim`、空串丢弃、截断 64、拒绝含 `/` `\` `..`
- [x] 1.2 `addPlatforms(projectPath, platformIds, options = {})` 改用它（`options.userName` 可选）
- [x] 1.3 导出 `resolveUserName`（供 ipc / runtime 复用，保持回退语义唯一）
- [x] 1.4 `test/trellis-cli.test.js` 加用例：
      传入值优先 / 空串回退目录名 / 目录名也为空回退 `"clawd"` / 含 `/` 或 `..` 被拒 / 截断 64

**验证**：`node --test test/trellis-cli.test.js`

## 阶段 2 · IPC 层：payload 扩展 + 默认值通道

- [x] 2.1 `src/trellis-ipc.js`：`settings:trellis-preview` 读取可选 `payload.userName` 并透传
- [x] 2.2 `src/trellis-ipc.js`：`settings:trellis-add-platform` 读取可选 `payload.userName` 并透传
- [x] 2.3 `src/trellis-runtime.js`：`previewAddPlatforms` / `addPlatforms` 接受并透传 `userName`，
      构造 `command.args` 时用 `resolveUserName`（替换两处 `path.basename(...) || "clawd"`）
- [x] 2.4 新增通道 `settings:trellis-user-suggestion`：
      - 主进程 spawn `git config user.name`（3s 超时；`git` 在 `/usr/bin/git`，**无需 PATH 增强**）
      - 成功 → `{ name: <trimmed> }`；失败/超时/空 → `{ name: "" }`
      - **进程内缓存**（同 Settings 窗口生命周期只读一次）
      - 走与其它通道相同的 **Settings 窗口信任判定**（`isTrustedEvent`）
- [x] 2.5 `src/preload-settings.js` 暴露 `trellisUserSuggestion()`
- [x] 2.6 `test/trellis-ipc.test.js` 加用例：payload 带/不带 `userName` 的命令形态；
      新通道的信任门禁（不可信 event 被拒）

**验证**：`node --test test/trellis-ipc.test.js test/trellis-runtime.test.js`

## 阶段 3 · UI 层：向导输入框

- [x] 3.1 `src/settings-tab-trellis-wizard.js`：`state` 增加 `userName`
- [x] 3.2 `renderAddSelect` 在 `state.project.installed === false` 时渲染输入框块
      （`<input data-user maxlength="64">` + label + hint；**不用 `insertBefore`**，沿用 `innerHTML` 重建）
- [x] 3.3 渲染后异步调 `bridge.api.trellisUserSuggestion()` 填入默认值（失败静默）
- [x] 3.4 preview handler 读取 `[data-user]` 值 → 存入 `state.userName` → 随
      `api.trellisPreview({ paths, platforms, userName })` 发出
- [x] 3.5 `renderAddPreview` 的 `back` 回填 `state.userName` 到输入框
- [x] 3.6 `runInstall` 随 `api.trellisAddPlatform(path, added, userName)` 发出
- [x] 3.7 `src/settings.css` 加 `.trellis-wizard-field` / `-field-label` / `-input` 样式
      （沿用向导现有视觉 token，不新增设计语言）
- [x] 3.8 `test/settings-tab-trellis-wizard-static.test.js` 加静态守卫：
      输入框仅在 `installed === false` 分支出现；`data-user` 的取值与传参存在

**验证**：`node --test test/settings-tab-trellis-wizard-static.test.js test/settings-tab-trellis.test.js`

## 阶段 4 · i18n（方案 C：整套补 7 语言）

- [x] 4.1 `settings-tab-trellis-wizard.js` 的 `FALLBACK` 补 3 个新 key（英文）
- [x] 4.2 `src/settings-i18n.js` 补 **22 个 key × 7 语言**（19 旧 + 3 新）：
      - `grep -n` 定位各 locale 块 → **整行锚定**插入（`^(\s*)keyName: "…",\s*$`）
      - **禁止**按值子串定位（09-25 事故：会拼进另一键字符串内部）
- [x] 4.3 插完立即 `node --check src/settings-i18n.js`
- [x] 4.4 完整性校验：每个 key `grep -c` 均为 **7**
- [x] 4.5 保留 `FALLBACK` 作为 `bridge.t` 不可用时的最后防线

**验证**：`node --check src/settings-i18n.js` + 22 键 × 7 计数循环

## 阶段 5 · 全量验证与真机

- [x] 5.1 全量 `npm test`，失败集合与存量基线一致（macOS 约 9 条环境相关失败）
- [x] 5.2 真机：对**未 init** 的项目走一遍向导 → 确认 `.trellis/workspace/<输入名>/` 被创建 （层内已验证：真实 `trellis init -u wizard-alice` 创建 `.trellis/workspace/wizard-alice/`；向导 GUI 未走，见报告）
- [x] 5.3 真机：对**已 init** 的项目（如本仓）走一遍向导 → 输入框**不出现**，行为同现状 （层内已验证：向导 vm 行为测试 installed:true 不渲染输入框；GUI 未走）
- [x] 5.4 真机：输入框留空 → 命令仍含非空 `-u`（回退链生效） （层内已验证：空白值经回退链仍产出非空 `-u <目录名>`，真实 init 创建 `workspace/beta-project/`；GUI 未走）
- [x] 5.5 真机：preview → back → 输入值不丢 （层内已验证：向导 vm 行为测试 preview→back 回填 `alice`；GUI 未走）

## 阶段 6 · 契约文档

- [x] 6.1 `guides/trellis-panel-contract.md` 补 7 段式 Scenario：
      「向导的开发者身份（`-u`）契约」—— 含 payload 字段、回退链、`git config` 读取的失败矩阵
- [x] 6.2 若新增 CSS 类，核对「定义 ↔ renderer 引用」双向存在（quality-guidelines 硬线）

## 阶段 7 · 第二轮：独立验证发现的缺陷修复（09-27）

- [x] 7.1 **H1（阻塞）** `normalizeUserName` 改白名单
      `/^[\p{L}\p{N}\p{M}\p{So}_][\p{L}\p{N}\p{M}\p{So}_.\-]*$/u`：
      win32 `shell:true` 下 Node 只拼接 argv、不转义（DEP0190），黑名单（仅拒 `/` `\` `..`）
      不拦 `; & | < > ^ % “ ' \` $ ( )` 与空白 → 修正后上述一律判不可用
- [x] 7.2 **H1b** 目录名（`path.basename`）走同一个 `normalizeUserName`；
      含元字符的目录名回退 `clawd`
- [x] 7.3 **M1** `..` 改路径段级判定：`..` / `../x` / `.hidden` / 含分隔符被拒，
      `my..project` 接受（首字符类已排除 `.`）
- [x] 7.4 **M2** lone surrogate 拒绝（`isWellFormed` + Unicode 白名单双重）；
      UI `maxlength` 64 → 128（UTF-16 上界），`captureUserName` 再做 64 code point 截断
- [x] 7.5 **M3** 注释与 PRD/spec 改实测事实：缺 `-u` 时 0.6.17 `exit=0`、不挂起，
      但静默不建 `.developer` / workspace（结论「必须非空」不变）
- [x] 7.6 **M4** `design.md` / `implement.md` / `prd.md` 的 `previewTargets` → `previewAddPlatforms`
- [x] 7.7 **M5** `captureUserName` 存 trim 后的值；back 回填与预览/执行一致
- [x] 7.8 测试：逐个 shell 元字符拒绝、CJK/日/韩/组合字符/emoji 接受、lone surrogate 拒绝、
      H1b 目录名兜底、**真实 `execFile(..., {shell:true})` 注入回归**（含「payload 活性」反证）、
      UI trim + code point 截断、IPC preview 命令形态无元字符
- [x] 7.9 证据：独立脚本跑 5 种 payload（`;` `&` `|` `$( )` 反引号）
      `unsanitized shell=>file:true` / `addPlatforms shell=>file:false`
- [x] 7.10 定向测试 138 全绿；全量 `npm test` 失败集合与 `/tmp/merge-final.txt` **完全相同**

## 回滚点

| 阶段 | 回滚 |
|---|---|
| 1–2 | 独立 commit，可单独 revert（payload 字段可选，旧行为不变） |
| 3 | UI 层独立 commit；revert 后回到纯目录名 |
| 4 | i18n 独立 commit；revert 后新键回落到英文 `FALLBACK`（功能不受影响） |

## 危险操作清单

- 禁止按值子串插入 i18n key（必须整行锚定）
- 禁止在 vm 沙箱路径使用 `insertBefore` / timer（向导文件头部注释已声明）
- 禁止让 `-u` 为空（0.6.17 实测：缺 `-u` 不会挂起，但 CLI 静默不建 `.developer` / workspace）
- 禁止把 `git config` 读取放进批量项目扫描（每个项目一次 spawn = 无谓开销）
- 禁止在 win32 `shell:true` 路径下只靠黑名单消毒（Node 只拼接 argv，不转义）：
  `-u` 与目录名一律过 `USER_NAME_RE` 白名单

## start 前检查

- [x] `prd.md` 存在（用户已确认范围：只做 `-u` + i18n 方案 C）
- [x] `design.md` 存在（架构、契约、UI、i18n、权衡、回滚）
- [x] `implement.jsonl` / `check.jsonl` 含真实 spec/研究条目（非种子行）
- [ ] 用户已 review 本计划并批准开始实现
