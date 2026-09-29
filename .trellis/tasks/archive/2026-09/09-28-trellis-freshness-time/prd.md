# PRD — Trellis 数据新鲜度与完成时间精度（HUD + dashboard）

## 背景

用户报告的三个体验问题，均指向 Trellis 视图（HUD 面板 + dashboard）的数据新鲜度与时间粒度：

1. dashboard 归档任务的完成时间只显示到「天」，希望精确到小时/分钟。
2. 从 HUD 点击任务跳转 dashboard 时，常见「点进去任务已经归档」——跳转定位基于旧缓存数据。
3. HUD Trellis 面板内容更新不及时：面板打开后数据冻结，进行中的任务实际已完成仍显示进行中（用户已确认场景）。

## 需求

- R1 归档完成时间粒度：dashboard 归档列表/详情卡中，任务完成时间在有真实时刻信号时显示「日期 + 时:分」；无信号（旧数据回退）时保持现有天粒度显示。
- R2 跳转刷新：HUD → dashboard 跳转时，dashboard 先刷新 Trellis active/archive 列表数据，再执行任务定位。
- R3 HUD 面板数据新鲜：HUD Trellis 面板在打开期间反映磁盘最新状态（任务完成/归档后，面板内容在轮询间隔内更新）。

## 约束

- 不修改 .trellis 生态脚本（task.py 不随 fork 发布，且受 frozen argv 契约保护）——R1 只走 GUI 侧方案（文件系统时间近似）。
- 渲染进程无 Node：只经 preload contextBridge 通信；IPC payload 严格校验。
- src/trellis-archive.js 的 entry shape 是 frozen IPC 契约，字段变更需同步契约注释与测试。
- 完成时刻来自文件系统时间（mtime）时视为近似值：接受归档后再次编辑导致的漂移。
- 时间格式沿用 app 语言（i18nPayload.lang）驱动，不新增 i18n key。
- 最小修改原则：不引入新抽象，改动聚焦现有函数。

## 验收标准

- AC1 归档列表中带 mtime 信号的任务显示「日期 + 时:分」（各语言 locale 格式）；无信号的任务显示与现状一致（天粒度）。
- AC2 HUD 点击「刚归档」的任务行 → dashboard 打开时该任务被正确定位到归档区（基于刷新后数据）。
- AC3 HUD 面板保持打开，外部完成/归档任务后，面板内容在轮询间隔内更新（进行中状态消失/任务从活跃列表移除）。
- AC4 相关既有测试更新、新增用例通过，全量测试无回归。
- AC5 HUD 轮询定时器在面板关闭时清理，无泄漏。
