# v6.1 split 视图华丽化：参照 trellis-card noty-ui 任务库重设计

## Goal

v6 split 视图当前过于朴素（纯文字行 + 右栏小卡），右栏信息量不足导致浏览必须依赖 dblclick 弹 overlay。参照 trellis-card 项目 noty-ui 分支任务库（library mode）的左右结构语言重设计：左栏固定宽列表 + 右栏整栏详情，让右栏本身成为主浏览面，弹窗降级为"读全文"入口。视觉配色**跟随 dashboard 现有 CSS 变量**（`--surface/--text/--muted/--accent/--running/--done` 等，light/dark 自适应），只借 noty-ui 的结构：三段式行、state-dot、chips、note-progress 进度条、底部统计条。

## Requirements

### R1 左栏（master list）

- 固定宽 `280px`（`clamp(260px, 28vw, 320px)`），tint 底色（`--surface-alt` 低透明）、与右栏以 1px 分隔线（`--border`）相接，不再是 46%/54% 弹性分栏。
- Active / Archive 分组头保留折叠交互，样式升级（小 caps 标签 + 计数 pill）。
- 行改为三段式：左 `state-dot`（phase 色，`in_progress` 呼吸动画）+ 中间两行（标题 + sub 行：project · 绑定会话数）+ 右侧（进度数字或归档时间）。
- hover 态（底色 + 轻微位移）、选中态（accent 左边条 + 底色）、归档行降透明（opacity .55）三态清晰。
- 列表底部统计条：`Active n · Archive m` 小字。

### R2 右栏（detail pane，替代弹窗日常浏览）

- 整栏详情卡：大标题（--fs 15-16px）+ meta chip 行（状态 chip：running/done 色 / Phase badge / project 名）。
- `note-progress` 式进度条：圆角轨道 + 分段刻度（复用 `buildTrellisProgressTicks` 数据），完成的段填充 `--done`/`--running` 色。
- 绑定会话区：复用 `createTrellisSessionChip` 渲染，≥1 时展示。
- actions 行：打开完整详情（overlay，保留 dblclick 等价）、复制任务路径；按钮样式沿用现有 `.trellis-*` 按钮。
- 空态保留 `dashboardTrellisSplitEmpty` 文案 + 一个轻微插画感（大号 state-dot + 引导文案）。

### R3 动画

- 行/chips/进度条 hover 过渡 0.15s ease；首次进入保留既有 `group-in`/`detail-in`；`prefers-reduced-motion` 全部禁用。

## Constraints

- 纯渲染层：零新 IPC、零数据形态变更；只动 `src/dashboard-renderer.js`（split 相关函数）与 `src/dashboard.html`（CSS）。
- 配色**不得**引入 noty-ui 的 `--pal-*` tokens；只用 dashboard 现有变量，light/dark 均自适应。
- §4.6f 红线不回退：键盘导航序列从 DOM 派生；窄窗 ≤1100px drawer 降级保留；zoom-safe（percent + px cap，不用 vw）。
- i18n：新增 key 需补齐 en / zh / zh-TW / ko / ja / pt-BR / es 七语言。
- overlay 完整详情（prd/design/subtasks/phases）不动，仅作为 dblclick / 按钮目标。

## Acceptance Criteria

- [ ] 左栏固定宽 + tint 底 + 分隔线 + 底部统计条；三段式行含 state-dot / 标题+sub / 右侧进度或时间
- [ ] 行 hover / 选中 / 归档三态视觉可辨；`in_progress` state-dot 有呼吸动画且 reduced-motion 关闭
- [ ] 右栏整栏详情：标题 + 状态/Phase/project chips + 分段进度条 + 会话 chips + actions；不 dblclick 也能完成日常浏览
- [ ] dblclick 与"完整详情"按钮仍打开 overlay；窄窗 drawer 降级与键盘导航不回退
- [ ] light / dark 下无对比度明显问题（chips、进度条、dot 均用变量派生）
- [ ] `npm test` 全绿；新增 i18n key 七语言无 missing
- [ ] spec §4.6f 更新为 v6.1 结构（左栏定宽、右栏整栏详情、弹窗降级说明）

## Notes

- 参考源：`/Users/Dae/Downloads/codes/trellis-card`（noty-ui 分支）`src/modes/library.js` + `src/base.css` 的 lib-* 结构；只取结构，不取纸质感配色。
- 遗留的 mode 切换失效与上下布局 bug 已单独提交（00dd64a4）。
