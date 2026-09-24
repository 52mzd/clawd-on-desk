# v7 split 单视图：去树形、整合项目选择与规范地图、补关联入口

## Goal

split 成为 Trellis 面板**唯一**任务视图：删除 tree/board 渲染分支与 mode 切换，把 tree 独有功能补进左右栏，规范地图并入面板，顶部项目区重设计。

## 调研结论：tree/board 独有、split 尚缺的功能（删除前必须补齐）

| # | 功能 | 现状 | v7 落点 |
|---|------|------|---------|
| 1 | **⛓ 关联网络**（`task.parent \|\| hasChildren` 时） | tree 行 + board 卡有；detail card（overlay/embedded 共用）无 → **用户已发现的遗漏** | 嵌入详情卡 actions 区补 ⛓ 按钮（stopPropagation，调 `openTrellisNetwork`） |
| 2 | **归档月份分组 + ↻ 刷新 + loading/error/retry** | `buildTrellisArchiveSection` 独有 | split 的 DONE 组内部按月分子组（复用 month-of 归组纯函数）；↻/错误重试放 Archive 组头 |
| 3 | **全部展开/折叠**（`appendTrellisTreeTools`） | tree 标题行独有 | 列表底部或组头提供 expand-all / collapse-all（作用于 `collapsedPaths`/`expandedTrellisTasks`） |
| 4 | **单会话行点击直达聚焦** | tree 行：单 binding 单击即 `focusSession`；split 行单击=选中 | 接受一步差异（右栏 session chip 聚焦）；不强行合并，避免破坏选中语义 |
| 5 | **board 残留** | `buildTrellisBoardSection/Card`、FLIP capture/flip、`"board"` 分支 5 处引用 | v6 该删未删，本次一并删除 |
| 6 | **优先级 P0/P1/P2 chip**（线上版对照） | 线上 trellis-card 任务行有 priority chip + `pri-p0/pri-p1` 高亮；我们未显示 | split 行 sub 行与详情卡 meta chips 加 priority chip（P0/P1 着色） |
| 7 | **规范地图数据面**（线上版对照） | `list_specs` 扫 `.trellis/spec/`：每 md 的填写状态（有效行数阈值）+ 被引用次数 | R6 整合时地图行展示这两个字段，不只是链接列表 |
| 8 | **spec/PRD 共享分组**（线上版对照） | `list_relations` 返回 `spec_groups` + `prd_groups`：多任务引用同一 spec/prd 的横向关联 | R2 的关联视图补横向边（现只有父子树） |
| 9 | **归档回执**（线上版对照） | `focusedTaskSnapshot` 归档后主卡保留回执不闪空 | 低优先：右栏选中任务被归档时保留回执而非立即空态 |

已等价覆盖（无需补）：层级树折叠、phase 状态、子任务摘要（{n} 子任务）、ⓘ 详情（点击即详情卡）。

## Requirements

### R1 删除 tree/board 视图

- 删除 `buildTrellisActiveSection`、`buildTrellisArchiveSection`（迁移月份分组/刷新逻辑后）、`createTrellisTaskRow`、`createTrellisTreeNodeRow`、board 全家（`buildTrellisBoardSection/Card`、`captureTrellisBoardCardPositions`、`flipTrellisBoardCards`）、`appendTrellisTreeTools`。
- 删除 mode 切换按钮；`renderTrellisView` 只剩 split 分支。
- `localStorage['trellisViewMode']` 读取保留迁移（board/tree→split）但不再写入；清理相关 i18n key（mode 按钮文案）。
- 键盘导航保留 ↑↓/Enter/Esc（§4.6f 红线不变）。

### R2 补 ⛓ 关联入口（完整关联功能）

- 嵌入详情卡 actions 区：`task.parent || task.hasChildren` 时渲染 ⛓（`trellis-split-action-ghost` 样式），`stopPropagation`，调 `openTrellisNetwork`。overlay 卡同步受益（同组件）。
- 关联网络数据面补横向边：任务间共享 spec（`spec_groups`）与共享 PRD（`prd_groups`）的同源关联（对照线上版 `list_relations`），与父子树边区分渲染。

### R3 归档月份分组 + 刷新

- split 的 DONE 组内按月分子组头（"2026-09 · 3" 可折叠），归档子树随根归月。
- Archive 组头加 ↻（`refreshTrellisViewArchive`）与 loading/error/retry 态（迁移自旧 section）。

### R4 全部展开/折叠

- 列表某处（组头行尾或底部统计条旁）两个小按钮，作用于当前可见树的 `collapsedPaths` 全清/全置。

### R5 项目区（顶部）重设计

- 现状：filter-title + mode 按钮 + 项目 chips 凌乱。目标：单行紧凑项目选择器（下拉或横排 chips + All），含 spec 地图入口。

### R6 规范地图整合

- `openTrellisSpec` overlay 保留交互但入口整合：项目选择器旁一个"规范"按钮（作用于当前选中项目）；或作为列表顶部虚拟行。**brainstorm 待定具体形态**。
- 地图行数据面对齐线上版：每个 spec 文件展示**填写状态**（有效行数过阈值 = 已沉淀，否则待填）与**被任务引用次数**。

### R7 优先级显示（线上版对照新增）

- split 行 sub 行与详情卡 meta chips 显示 `priority`（P0/P1/P2）chip；P0/P1 着色高亮（`pri-p0`/`pri-p1` 类名对齐线上版）。

## Acceptance Criteria

- [ ] Trellis 面板无 mode 切换；tree/board 代码路径删除，`"board"`/`"tree"` 字符串残留为 0（除迁移读取）
- [ ] 详情卡（嵌入与 overlay）在有关联时显示 ⛓，点击打开关联网络；关联图含 spec/PRD 共享横向边
- [ ] 规范地图展示填写状态 + 引用计数
- [ ] priority chip（P0/P1/P2）出现在行与详情卡
- [ ] Archive 组按月折叠分组；↻ 刷新与错误重试可用
- [ ] 全部展开/折叠一键生效
- [ ] 项目区单行化；spec 地图入口在面板内可达
- [ ] 键盘导航、drawer 降级、自适应高度不回退（§4.6f 红线）
- [ ] `npm test` 无新增失败；删除功能的测试同步清理
- [ ] spec §4.6f 更新为 v7 单视图契约

## 后续候选（v7 不做，待办记录）

调研 docs.trytrellis.app 发现的检测层功能，与 v7（UI 重构）不同领域，择机开新任务：

1. **Runtime Sessions 自动任务绑定**（推荐优先）：读 `.trellis/.runtime/sessions/<session-key>.json` 自动感知会话→任务映射，替代手动 binding；HUD 显示任务名，纯本地文件轮询零 hook。
2. **任务 phase 状态机直读**：`task.json.status`（planning/in_progress/completed）为权威源，气泡/HUD phase 徽章从 status 派生；archive 时任务级庆祝动画。
3. **Channel 多 agent 协作检测**：监听 `~/.trellis/channels/` 事件日志，新增"协作中"桌宠状态（多 worker 并行 / wait 等待 / escalation）。成本较高。
4. **Journal 收尾提醒**（轻量）：会话结束但任务未 archive / 未记 journal 时气泡提示 `/trellis:finish-work`。

## Notes

- 顺序建议：R2（最小补缺）→ R3/R4（归档+批量）→ R1（删树）→ R5/R6/R7（顶部重设计 + priority chip）。R1 删码最大，放功能补齐后可避免中途丢功能。
