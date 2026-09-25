# Clawd on Desk v1.1.1-trellis.1.0

> **这是 fork 的预发布版本。** 基于上游 [`rullerzhou-afk/clawd-on-desk`](https://github.com/rullerzhou-afk/clawd-on-desk)
> 的 `v1.1.0`（提交 `0533435b`），新增 **Trellis 工作流集成**。
> 仓库地址：https://github.com/52mzd/clawd-on-desk

## ⚠️ 本版本未签名、未公证

构建过程没有代码签名证书，因此安装时操作系统会给出安全警告。这是**预期行为**，不是文件损坏：

| 平台 | 现象 | 解决办法 |
|---|---|---|
| **macOS** | 「无法验证开发者，无法打开」 | 右键点 App → **打开** → 再次确认；或终端执行 `xattr -cr /Applications/Clawd*.app` |
| **Windows** | SmartScreen「Windows 已保护你的电脑」 | 点「更多信息」→「仍要运行」 |
| **Linux** | 无此限制 | — |

如果你需要签名版本，请使用[上游官方发布](https://github.com/rullerzhou-afk/clawd-on-desk/releases)。

## 本 fork 新增内容

- **Dashboard 任务视图** —— 跨已注册项目浏览任务：阶段分组、进度与 checklist、任务树、规范地图、归档
- **设置 → Trellis** —— 注册项目根目录、安装／升级向导（含 `trellis update` 的真实 dry-run 预览）
- **桌宠状态联动** —— 并行任务杂耍、规划期巫师帽、相位切换气泡、完成庆祝
- **HUD 任务徽标** —— 每个活跃会话绑定的 Trellis 任务，点击可展开内联详情行

权威文档：`docs/project/trellis-settings-panel.md`

## 与上游的关系

- **上游基线**：`v1.1.0`（`0533435b`）—— 上游全部提交完整保留
- **二开内容**：以叠加方式引入，未修改上游既有功能实现
- **许可**：AGPL-3.0，与上游一致
- **构建方式**：在上游 `Build & Release` workflow 上以 `workflow_dispatch`（ad-hoc 模式）产出

## 安装包

| 平台 | 架构 | 文件 |
|---|---|---|
| macOS | x64 / arm64 | `Clawd-on-Desk-1.1.0-trellis.1.0-{x64,arm64}.dmg`（另有 `.zip` 供应用内更新使用） |
| Windows | x64 / arm64 | `Clawd-on-Desk-1.1.0-trellis.1.0-{x64,arm64}.exe` |
| Linux | x64 | `.AppImage` / `.deb` |

## 已知限制

- 未签名 → 首次安装需手动绕过（见上表）
- 这是 fork 的预发布版本，不向上游回贡
- 与上游同步：fork 基于固定基线，上游后续提交需要手动重新导出
