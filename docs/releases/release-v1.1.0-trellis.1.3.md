# Clawd on Desk v1.1.0-trellis.1.3

> **这是 fork 的版本。** 基于上游 [`rullerzhou-afk/clawd-on-desk`](https://github.com/rullerzhou-afk/clawd-on-desk)
> 的 `v1.1.0`,本轮为本地 Trellis 集成增强,含官方已合并 PR #1071 的回流。
> 仓库地址:https://github.com/52mzd/clawd-on-desk-trellis

## ⚠️ 本版本未签名、未公证

构建过程没有代码签名证书,因此安装时操作系统会给出安全警告。这是**预期行为**,不是文件损坏:

| 平台 | 现象 | 解决办法 |
|---|---|---|
| **macOS** | 「无法验证开发者,无法打开」 | 右键点 App → **打开** → 再次确认;或终端执行 `xattr -cr /Applications/Clawd*.app` |
| **Windows** | SmartScreen「Windows 已保护你的电脑」 | 点「更多信息」→「仍要运行」 |
| **Linux** | 无此限制 | — |

## 本 fork 新增内容(自 v1.1.0-trellis.1.2)

- **HUD Trellis 面板聚焦进行中任务** —— 面板定位回归「现在进行时」:归档历史只保留在锚定项目(最新 3 条),且项目整节随活跃任务出现/消失;非锚定项目只收活跃任务。项目根全量注册时,归档历史不再把进行中任务压进面板 320px 内滚线以下。
- **面板头部一行式会话清单** —— 顶部从 owner 单任务三行改为所有带 trellis 任务的会话各一行(owner 首位):阶段色五角星 + 任务名 + 右侧正在执行的 trellis skill/指令(command 优先、workflow Next-Action 次之、步数兜底),不再显示「执行/规划」阶段词;原 owner 三行详情(任务/阶段提示/运行指令)移入行 hover tooltip,信息不丢。
- **归档完成时间到时分 + 面板新鲜度** —— Dashboard 归档列表与任务详情卡的完成时间精确到「月-日 时:分」(completedAtRealMs 透传);HUD 面板 30 秒轮询刷新磁盘状态,行点击跳转先刷新再定位任务卡。
- **官方 PR #1071 回流** —— 设置/Dashboard 窗口 acceptFirstMouse(后台第一击直达页面,不再需要双击)。该 PR 已由官方合并,随本轮导出回流到 fork。

## 版本说明

这是私有 fork 构建(`1.1.0-trellis.1.3`)。semver pre-release 后缀使其在更新器比较中排在官方 `1.1.0` **之前**;不发布到官方 release 渠道或 winget。
