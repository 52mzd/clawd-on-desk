# Implement — Dashboard Trellis UI 重设计

## 前置

- [x] 基线：`npx node --test test/ -g trellis`（dashboard-trellis-panel 63/63；trellis-doc-renderer 368/368 等）
- [x] 基线：`npm test` 全量 11045 tests / 10979 pass / 20 fail（session-renderer-behavior 等 20 个失败为主分支既有）

## Batch A — 排版收敛（design.md §3.A）

- [x] `src/dashboard.html` trellis CSS 块顶部新增 `--trellis-*` 局部 token（font-title/sub/meta、radius、press）
- [x] 6 类元素改到 typography scale（13/12/11/16px，行高 1.4–1.5）
- [x] 全部 10px → ≥11px；`tabular-nums` 用于时间/计数
- [x] 验证：`npm test` + trellis 测试全绿

## Batch B — 交互三态（design.md §3.B）

- [x] 5 类按钮补 `:active`（scale 0.97, `--trellis-press`）+ `:focus-visible`（2px accent outline）
- [x] group-head click handler 移到 toggle button（stopPropagation 保留）
- [x] chip-unfocusable / is-missing：`cursor: not-allowed` + `aria-disabled`
- [x] split 列表键盘行 focus-visible 样式
- [x] 验证：`npm test`；grep 确认无 div.onclick 残留

## Batch C — 对比度 + SVG 图标（design.md §3.C）

- [x] `iconSvg(name)` helper（内联 SVG + currentColor + aria-hidden）
- [x] 替换全部 unicode 图标（⛓ → link 等）；caret 12px SVG 居中、折叠用 CSS rotate、phase dot 8px 居中
- [x] archived/missing 只 dim 装饰元素（dot/tags/badges 50%），文本保 4.5:1
- [x] pri-p2 改 1px border + 4.5:1 文本；P0/P1 强调保留
- [x] 空 progress-tick 1px stroke ≥3:1
- [x] month-head click 移到内部 toggle button（check 发现 toggle 类冗余已清理：折叠态由父级 `month-head.is-collapsed` 派生）

## Batch D — 动画纪律（design.md §3.D）

- [x] split rebuild 零重放入场动画（仅首次挂载 first-mount 守卫）
- [x] 键盘导航即时类切换（无 transition）
- [x] 保留 detail overlay / 首次进入动画
- [x] `prefers-reduced-motion: reduce` 关闭本批动画

## Review gates

- [x] Batch B 后：grep test/ 无被改 selector 的陈旧断言残留（is-collapsed month 断言由子代理同步更新）
- [x] Batch C 后：trellis 视图 unicode 图标清零；SVG 光学对齐已过 check 子代理审查（真机截图属后续手动 QA）
- [x] 全部完成后：`npm test` 全量 11045/10979/20 = 基线，零回归

## 回滚点

实现代码为单个 commit（四批改动同文件深度交织，拆 hunk 风险大于收益；整体验证 0 回归后一并提交）；spec / skills / 任务 artifacts 各自独立 commit。出问题 revert 实现 commit 即可整体回滚。
