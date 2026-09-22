# v4-a 规范地图 执行计划

## 顺序清单

- [x] 1. `src/trellis-activity.js`：新增 `readSpecTree` / `readSpecDoc`（信任谓词复用、relPath 严格校验、深度/数量/大小帽）
- [x] 2. `src/session-ipc.js`：`dashboard:trellis-spec-tree`（单键 {root}）+ `dashboard:trellis-spec-doc`（双键 {root, relPath}）
- [x] 3. `src/main.js`：api 表 `getTrellisSpecTree` / `getTrellisSpecDoc`（activity 缺失走既有 error envelope）
- [x] 4. `src/preload-dashboard.js`：暴露两个 API
- [x] 5. `src/i18n.js`：四键 × 七语言
- [x] 6. `src/dashboard.html` + `src/dashboard-renderer.js` + 样式：规范按钮、面板容器、列表/渲染/缓存/关闭清理
- [x] 7. 单测：activity（正常/穿越拒绝/超深/空目录/截断）+ session-ipc（payload 校验矩阵）
- [x] 8. `npm test` 全量与 stash 基线 diff=0
- [ ] 9. dev app 重启 + 真机冒烟（打开规范面板，看到 cross-layer-thinking-guide.md 渲染）

## 验证命令

```bash
node --test test/trellis-activity.test.js test/session-ipc.test.js
npm test 2>&1 | grep "^✖" | sort   # 与 stash 基线 diff
```

## 审查门

- spec 通道新增 → trellis-panel-contract.md 补 7 段式（步骤 6 后、commit 前）
- 渲染安全：确认走 renderMarkdownDoc，无任何 innerHTML 直写

## 回滚点

单提交（步骤 1–8 一个 commit）；revert 即回滚，无迁移。
