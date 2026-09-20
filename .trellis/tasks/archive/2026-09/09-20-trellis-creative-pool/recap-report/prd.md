# Trellis 日报（recap 联动）

## 背景与范围

创意池 v1 的收官项。Trellis 任务的生命周期（今天开了几个任务、完成了
几个、各阶段停留时长）没有沉淀，任务一归档就消失。本任务把 Trellis
维度接入 `src/recap-metrics.js` 的小结体系：

- 日报增加 Trellis 段：今日新建 / 完成（归档）任务数
- 数据口径：任务创建时间取 `task.json` createdAt；完成取归档目录出现
  时间（mtime），不落 prompt / 回复 / 任务内容以外的任何字段

## 约束（红线）

- **继承 recap 全部红线**（AGENTS.md Testing/Constraints 节）：
  - 指标能力只认 `src/recap-metrics.js` 显式口径，不从 event 推导
  - 不落任务标题、路径、prompt、回复；只落计数
  - 持久层只在 `~/.clawd/recap-v1/` 既有 HMAC 小票 / daily 结构上
    扩展字段，不新建存储、不加网络、不加导出
  - `null` 是不支持，不渲染成 0；无 .trellis 时不产生该段
- Trellis 状态文件读取只在 recap 计算时（低频），不做常驻 watcher

## 验收标准

- [ ] 小结出现 Trellis 段：今日新建 N / 完成 M（真实数字，无任务时整段隐藏）
- [ ] 不落任何任务内容字段（检查持久化 JSON 结构）
- [ ] `npm test` 失败集与基线一致；recap 相关单测过
