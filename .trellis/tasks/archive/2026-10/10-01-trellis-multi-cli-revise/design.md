# Design：多装检测修订

## D0 沿用：判定在 cli 层（不变的红线）

`outdated` 是判定结果不是展示偏好，与 `cleanup` 同层——在 `readGlobalVersion` 收集完全部
版本后统一定，随 installs entry 下发。renderer 只读布尔渲染，零版本比较逻辑（vm 沙箱无法
require 主进程模块，且版本比较是「删谁」的依据，必须单点可测）。

## D1 版本比较器（src/trellis-cli.js 新增 `compareVersions`）

简化 semver，够用且写死规则：

```
parse: /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/ → {major,minor,patch,pre|null}
  解不开 → null（比较时视为「不可比」）
major/minor/patch 数值比；相等时 prerelease 规则：
  pre === null > pre !== null（正式版 > 预发布）
  双方都有 pre：按 "." 拆标识符逐段比——纯数字段数值比（数字 < 字母段），
  短的靠前（1.0.0-beta < 1.0.0-beta.4）
compareVersions(a, b) → -1|0|1；任一解析失败 → 0（不可比 = 不产生 outdated）
```

导出供单测。

## D2 outdated 判定（readGlobalVersion 内）

收集完全部 installs 后：取全部可解析版本中的最大者 `newest`（无任何可解析版本则无
outdated）；entry.version 经 `compareVersions(entry.version, newest) === -1` →
`outdated: true`，否则 `false`。null 版本：compare 返回 0 → 永不 outdated（不指挥用户删
看不懂的东西）。同版本多装：互不严格旧 → 全 false（保守）。

`active` 字段语义不变（PATH 首命中），仅文案改。

## D3 行渲染结构（settings-tab-trellis.js）

单行改两行容器（`.trellis-cli-install`）：

```
.trellis-cli-install
  .trellis-cli-install-row（flex, align-items: center）
    [徽标 span ×N]  .trellis-cli-install-path(ellipsis)  .trellis-cli-install-version
  .trellis-cli-install-cmd（仅 outdated 行；flex, align-items: center）
    .trellis-cli-install-cmd-text(mono, ellipsis, user-select:text, title=cmd)
    [复制按钮 buildCopyButton(cmd)]
```

徽标矩阵（badges 依次）：
- `active` → `trellisCliInstallActive`（文案改「Clawd 当前使用」/"In use by Clawd"）
- `outdated` → `trellisCliInstallExtra`（文案改「旧版（可清理）」/"Older (safe to remove)"）
- `!outdated` → `trellisCliInstallLatest`（新键「最新」/"Latest"）

版本号从「多余」徽标里拆出，独立 `.trellis-cli-install-version` 显示（所有行）。
缺 `outdated` 字段的旧 payload：`install.outdated !== true` → 按「最新」分支渲染，不报错。

## D4 CSS（settings.css）

- `.trellis-cli-install-row / .trellis-cli-install-cmd`：`align-items: center`（反馈 1）
- `.trellis-cli-install-cmd`：左缩进对齐 path 起点（padding-left 同徽标宽或 8px 简单缩进）
- `.trellis-cli-install-version / -cmd-text`：`flex: 0 0 auto / 1 1 auto` + min-width: 0
- 徽标色：outdated 用 `--warning-action`（既有 token），latest 用次级文本色

## D5 i18n（settings-i18n.js，7 语言）

- `trellisCliInstallActive` 文案改为「Clawd 当前使用」等价译文
- `trellisCliInstallExtra` 文案改为「旧版（可清理）」等价译文
- 新键 `trellisCliInstallLatest`：「最新」等价译文

## 测试策略

| 层 | 断言点 |
| --- | --- |
| trellis-cli.test.js | compareVersions 等值/新旧/prerelease 排序（正式>beta、beta.1<beta.2、数字段<字母段）/解析失败 0；readGlobalVersion installs 的 outdated 归属（PATH 翻转换 active 不换 outdated；null 版本不标；同版本全不标） |
| trellis-ipc.test.js | 既有透传用例 fixture 加 outdated 字段（透传语义不变） |
| settings-tab-trellis.test.js | 徽标矩阵三态、命令文本可见、复制仍写剪贴板、缺 outdated 旧 payload 降级、单装零渲染不变 |

## 兼容与回滚

- installs entry 只**加** `outdated` 布尔，旧 renderer 读不到该字段不崩（新 UI 未发布前无
  实际消费者）；本次 src 与 UI 同 commit 发布
- 最坏 revert 单 commit，无存储迁移
