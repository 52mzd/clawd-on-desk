# Clawd on Desk v1.2.0-trellis.1.0

> **这是 fork 的版本。** 基于上游 [`rullerzhou-afk/clawd-on-desk`](https://github.com/rullerzhou-afk/clawd-on-desk)
> 的 `v1.2.0`（48 个官方提交整体合入），叠加本地 Trellis 集成增强。
> 仓库地址:https://github.com/52mzd/clawd-on-desk-trellis

## ⚠️ 本版本未签名、未公证

构建过程没有代码签名证书,因此安装时操作系统会给出安全警告。这是**预期行为**,不是文件损坏:

| 平台 | 现象 | 解决办法 |
|---|---|---|
| **macOS** | 「无法验证开发者,无法打开」 | 右键点 App → **打开** → 再次确认;或终端执行 `xattr -cr /Applications/Clawd*.app` |
| **Windows** | SmartScreen「Windows 已保护你的电脑」 | 点「更多信息」→「仍要运行」 |
| **Linux** | 无此限制 | — |

## 官方 v1.2.0 带来的内容(相对 v1.1.0)

- **Whale-chan 官方可选主题**（鲸鱼娘）与主题 mini peek hold / sleep peek、可选待机视觉
- **opencode v2 插件 API 承接**（OpenCode 2.x，issue #1039）：权限阻塞 HTTP 响应、通配监听地址回环回退、复合 shell 命令扫描、会话停止时取消待审批、Windows 非 ASCII 路径修复
- **Codex 修复**：远程回放不再虚构/复活 Desktop 会话；记忆整理（phase 2）内部线程不再进入会话列表（#1074）
- **会话历史写入端状态机精化**（#1060 follow-up）：SubagentStop 只结算 juggling 行、settle 不动 lastEventAt、并发写中止删除改为全量比对
- **Slack 通知**：排队通知保留，权限提醒独立通道（#1066）
- **设置**：缺失 Claude hook 脚本的提示指向重装 Clawd（#1064）；Agents 徽标反映真实 hook 健康度（#1059）
- **DeepSeek Harness 0.1.5-rc.3** 契约表更新与投影修复
- **trailing SubagentStop 修复三连**：不再取消待定完成、不再重开空闲租约、已结束会话保持结束（#1061/#1063）
- **官方 PR #1071**（acceptFirstMouse）正式进入官方基线

## 本 fork 新增内容(自 v1.1.0-trellis.1.3)

- **已注册项目 32 截断修复** —— Dashboard 任务/归档列表的已知 root 窗口本地写死 32，小于注册面上限 64，第 33+ 个注册项目（如 SpecRune）按注册序被静默截出列表。窗口上限现与注册面同源（`TRELLIS_ROOTS_MAX`），并补满额注册回归用例。

## 版本说明

这是私有 fork 构建(`1.2.0-trellis.1.0`)。semver pre-release 后缀使其在更新器比较中排在官方 `v1.2.0` **之前**;不发布到官方 release 渠道或 winget。
