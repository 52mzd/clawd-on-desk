# Design：HUD 全局字号重设计 + 整面触发

## 1. 字号 token 体系（session-hud.html）

| Token | 值 | 替换现值 | 用途 |
|---|---|---|---|
| `--hud-fs-main` | **14px** | 12px（:40） | 会话行主体（标题/路径） |
| `--hud-fs-sub` | **12px** | 10-11px（:154/:189/:232/:249/:264/:301/:447） | 次要文本（时间/别名/面板行/side） |
| `--hud-fs-badge` | **11px** | 9-10px（:291/:315/:326） | 徽标/段头/查看全部 |
| 面板 | 对齐 token | 10/9px → main/sub | trellis-panel-row 用 --hud-fs-main |

全部 12 处 `font-size` 改引 token；`:root` 定义一次。色点 6px→7px、行内间距同步放宽。

## 2. 尺寸常量联动（session-hud.js）

| 常量 | 现值 | 新值 | 理由 |
|---|---|---|---|
| `HUD_ROW_HEIGHT` | 28 | **34** | 14px 字 + 上下留白（+2px 领先字高增长） |
| `HUD_WIDTH` | 240 | **270** | 字号 +2px → 行内容变宽，+30px 防截断 |
| `HUD_WIDTH_COMPACT` | 190 | **215** | 同比 |
| `HUD_WIDTH_LABELS` | 320 | **355** | 同比 |
| `HUD_WIDTH_LABELS_COMPACT` | 260 | **290** | 同比 |
| `HUD_BORDER_Y` | 2 | 2（不动） | 边框描边常量与字号无关 |

- zoom/textScale 机制不动：`applyZoomToWindow` 乘在 CSS 基值上，基值放大后 zoom 语义不变；`HUD_WIDTH_GROWTH_RATIO` 不动。
- `computeHudReservedOffset` 默认值随 `HUD_ROW_HEIGHT` 自动联动（引用同一常量）。

## 3. 整面触发（session-hud-renderer.js）

- `hudEl`（容器）上监听 click：`event.target` 未落在交互元素（会话行 `.hud-row`/按钮/chip/pin）内时 → toggle 面板
- 展开锚定：`expanded` 会话中**最后一个有 trellis 绑定者**（最近活跃）；无绑定 → 无操作
- chip 点击保留（同一 toggle，stopPropagation 已有）
- 判定方式：DOM 向上冒泡检查最近交互祖先（closest 不可用时手动向上走——vm DOM 无 closest）

## 4. 测试联动

- `test/session-hud.test.js`：6 处 `expectedHudContentBounds`（width 240/height 28 → 270/34）+ computeHudHeight 用例数值
- `test/session-hud-style.test.js`：新增 token 存在断言（:root 定义三 token + font-size 引用 token 而非裸值）
- 行为测试：空白点击 toggle（vm 里 hudEl dispatch click，target 为容器自身）→ 面板开

## 5. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 行高 34 在小屏多会话时 HUD 变高 | HUD 高度本就按行数线性，弹性上限由屏幕 workArea 约束（computeSessionHudBounds clamp 既有） |
| 旧 pref 的 window bounds 不匹配 | HUD 是无持久化 bounds 的悬浮窗（按 hitRect/anchor 即时计算），无迁移面 |
| 面板 280px max-height 相对新字号偏小 | 同步上调至 320px |
| 回滚 | 单提交 revert（CSS token + 常量 + 断言数值集中） |
