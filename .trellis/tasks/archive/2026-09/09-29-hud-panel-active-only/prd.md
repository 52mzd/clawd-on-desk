# HUD Trellis 面板聚焦进行中任务

## 背景

用户反馈：HUD 中有多个 trellis 任务时，面板只显示一个。

实测根因（2026-09-29 排查）：
- ~/.clawd/trellis-roots.json 注册了 33 个项目 roots（codes/ 目录全量注册）
- readHudTaskPanel 对每个 root 收集 active 全量 + 归档 <=3 条（HUD_PANEL_ARCHIVE_MAX），按 recency 取前 5 个项目（HUD_PANEL_PROJECT_MAX）
- 33 项目 x 归档扫描产出 20+ 行内容，远超 .trellis-task-panel 的 max-height 320px（overflow-y: auto 内部滚动）
- 可视区只够显示顶部 chipInfo（3 行 owner 会话任务详情）+ anchor 项目开头，其余任务全部被压在滚动区下方
- 窗口高度回传链正常（render() 每次实测面板高度回传 main 扩窗），数据链无截断——纯显示空间问题

HUD 面板的定位是「现在进行时」；归档历史属于 dashboard（面板底部已有「全部任务」跳转入口）。

## 需求

R1: 非 anchor 项目只收集 active 任务；没有 active 任务的项目不进入 projects
R2: anchor 项目（打开面板会话所在项目）保持现状：active 全量 + 归档 <=3
R3: 常规场景（2-3 个项目有 active）面板内容 <=320px 全部直接可见；极端场景仍走内部滚动兜底
R4: 附带收益：跳过无 active 项目的归档扫描 IO
R5: 面板头部多会话任务摘要——顶部「Trellis 任务：xxx」区从 owner 单任务扩展为所有带 trellis 任务的会话各一行，多任务一眼看全（用户 09-29 澄清：最初想优化的就是这里）
R6: 头部一行式会话清单（用户 09-29 复核 R5 效果：三行详情 + 灰字摘要拥挤、不直观）——取消 owner 常驻三行，所有带任务会话统一一行：阶段色圆点 + 任务名 + 右侧正在执行的 trellis skill/指令（command 优先，次 workflowNextAction，兜底步数 done/total；不显示阶段词），原三行内容（任务/阶段 hint/command）移入行 hover tooltip
R7: 头部标记与列表实心圆点区分（用户 09-29 反馈同款圆点难分层级）——空心环迭代为 12px 五角星：CSS mask 剪既有 .trellis-dot-* 阶段色背景，纯 CSS 作用域覆写，列表行 7px 实心点不变

## 验收标准

A1: readHudTaskPanel 返回的 projects 中：无 active 任务的 root 不出现；非 anchor 项目 archived 为空
A2: anchor 项目 active + archived(<=3) 行为与现状一致
A3: 单测覆盖 A1/A2（扩展现有 readHudTaskPanel 用例）
A4: renderer 面板列表渲染逻辑不动（R1-R4 时点；R5/R6 起头部渲染由 R5/R6 需求接管，空项目 skip 仍由数据层自然满足）
A5: R6 头部行结构（dot/任务名/activity 右槽）、tooltip 保留完整三行内容、测试断言 skill/指令优先于阶段词

## 约束

- KISS：只动 main 层（trellis-activity.js）数据收集；renderer/CSS 不改
- spec .trellis/spec/guides/trellis-panel-contract.md 同步契约（归档只属于 anchor 项目）
- HUD_PANEL_ARCHIVE_MAX / HUD_PANEL_PROJECT_MAX 常量语义调整需在注释与 spec 说明

## 非目标

- R6 起头部不再常驻显示阶段词与 hint/command 行（内容进 tooltip，不做折叠展开交互）
- 不改 320px max-height 与内部滚动
- HUD 面板侧栏归档行的时间精度（另有议题）
