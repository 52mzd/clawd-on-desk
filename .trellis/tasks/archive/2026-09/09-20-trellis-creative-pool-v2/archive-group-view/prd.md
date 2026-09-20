# 归档浏览与父子分组（⑤+⑥）

## 范围

1. **⑤ 归档任务浏览**：Dashboard Trellis 面板加"归档"折叠区：最近
   N（=20）个归档任务列表（标题、完成日期、耗时 createdAt→completedAt），
   点击可开 task-detail-view 的详情卡片（只读，数据来自归档目录）
2. **⑥ 父子分组**：活跃面板按 parent 分组渲染：父任务为组头（标题+
   子任务进度汇总 n/m），子任务缩进为组内行；无 parent 任务平铺

## 约束

- 归档列表按需读取（展开折叠区时单次 IPC 请求，同 detail 模式），不常驻
- task.json 已有 `parent` 字段（v1 任务树用过 task.py --parent，确认
  scanner 解析面）；孤儿子任务（parent 不在活跃集）平铺不报错
- 分组渲染纯函数化（dashboard-trellis-panel.js 扩展），单测覆盖
- 归档目录扫描复用 recap-trellis.js 既有遍历逻辑（提取共享，DRY）
- 7 语言新键全补；无归档/无任务时各区隐藏

## 验收

- [ ] 折叠区列出最近归档任务（含完成日期/耗时），点击开详情
- [ ] 父子任务分组渲染正确；孤儿平铺
- [ ] recap 遍历与归档列表共享同一实现（无复制）
- [ ] 7 语言；npm test 失败集与基线一致
