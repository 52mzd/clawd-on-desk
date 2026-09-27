# Implement：HUD trellis 任务面板 + Dashboard 跳转

## 顺序清单

1. `src/trellis-activity.js`：`readHudTaskPanel(cwd)`（复用既有遍历 + 单 root 过滤 + archived 截 8）
2. `src/session-ipc.js` + `src/preload-session-hud.js`：两个新通道（trellis-panel invoke / open-trellis-task send）+ trusted sender 门禁；session-ipc.test.js 白名单与校验矩阵同步
3. `src/main.js`：open-trellis-task handler（路径遏制 + showDashboard + navigate 发送，含 did-finish-load 时序）
4. `src/dashboard.js` + `src/preload-dashboard.js`：`dashboard:navigate-trellis` 通道（onNavigateTrellis 桥）
5. `src/dashboard-renderer.js`：navigate 处理（switchDashboardView + revealTrellisTask 复用）
6. `src/session-hud-renderer.js` + `src/session-hud.html`：面板 UI（chip toggle 改造、面板头=原详情内容、两段列表、查看全部行、max-height/内滚、高度测量选择器扩展）
7. `src/i18n.js`：sessionHudTrellisPanel* ×7（整行锚定插键）
8. 测试：
   - [ ] activity：readHudTaskPanel 单 root 过滤/截 8/只读断言（writeOps=[]）
   - [ ] session-ipc：白名单 + payload 形状矩阵 + untrusted 拒 + invalid 不触达 owner
   - [ ] HUD vm 行为：chip 开面板、行渲染、点击行调 openTrellisTask、ESC 收起
   - [ ] dashboard vm：navigate → 视图切换 + 任务选中（active 与归档两例）
   - [ ] 静态：CSS 类定义↔引用双向、[hidden] 级联守卫

## 验证命令

```bash
node test/trellis-activity.test.js
node test/session-ipc.test.js
node test/session-hud-style.test.js
node test/dashboard-trellis-panel.test.js
node test/i18n.test.js
node test/run-tests.js   # readme 预存除外
```

## 风险文件

- src/session-hud-renderer.js（高度测量选择器改动——勿破坏 §4.1 防抖语义）
- src/dashboard.js（发送时序——冷启动 did-finish-load 分支必须有测试）
- src/trellis-activity.js（复用遍历勿复制；parallelCache 30s 缓存语义勿动）
