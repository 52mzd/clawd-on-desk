# Dashboard Trellis 任务页（R5）

## 背景与范围

创意池 v1 的 R5 项。活跃 Trellis 任务目前只能从 HUD 徽标一行文字看到
任务名+阶段，无法在 Clawd 的正式 UI 里浏览全貌。本任务在 Dashboard
增加 Trellis 面板：

- 活跃任务列表（标题、阶段、步数进度、绑定会话来源）
- 只读：不在 Clawd 里编辑任务（Trellis CLI / pi 侧才是写入方）
- 点击任务行 → 聚焦该任务绑定的 agent 会话（复用 focus-session 通道）

## 约束

- 数据源只用 `trellisResolver` 产出的 snapshot 字段，不新开文件 watcher
- Dashboard 是 `BaseWindow + WebContentsView`（darwin/win32）：新页面
  组件的 WC 一律从 owner 取，不 `BrowserWindow.fromWebContents()`
- trellis 数据缺失（无 .trellis 目录 / 无活跃任务）时整块隐藏，不留空壳
- 7 语言 i18n：新增键必须 en/zh/zh-TW/ko/ja/pt-BR/es 全补

## 验收标准

- [ ] Dashboard 出现 Trellis 面板：活跃任务名、阶段徽标、步数
- [ ] 点击行触发 focus-session（绑定会话存在时）
- [ ] 无活跃任务时面板隐藏
- [ ] 7 语言键齐全（i18n parity 测试过）
- [ ] `npm test` 失败集与基线一致
