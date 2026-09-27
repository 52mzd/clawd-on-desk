# Dashboard 关联分组修剪

## Goal

修复"关联"分组（`dashboardTrellisLinksGroup`）的三个问题：与左栏任务树重复的纵向父子组、成员截断无提示、"共享 PRD"文案强于证据。

## 已确认事实

- **纵向冗余**：v7 R10 起左栏树（groupTrellisTasks）已按 parent 嵌套渲染子任务（spec §4.6f 第 4 段，含跨 active/archive basename 认亲）；关联分组 `v|<parent>` 组（src/dashboard-renderer.js:2869-2879 `trellisNetworkGroups`）把同一父子关系再列一遍——同数据双呈现
- **静默截断**：`NETWORK_REF_MAX=20`（src/trellis-activity.js:1156）截断组员后无任何提示；`dashboardTrellisLinksTruncated` 键自 v7 R8 面板重写起从未被渲染（已于 7f32ae98 作为死键删除）
- **文案语义**：`p|` 组仅 1 个引用者即成组（src/trellis-activity.js:1295-1297 `citers.length === 0 continue`），证据是文档文本引用（提到一次即算）；"共享"（Shares PRD with）暗示双方共同拥有，强于实际证据"引用"

## Requirements

1. `trellisNetworkGroups()` 移除 `v|` 纵向组生成——关联分组只留横向组（共享规范 / 引用 PRD）；无横向组时沿用既有空态文案
2. 组员截断可见：成员 > NETWORK_REF_MAX 时行内或组内容显示截断提示（重新引入 truncated i18n 键，7 语言）
3. 文案修正："共享 PRD"/"Shares PRD with" → "引用 PRD"/"References PRD"（门槛保持 1 引用者不动——子任务引用父任务 prd 常为单引用者，提门槛会丢真实关联）
4. 同步更新 test/dashboard-trellis-panel.test.js 关联分组用例

## Key Decisions

- 移除 `v|` 组后，「父任务已丢失」（parentMissing）不再有关联分组入口——孤儿在左栏树平铺可见，接受该可见性损失（换取不冗余）
- 纵向父子关系唯一呈现面收敛为左栏树

## 验收标准

1. 关联分组不再出现"子任务"纵向组；仅含父子关系的项目关联分组显示空态文案
2. 构造 >20 成员的共享 spec fixture，UI 可见截断提示
3. `dashboardTrellisLinks*` 文案键 7 语言一致；renderer 与 activity 测试全绿
4. 左栏树父子嵌套行为不变（既有用例不改）

## Out of Scope

- 关联数据面（readTaskNetworkOverview 的 edges 计算）——仅动渲染层消费
- network overview 通道协议
