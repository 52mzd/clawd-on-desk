# 官方主题版本门对 fork 预发布号的兼容

## Bug 诊断（2026-09-27 已确诊，直接按此修）

**症状**：Settings 里官方主题全部显示"需更新 app"（state: update-app）无法选择。

**根因链**（src/official-theme-catalog.js）：
1. `VERSION_PATTERN = /^\d+\.\d+\.\d+$/`（:28）——本仓 fork 版本号 `1.1.0-trellis.1.1` 不匹配
2. `parseSemver`（:63-66）返回 null（即便放行，`Number("0-trellis")` 也是 NaN：实测 `[1,1,NaN,1,1]`）
3. `deriveOfficialThemeState`（:617-625）：`minOk = compareSemver(appVersion, entry.minAppVersion)` 为 null → `minOk === null` 分支 → `state: "update-app", reason: "min-app-version"`
4. appVersion 来源：`getAppVersion()`（official-theme-main.js:109/433/485）= package.json 版本（fork 模式 A：`1.1.0-trellis.1.1`）
5. 历史背景：fork-release-guide 已记载「fork 预发布号在 semver 小于同号正式版」的同族坑；版本号是 09-27 发版时定的（e93d3b80）

## 修法要求

- 语义：fork 版本 `1.1.0-trellis.1.1` 的**兼容基线 = 1.1.0**（剥 `-` 预发布后缀后比较三段）
- 实现取舍（按最小面）：**不要**放宽 catalog 数据校验（:219-220 对 minAppVersion 的严格性保留——官方数据应纯三段）；只对 **appVersion 入参**做 normalize（剥后缀）后再比较。建议：新 `normalizeAppVersion(v)` 或在 official-theme-main.js 两处调用点（:433/:485）传参前 normalize，选择实现位置时保证 `deriveOfficialThemeState` 的现有用例不破
- `:571` 的 `compareSemver(...) < 0`（null < 0 = false 碰巧不拦）修后应自然正确

## 验收标准

1. `deriveOfficialThemeState({ appVersion: "1.1.0-trellis.1.1", minAppVersion: "1.0.0" 的 entry })` → 非 update-app（installed/available 路径正常）
2. `1.1.0-trellis.1.1` vs `1.2.0` → 仍判 update-app（基线比较方向正确）
3. catalog 校验用例不破：`minAppVersion: "x.y"` 仍被拒（:219 的 errors 路径）
4. `node test/official-theme-catalog.test.js` 全绿 + 新增上述 3 类用例
5. 只读 diff：不碰 theme 安装/下载路径

## Out of Scope
- 版本号策略改动（不换回上游同号）
- updater 通道（fork 不走官方 updater）
