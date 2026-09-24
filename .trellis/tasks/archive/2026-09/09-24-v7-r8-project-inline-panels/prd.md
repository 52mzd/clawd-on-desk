# v7 R8: 项目级关联全景 + 规范地图内嵌项目视图

## 背景（用户反馈，2026-09-24）

1. **关联（⛓）入口错了**：当前 ⛓ 挂在任务详情卡上，要"点进某个任务"才能看它的关联。
   用户要的是**项目级**入口——在项目视图上有一个关联按钮，点开看到**整个项目所有任务
   的关联全景**（纵向 parent/children + 横向共享 spec/PRD），而不是逐任务钻取。
2. **规范地图没整合进项目**：spec map 仍是独立 overlay 弹层，用户点开感觉"还是独立的"。
   要求规范地图**内嵌在项目视图里**（project bar 下方展开的面板），不是另开一个浮层。

## R1 项目级关联全景

- project bar 增 ⛓ 入口（与 📐 规范入口、⚙ 管理抽屉并排）；点开在项目视图内展开
  `trellis-network-panel` 面板：全项目任务关联网络。
- 数据面新增只读 IPC `dashboard:trellis-network-overview`：
  `readTaskNetworkOverview(root)` 一次遍历（active 两层 + archive/<month>/<name> 两层）：
  - nodes：每任务 `{taskPath, title, archived, priority}`（task.json，读不到跳过）
  - 纵向边：每个任务 task.json `parent` 解析成 `{childTaskPath, parentTaskPath|missing}`
    的全量列表（children 为其反向，不重复存）
  - 横向边：一遍扫描任务文档文本（prd/design/implement.md + implement/check.jsonl，
    复用 `SPEC_REF_DOC_NAMES`），按 `.trellis/spec/<rel>` 引用分组 specGroups（≥2 个
    引用者才成组）、按 sibling `prd.md` 引用分组 prdGroups（含 owner，owner+citer≥1 即边）
  - 帽：任务数 ≤ `NETWORK_SIBLING_MAX`(200)，文档文本总量 ≤ `SPEC_REF_MAX_BYTES`(2MiB)，
    超限截断并置 `truncated:true`；严格只读，IO 错误降级为更短的列表而非失败
- 面板渲染分三段：纵向关系（父→子组）、共享规范组、共享 PRD 组；任务行可点击，
  点击即 `selectTrellisSplitTask`（跳到 split 列表选中并展开详情）。
- **移除**详情卡 header 的 ⛓ 单任务入口；`readTaskNetwork`（单任务）IPC 与数据面随入口
  一并删除，横向边逻辑由 overview 吸收（避免死代码）。

## R2 规范地图内嵌

- project bar 的规范入口点击 → 在项目视图内展开 `trellis-spec-panel`（不再是 overlay）：
  左侧文件列表（含 R6 的 filled/lines/refCount 徽标）、右侧文档内容，面板内布局。
- 删除 `trellisSpecOverlay` 弹层路径（html 宿主元素、renderer overlay 逻辑、CSS），
  spec 渲染函数改为面向面板 host。
- overlay 仅剩 Sessions 卡片详情链路在用，不动。

## 共用：统一抽屉态

- `trellisView.manageOpen` 收敛为 `trellisView.panelOpen: null | "manage" | "network" | "spec"`
  （会话态，不持久化）；一次只开一个抽屉，切换互斥；渲染签名含 `panelOpen`。
- ⚙/⛓/📐 三个按钮都带 `aria-expanded`。

## 红线

- 新 IPC 只读、有界、零 CLI mutation；不改 task.json / spec 文档内容
- split 单视图契约（§4.6f）不回退：键盘导航、embedded 详情、月份子组不受影响
- i18n 7 语言键齐全；不新增依赖
- `npm test` 无新增失败；删除功能的测试同步清理，新行为有测试

## 验收

1. 项目视图顶部可见 ⛓ 与 📐 与 ⚙；点击 ⛓ 展开全项目关联面板，含纵向/共享规范/共享 PRD
   三段；点击面板内任务行跳转 split 选中
2. 详情卡上无 ⛓ 入口
3. 点击 📐 在项目视图内展开规范面板（列表+内容），无 overlay 弹层；三抽屉互斥
4. `readTaskNetwork`（单任务）通道、数据面及其测试被移除；overview 有单测
5. 残留检查：`trellisSpecOverlay`、`openTrellisNetwork`（详情卡入口路径）= 0
6. `npm test` 失败集与 HEAD 一致
