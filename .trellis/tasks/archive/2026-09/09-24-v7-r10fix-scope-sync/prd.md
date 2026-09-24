# v7 R10fix: 规范/关联分组跟随项目过滤

## 问题（四轮反馈）

R10 的规范/关联分组样式对了，但内容不跟项目走：分组只在首次展开时拉取
一次（selectedRoot 或 roots[0]），之后切项目 chip 内容不变——每个项目
看到的都是同一份。

## 修复

- `currentTrellisScopeRoot()`：分组的作用域 = selectedRoot（chip 选中）
  或 roots[0]（All 视图），与 split 列表过滤同一真相
- `syncTrellisPanelScopes()`：每次 `renderTrellisView()` 重建时检查——
  分组仍展开且 scope root 变了（不在 loading 中）→ 清缓存重拉
  （spec: files/selected/docs cache；network: result）
- `refetchTrellisSpecForScope / refetchTrellisNetworkForScope`：统一的
  重置+拉取助手，toggle 首次展开与 scope 切换共用
- `openTrellisSpec/closeTrellisSpec` 简化为纯分组开关（不再接 root 参数）

## 验收

- 展开 spec+关联 → 切项目 chip：两组都对新 root 重拉（specCalls/
  networkOverviewCalls 记录 /proj/one→/proj/two），行内容跟着变；
  切回 All 回到 roots[0]
- npm test 失败集与 HEAD 一致（11045/10979/20 预存）
