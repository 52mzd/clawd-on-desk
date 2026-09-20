# 任务详情视图（③）

## 范围

v1 的 Dashboard Trellis 面板行增加"详情"入口：点击行（或行尾详情按钮）
打开任务详情卡片（Dashboard 内嵌面板，不新开窗口）：

- 任务标题、阶段徽标、步数进度（n/m + 进度条）
- implement.md checklist 渲染（勾/未勾只读列表）
- 阶段跃迁史（scanner 已有 phase 历史数据面，确认字段）
- 绑定会话列表（可点击聚焦，复用 v1 focus 通道）

## 约束

- 数据：详情内容在打开时按需读取（renderer 请求 → main 读文件 → 单次
  IPC 回包），不常驻轮询；trellis 文件读取复用 scanner 既有解析
- implement.md 渲染：只解析 checkbox 列表 + 标题，**不渲染任意
  markdown**（无 md 引擎依赖，白名单标签零风险）
- 详情卡片与 Dashboard 现有视图切换语义一致（返回按钮/ESC，参考现有
  面板导航模式，先看 dashboard-renderer 有无现成 detail 视图先例）
- 7 语言 i18n 新键全补
- 无 trellis 数据：入口隐藏（v1 语义延续）

## 验收

- [ ] 行点击 → 详情卡片显示标题/阶段/进度/checklist/阶段史/绑定会话
- [ ] checklist 项与磁盘 implement.md 一致（勾选状态实时读）
- [ ] 绑定会话点击聚焦生效
- [ ] 7 语言齐全；npm test 失败集与基线一致
