# v7 R10: 规范/关联并入左栏分组

## 用户需求（三轮反馈定稿）

不是按钮、不是面板切换：在左栏「计划/执行/检查/归档」分组**下面新增两个分组**：
- **规范**分组：展开列出 spec 文件行；点击行 → 右栏显示文档内容
- **关联**分组：展开列出关联组条目；点击 → 右栏显示该组详情（成员可跳转）

## 改动
- 删 project bar 的 📐/⛓ 按钮与 panelOpen 的 spec/network 槽位（⚙ 管理抽屉保留）
- buildTrellisSplitSection 追加两个分组（默认收起、展开懒加载：
  首次展开拉 getTrellisSpecTree / getTrellisNetworkOverview）
- spec 行：标题=relPath，副行=行数/待填/⛓N 徽标；点击 → 右栏 detail host 渲染
  spec 文档（复用 spec doc fetch/markdown 渲染）
- 关联组行：父→子 / 共享规范 / 共享 PRD 各一行；点击 → 右栏渲染组详情，
  成员点击跳转 selectTrellisSplitTask
- 删 buildTrellisSpecCard 槽位替换、buildTrellisNetworkPanel、spec-split CSS

## 验收
1. 左栏六个分组；规范/关联默认收起，展开后行可点，右栏出内容
2. 无 📐/⛓ 按钮、无面板切换
3. npm test 失败集与 HEAD 一致
