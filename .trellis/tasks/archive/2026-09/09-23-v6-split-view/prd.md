# v6 看板改左右栏 master-detail

## Problem

v5-b 的 5 列看板用户反馈"还行，但不如做成左右栏形式"——横向 5 列在窄窗口下
退化成横滚，浏览仍是扫视；master-detail（左列表右详情）才是 Dashboard 尺寸
下的自然阅读形态。同时确认：finish（completed 未归档）实践常空，不应常驻占位。

## Requirements

- **R1 模式改造**：`board` 模式改造为 `split`（左右栏 master-detail）：
  - 左栏：分组列表 `计划 / 执行 / 检查 / 完成 / 归档`，按 `bucketByBoardPhase`
    复用分桶（纯函数已测）；**finish 组空时整组隐藏**；归档组默认折叠、
    可点开（折叠态显示计数徽标）
  - 右栏：当前选中任务的详情面板（内联卡：标题 + phase 徽标 + progress
    刻度条 + session 数 + 操作行「详情 ⓘ / 关联 ⛓」）；未选中时显示空态提示
  - 树模式 `tree` 原样保留；模式切换按钮文案与 localStorage 键沿用
    （`trellisViewMode` 值 `board` → 读取时映射为 `split`）
- **R2 华丽动画**：
  - 模式切入：左栏各组 stagger 滑入（复用 board 列 stagger 形态，纵向）
  - 选中行高亮：左栏选中项背景滑移动画（组内切换 FLIP 或 transition）
  - 右栏内容切换：详情卡 fade+slide 入场（每次换选中任务重放）
  - 归档组展开/折叠：高度过渡 + 计数徽标 pop
- **R3 键盘**：↑/↓ 在左栏可见任务间移动选中（跨组顺序 = 分组顺序），
  Enter 打开完整详情 overlay；焦点管理不抢 Dashboard 快捷键
- **R4 降级**：reduced-motion 全关；窄窗（<1100px）右栏收起为可呼出抽屉
  （选中时临时覆盖左栏，返回键/再点选中行收起）
- **R5 零新增 IPC**：数据面完全复用（同 board），纯渲染层

## Acceptance Criteria

- [x] split 模式落地：左栏 5 组分组列表 + 右栏概要详情卡；finish 空组 continue 跳过
- [x] 归档组默认折叠（▸ + 计数徽标），点开 ▾ + 任务行；toggleTrellisSplitArchive 会话态
- [x] 单击选中（is-selected 内嵌高亮+右栏 translateX 入场卡）；双击 / Enter(dispatchEvent) → openTrellisDetailFromTask
- [x] keydown 网关（split only + 无 overlay/quick + 无修饰键）：↑/↓ DOM 行序移动+scrollIntoView、Enter、Esc 清选中
- [x] reduced-motion 全关；<1100px 右栏 absolute 抽屉（:has(.trellis-split-detail-card) 才显示）
- [x] 全量与基线 diff=0；panel/activity/ipc 184 pass，renderer-behavior 10 红为预存（stash 基线同红）

## Non-Goals

- 不改树模式
- 不做右栏内嵌完整 markdown 文档（仍走 overlay，右栏是概要卡）
