# 官方上游跟进：幽灵会话过滤 issue + macOS acceptFirstMouse 补丁

## 背景

2026-09-27/28 会话调查结论（详见 memory `clawd-official-mac-first-click`、`clawd-session-history-ghost-cleanup` 与 journal session 28）：

1. dashboard 恢复列表被幽灵会话淹没：`claude daemon`（cwd=/）产生秒级记录、另有 `endedAt` 损坏（≈0）的陈年记录；官方 `session-history` 无过期清理，loader 对无 transcript 的行照样展示（`session-history-loader.js` "null means could not determine — the row is still offered"）。
2. 设置/dashboard 按钮「要双击」：macOS 失焦窗口第一击只激活不传 click；官方仅 `src/permission.js` 两处权限弹窗配了 `acceptFirstMouse: true`，其余窗口未配。

## 交付物

- [ ] 向 rullerzhou-afk/clawd-on-desk 提交 issue：建议 loader 过滤 `cwd="/"` 的秒级会话与 endedAt 异常记录（附本机统计：116 条中 107 条 <1s、104 条 cwd=/）
- [ ] 评估本地补丁：`settings-window.js` 与 `dashboard-host.js` 窗口构造补 `acceptFirstMouse: true`（macOS only，写法对齐 `permission.js:2486-2492`）；确认无官方冲突后落地或明确改为等待官方修复

## 验收标准

- issue 已提交且含最小复现数据；若官方修复，清理 memory 中对应记录
- 补丁若落地：后台 app 的设置/dashboard 窗口第一击直接触发按钮，全量测试绿
