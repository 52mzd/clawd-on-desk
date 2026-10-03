# Trellis 深度整合 idea pool v6

## Background

2026-09-27 基于 Trellis v0.6 官方文档（docs.trytrellis.app）+ GitHub mindfold-ai/Trellis 注入原理盘点（deepwiki），识别出 clawd 尚未整合的 Trellis 能力面。盘点结论：

- **已整合**：只读流程感知（会话绑定/phase/progress/nextStep）、HUD 徽标+详情行、idle/阶段/庆祝气泡、Dashboard 全家桶（活跃树/归档/spec 地图/关联网络/详情卡/roots 管理/项目筛选）、Settings（安装向导/CLI 升级/项目升级）、recap trellis 段、planning 帽/juggling 化身。
- **A（channel 协作可视化）已单独立任务**：`.trellis/tasks/09-27-trellis-channel-visibility`。
- 本池收纳暂不动工的候选 B / D。

## 候选清单

### B. trellis mem 跨会话历史入口（中高价值 / 高风险）

- **交付形态**：任务详情卡"相关历史会话"入口（回答"这任务当初为什么这么定"），或 recap 嵌入历史决策摘要。
- **数据面**：`~/.claude/projects/`、`~/.codex/sessions/`、`~/.pi/agent/sessions/` 的原始对话 JSONL（`trellis mem` CLI 的数据源）。
- **风险**：① 各平台 JSONL 是私有格式 = 版本化契约（同类教训：`.template-hashes.json` 上游契约漂移，见 trellis-panel-contract.md「解析外部工具的状态文件」节）；② 走 CLI spawn 打破 trellis-activity 零 spawn 红线，需按 trellis-cli.js 既有契约另立通道（信任门/argv 冻结/超时）。
- **前置**：A 落地后的 home 目录数据源信任面经验可复用。

### D. 任务写操作——宠物当工头（高产品价值 / 最高成本）

- **交付形态**：桌宠右键菜单/快捷气泡直接 create / finish / archive 任务。
- **数据面**：spawn `python3 task.py`（argv 形态必须向 `--help` 取证——参照 09-27 `--tag` 事故：位置参数被 CLI 静默忽略）。
- **风险**：① 打破整个 Trellis 面板的只读红线（trellis-panel-contract「只读感知」Scenario）；② 与 AI 会话对同一 task.json 的双写竞态；③ 每个写动作需要确认门，桌宠高频交互下容易变成打扰。
- **前置**：等 A 落地 + 只读面稳定后再评估；若做，从幂等的 finish/archive 起步而非 create。

## Non-Goals

- 本池不排期；动工时逐条拆独立子任务，不直接实现池内条目。
