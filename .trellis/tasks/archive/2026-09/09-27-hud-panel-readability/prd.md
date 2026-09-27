# HUD 面板可读性与整面触发

## Goal（用户 2026-09-27 真机反馈）

1. 面板字体小、可读性差——面板行 10px / 次要 9px，比 HUD 主体系（12px 主体/10-11px 次要）小两档
2. 交互应为"点击整个 HUD 就展开面板"，而不是瞄准 trellis chip
3. 用户提示"整个 HUD 要重新设计下"——范围待确认（面板 only vs HUD 全局字号）

## 已确认事实

- HUD 字号体系（session-hud.html）：主体 12px（:40）、行内次要 10-11px、徽标类 9-10px
- 本任务面板现状：行 10px / side 9px / 段头 9px / 查看全部 9px——全部低于主体系
- 高度契约：会话行 = HUD_ROW_HEIGHT 28px 固定（computeHudHeight），面板走 §4.1 弹性实测——**放大面板字号不碰行高公式**
- HUD 既有点击交互：会话行点击 = 跳终端（focusSession，原版核心）、chip 点击、pin 按钮、行内 open-folder 按钮——"点整个 HUD 展开"不得劫持行点击

## Requirements（草案）

1. 面板字号对齐 HUD 主体系（行 12px、side/段头 10-11px），间距/色点同步放大
2. HUD 容器空白区域（非会话行/非按钮）点击 → toggle 面板；展开锚定最近活跃的绑定会话；chip 点击保留为第二入口
3. 无绑定会话时点空白不产生面板（现状）

## Key Decisions（2026-09-27 用户确认）

1. **范围 = b：HUD 全局字号重设计**——主体 12→14px（token 化 --hud-fs-main/sub/badge = 14/12/11），行高 28→34，四宽度常量同比放大
2. **整面触发**：HUD 空白区域点击 toggle 面板；会话行点击保持跳终端；chip 保留第二入口；锚定最后绑定会话
