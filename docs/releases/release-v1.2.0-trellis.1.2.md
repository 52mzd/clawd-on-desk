# Clawd on Desk v1.2.0-trellis.1.2

> **这是 fork 的版本。** 基于 [`v1.2.0-trellis.1.1`](https://github.com/52mzd/clawd-on-desk-trellis/releases/tag/v1.2.0-trellis.1.1) 的上游同步批次：完整合入官方 main 至 2026-10-03（`4a6b6955`，含 7 个合并 PR 与一批直接修复）。
> 仓库地址:https://github.com/52mzd/clawd-on-desk-trellis

## ⚠️ 本版本未签名、未公证

构建过程没有代码签名证书,因此安装时操作系统会给出安全警告。这是**预期行为**,不是文件损坏:

| 平台 | 现象 | 解决办法 |
|---|---|---|
| **macOS** | 「无法验证开发者,无法打开」 | 右键点 App → **打开** → 再次确认;或终端执行 `xattr -cr /Applications/Clawd*.app` |
| **Windows** | SmartScreen「Windows 已保护你的电脑」 | 点「更多信息」→「仍要运行」 |
| **Linux** | 无此限制 | — |

## 本版本内容(自 v1.2.0-trellis.1.1)

以同步官方上游为主,共合入 32 个上游提交(2026-10-01 → 2026-10-03):

### 安全

- **CVE-2026-101898 修复**(上游 #1102)。

### 会话历史恢复(上游采纳了本 fork 作者的两个 PR)

- **#1085** 不可恢复的会话历史行折叠到确认列表之后 —— daemon 记录不再把可恢复会话挤出 Dashboard 的 25 行列表;transcript 跨目录查找与 `claude --resume` 行为一致;cwd 已消失的行折叠显示、不再领队。
- **#1086** 恢复列表按首条 prompt 命名并显示短 sessionId —— 无标题记录不再显示不透明的 32 位 id。

### 权限与审批

- CodeBuddy PreToolUse 不再显式回答 allow(上游 #1115)。
- 会话身份校验失败时保留该会话更严格的自动化设置(上游 #1114)。
- `git commit`/`gh pr create` 的 `$(cat <<'EOF')` 正文不再被误判卡人工审批(上游 #1096)。
- Codex 权限窗口关闭时回退原生审批流程(上游 #1101)。
- Dashboard 会话自动化不可用时的文案澄清(上游 #971)。

### Codex

- 识别新版上下文压缩完成事件(上游 #1110)。
- HUD 标题刷新加固:优先活跃 tracker、会话索引变化时刷新(上游 #1111)。
- Codex Desktop 细粒度 `request_permissions` 审批缺口已记录文档(上游 #1105)。

### Claude Code

- `/design` 命令的设计反应动画(上游 #1084,新增 `clawd-designing.svg` / `clawd-heart-eyes.svg`)。
- 宿主 Node 可解析时 env hooks 自动迁移(上游 #1070)。
- hook stdout 在 Windows 进程遍历前先应答,状态 POST 不再丢失(上游 #1104)。

### 其他

- 双语贡献模板(上游 #1037)、WorkBuddy 融审材料(上游 #1015)、测试加固(#1112/#1117/#1118)。
- 主题资产预算上限提升至 64 MiB(上游为容纳新素材)。
- 合并时保留了 fork 本地防御:恢复目标为文件系统根目录(cwd=`/`)的 daemon 记录拒绝 relaunch。

## 升级说明

- 从 v1.2.0-trellis.1.1 升级:直接安装同架构安装包即可,无设置迁移。
- Windows 用户请按 CPU 架构选择安装包:x64(Intel/AMD)或 arm64(Surface Pro X 等 ARM 设备)。

## 版本说明

这是私有 fork 构建(`1.2.0-trellis.1.2`)。semver pre-release 后缀使其在更新器比较中排在官方 `v1.2.0` **之前**;不发布到官方 release 渠道或 winget。
