# Clawd on Desk v1.1.0-trellis.1.2

> **这是 fork 的版本。** 基于上游 [`rullerzhou-afk/clawd-on-desk`](https://github.com/rullerzhou-afk/clawd-on-desk)
> 的 `v1.1.0`,本轮纯本地 Trellis 集成增强,无上游同步。
> 仓库地址:https://github.com/52mzd/clawd-on-desk-trellis

## ⚠️ 本版本未签名、未公证

构建过程没有代码签名证书,因此安装时操作系统会给出安全警告。这是**预期行为**,不是文件损坏:

| 平台 | 现象 | 解决办法 |
|---|---|---|
| **macOS** | 「无法验证开发者,无法打开」 | 右键点 App → **打开** → 再次确认;或终端执行 `xattr -cr /Applications/Clawd*.app` |
| **Windows** | SmartScreen「Windows 已保护你的电脑」 | 点「更多信息」→「仍要运行」 |
| **Linux** | 无此限制 | — |

## 本 fork 新增内容(自 v1.1.0-trellis.1.1)

- **HUD 多项目任务面板** —— Session HUD 的 Trellis 面板从单项目扩展为覆盖全部已知项目根(至多 5 个),每项目一节(活跃任务全量 + 最新 3 条归档),切换项目不再丢失另一项目的视野;行点击跳转经所属节的 cwd 解析,跳转后 Dashboard 项目 chip 自动切到归属根。
- **过程级感知恢复(尾窗阶梯)** —— HUD 详情第三行重新显示绑定 claude-code 会话的最新 trellis 指令与工作流步骤;以 workflow-state hook 注入块为唯一可靠信号源,尾窗按 512KB → 8MB 阶梯放宽,大输出轮次不再丢信号。
- **项目列表按最近使用排序** —— HUD 面板、Dashboard 任务分组与 Settings 扫描三处统一「最近动过的项目排最前」;排序键取 `max(pointer last_seen_at, sessions 目录 mtime)`,因为 trellis CLI 在会话结束会清空 `.runtime/sessions`,目录 mtime 是幸存痕迹。
- 配套渲染层行为测试补强(FakeElement `childElementCount` stub、ws-only 第三行覆盖)。

## 版本说明

这是私有 fork 构建(`1.1.0-trellis.1.2`)。semver pre-release 后缀使其在更新器比较中排在官方 `1.1.0` **之前**;不发布到官方 release 渠道或 winget。
