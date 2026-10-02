# Clawd on Desk v1.2.0-trellis.1.1

> **这是 fork 的版本。** 基于 [`v1.2.0-trellis.1.0`](https://github.com/52mzd/clawd-on-desk-trellis/releases/tag/v1.2.0-trellis.1.0)（官方 v1.2.0 + 本地批次）的修复版本。
> 仓库地址:https://github.com/52mzd/clawd-on-desk-trellis

## ⚠️ 本版本未签名、未公证

构建过程没有代码签名证书,因此安装时操作系统会给出安全警告。这是**预期行为**,不是文件损坏:

| 平台 | 现象 | 解决办法 |
|---|---|---|
| **macOS** | 「无法验证开发者,无法打开」 | 右键点 App → **打开** → 再次确认;或终端执行 `xattr -cr /Applications/Clawd*.app` |
| **Windows** | SmartScreen「Windows 已保护你的电脑」 | 点「更多信息」→「仍要运行」 |
| **Linux** | 无此限制 | — |

## 本版本修复(自 v1.2.0-trellis.1.0)

- **Windows 全局 Trellis CLI 检测修复** —— 修复 Settings → Trellis 页在 Windows 上无论是否安装 Trellis CLI 都显示「PATH 中未找到 Trellis CLI」的缺陷。根因:全局安装检测唯一的纯文件系统扫描在 Windows 上恒返回空(npm 安装的 `trellis.cmd` shim 无法被 fs 扫描模拟),空结果被直接当成未安装,却没有替代检测路径。现于该场景回退为一次经 shell 的 `trellis --version` 探测(可正确解析 `.cmd` shim):已安装时显示实际版本号与升级入口;真正未安装时仍干净地显示安装指南。同时修复了 Windows 上「升级 CLI」前后版本读数失真的问题。已在 Windows 真机验证(trellis 0.6.17 正确显示)。

## 升级说明

- 从 v1.2.0-trellis.1.0 升级:直接安装同架构安装包即可,无设置迁移。
- Windows 用户请按 CPU 架构选择安装包:x64(Intel/AMD)或 arm64(Surface Pro X 等 ARM 设备)。

## 版本说明

这是私有 fork 构建(`1.2.0-trellis.1.1`)。semver pre-release 后缀使其在更新器比较中排在官方 `v1.2.0` **之前**;不发布到官方 release 渠道或 winget。
