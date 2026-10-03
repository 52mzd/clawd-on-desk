# Clawd on Desk v1.2.0-trellis.1.3

> **这是 fork 的版本。** 基于 [`v1.2.0-trellis.1.2`](https://github.com/52mzd/clawd-on-desk-trellis/releases/tag/v1.2.0-trellis.1.2) 的更新渠道切换版本。
> 仓库地址:https://github.com/52mzd/clawd-on-desk-trellis

## ⚠️ 本版本未签名、未公证

构建过程没有代码签名证书,因此安装时操作系统会给出安全警告。这是**预期行为**,不是文件损坏:

| 平台 | 现象 | 解决办法 |
|---|---|---|
| **macOS** | 「无法验证开发者,无法打开」 | 右键点 App → **打开** → 再次确认;或终端执行 `xattr -cr /Applications/Clawd*.app` |
| **Windows** | SmartScreen「Windows 已保护你的电脑」 | 点「更多信息」→「仍要运行」 |
| **Linux** | 无此限制 | — |

## 本版本内容(自 v1.2.0-trellis.1.2)

### 检查更新改为只检查本 fork 仓库

此前 fork 构建的「检查更新」指向官方仓库 `rullerzhou-afk/clawd-on-desk`:由于
`1.2.0-trellis.x` 在 semver 中排在官方 `v1.2.0` 之前,已装 fork 版的用户点「检查更新」
会被引导安装**官方构建**并丢失全部 Trellis 定制功能。

本版本起,electron-updater feed 与更新发现链路(HTML redirect、GitHub API)全部指向
`52mzd/clawd-on-desk-trellis`:

- **只提示本 fork 的新版本**,与官方发布渠道彻底解耦;
- 版本号语义不变(仍为 `1.2.0-trellis.x` 线)。

### ⚠️ 升级说明(重要)

- **从 v1.2.0-trellis.1.2 或更早 fork 版升级:请手动下载安装本版本**(直接装同架构安装包)。
  旧版安装包内嵌的更新源仍指向官方仓库,**不要**在旧版里点「检查更新」——那会安装官方
  构建并丢失 Trellis 功能。手动装上本版本后,以后的「检查更新」就只会检查本 fork。
- 从 v1.2.0-trellis.1.2 升级无设置迁移,直接覆盖安装。

## 版本说明

这是私有 fork 构建(`1.2.0-trellis.1.3`)。semver pre-release 后缀使其在更新器比较中排在官方 `v1.2.0` **之前**;不发布到官方 release 渠道或 winget。
