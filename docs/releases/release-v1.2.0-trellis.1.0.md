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

## 官方 v1.2.0 之后合入 main 的修复(24 个官方提交,随本次同步带入)

- **尺寸滑杆系列修复**(#1091/#1092/#1093/#1094):自由漫游不再覆盖滑杆设置的尺寸;滑杆显示桌宠当前实际尺寸;关闭 keep-size 时保持当前尺寸;Cloudling 主题尺寸与其他内置主题对齐;设置页离开时结束尺寸预览
- **官方主题下载**:下载进度期间的主题列表重渲染不再打断 hover(#1088)及后续跟进修复(#1098)
- **Linux AppImage**(#1058):关机时序不再误删 AppImage 文件;guard 兼容当前 coreutils
- **Codex**:生命周期清理期间不再向请求误发 deny 响应(#1068)
- **CI**:Wayland smoke 的 socket 路径压回 Linux 上限内;测试套件失败时保留 TAP 报告(#1099)
- **文档**:Whale-chan 标注为 1.0.1 起的动画 WebP 主题

## 本 fork 新增内容(自 v1.1.0-trellis.1.3)

- **多 CLI 安装检测与清理向导** —— 全量扫描本机各 CLI 的安装位置，标出当前生效项；可清理判定按版本新旧给出结论，并提供可复制的清理命令。列表经多轮迭代定稿为「序号+标签+版本号+路径」行内流排版、最新置顶，末条底距与命令块圆角细节修正；复制按钮文案改为「复制清理代码」与命令语义对齐。
- **CLI 发现修复三连** —— GUI 启动环境下的 PATH 扩充、CLI 实际可执行路径直接亮出、扫描目录与 Dashboard 同步，消除后台第一击发现不到 CLI 的盲区。
- **已注册项目 32 截断修复** —— Dashboard 任务/归档列表的已知 root 窗口本地写死 32，小于注册面上限 64，第 33+ 个注册项目（如 SpecRune）按注册序被静默截出列表。窗口上限现与注册面同源（`TRELLIS_ROOTS_MAX`），并补满额注册回归用例。

## 版本说明

这是私有 fork 构建(`1.2.0-trellis.1.0`)。semver pre-release 后缀使其在更新器比较中排在官方 `v1.2.0` **之前**;不发布到官方 release 渠道或 winget。
