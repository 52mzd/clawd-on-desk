# GitHub Release：为 fork 发布 1.1.0-trellis.1.0 预发布包

## 状态

in_progress（2026-09-26）

## Goal

在 fork `52mzd/clawd-on-desk` 上发布一个**可直接安装**的预发布版本，让使用者不必自己构建就能用上二开版 Clawd。

## 已确认的决策

| 项 | 决策 |
|---|---|
| 版本号 | **`1.1.0-trellis.1.0`**（合法 semver 预发布标识，与上游 `1.1.0` 区分） |
| 发布类型 | **Pre-release** |
| 签名 | **接受未签名 / 未公证**（无 Apple Developer 证书、无 Windows 代码签名证书） |
| 平台范围 | 全套：Windows x64/ARM64 + macOS x64/ARM64 + Linux x64 |

## 关键约束（均已实测）

### 1. 推 `v*` tag 会 fail closed —— 必须手动触发

`.github/workflows/build.yml`：

```bash
if (( present == 0 )); then
  if [[ "$GITHUB_EVENT_NAME" == "push" && "$GITHUB_REF" == refs/tags/v* ]]; then
    echo "::error::A tag release requires all macOS signing and notarization secrets."
    exit 1                                   # ← tag 构建直接失败
  fi
  echo "mode=adhoc" >> "$GITHUB_OUTPUT"       # ← 手动触发走 ad-hoc
fi
```

- **tag 触发** → macOS job 失败（fork 无那 5 个 secrets），而 macOS 恰是用户最需要的平台
- **`workflow_dispatch` 手动触发** → `mode=adhoc`，macOS 可构建 ✅

### 2. 改版本号必须同时满足 `npm run verify:release`

`scripts/verify-release-version.js` 强制检查四项：

1. `package.json` version 匹配 `/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/` → `1.1.0-trellis.1.0` 合法 ✅
2. `package-lock.json` 的 `version` **与** `packages[""].version` 都必须等于它 → `npm version` 自动同步
3. **必须存在 `docs/releases/release-v1.1.0-trellis.1.0.md`** ← 容易漏
4. 仅当 `GITHUB_REF` 是 tag 时才校验 tag 与 version 相等 → `workflow_dispatch` 下跳过

### 3. workflow 不创建 GitHub Release

`docs/project/release-process.md` 明确：workflow 只上传 artifacts 与证据 manifests，**不发布 release**。
→ 需手动 `gh release create` + 上传安装包。

### 4. 创建 release 会创建 tag → 会触发一次 tag run

`gh release create <tag>` 会创建并推送该 tag → 触发 build.yml 的 tag 路径 → macOS 失败。
**规避**：创建 release 前 `gh workflow disable "Build & Release"`，创建后 `enable`。

## 执行步骤

1. 在 fork 上改版本号 + 加 release notes：
   clone fork → `npm version 1.1.0-trellis.1.0 --no-git-tag-version` →
   写 `docs/releases/release-v1.1.0-trellis.1.0.md` → `npm run verify:release` 验证 → push
2. `gh workflow run "Build & Release" -R 52mzd/clawd-on-desk`（手动触发，走 adhoc）
3. 等构建完成（约 30–60 分钟），下载 artifacts
4. 禁用 workflow → `gh release create v1.1.0-trellis.1.0 --prerelease` → 重新启用
5. 上传各平台安装包 + 写 release notes 正文
6. 验证 release 页面

## 验收标准

- **A1** fork 上存在 `v1.1.0-trellis.1.0` 预发布，含各平台安装包
- **A2** `package.json` / `package-lock.json` / release notes 三者版本一致，`npm run verify:release` 通过
- **A3** Release notes 明确标注：这是 fork、**未签名未公证**、逐平台绕过步骤、上游基线提交
- **A4** macOS 包在真机可安装（手动绕过 Gatekeeper 后）
- **A5** 不产生多余的失败 workflow run（用 disable/enable 规避 tag run）
- **A6** **本地 `main` 不被修改** —— 版本号只在 fork 上改

## Out of Scope

- 不做代码签名 / 公证（无证书，属用户成本决策）
- 不修改上游 workflow 的 fail-closed 契约
- 不修改本地开发分支的版本号（本地继续跟随上游 `1.1.0`）

## 风险

| 风险 | 缓解 |
|---|---|
| workflow 在 fork 上因上游专属配置失败 | 先手动触发观察；若 macOS 仍失败，退化为「本地打包 macOS 包 + 手动上传」 |
| 构建耗时长（30–60 分钟） | 异步等待 |
| 未签名包被下载者误认为文件损坏 | Release notes 显式说明 + 给出绕过命令 |
| tag 创建触发失败 run | disable/enable 规避 |
