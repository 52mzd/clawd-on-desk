# PRD: 多装列表条目格式规格化（第四轮）

## 背景

单行版实机反馈（用户给出完整格式规格）：「换行以后的文字要对齐上面的检测到有x个CLI安装的位置；优先显示最新版本在最上面；格式：1.最新 版本号：xxx 安装路径：xxx；换行 2.旧版（建议清理） 版本号：xxx 安装路径：xxx；换行在下面显示清理代码，复制按钮名称为复制旧版代码」。

## 需求（R1–R5）

- **R1 排序（cli 层）**：`readGlobalVersion` 的 installs 按**版本新→旧**排序下发（稳定排序；版本不可解析/比较返回 0 时保持原序）。renderer 在 vm 沙箱零 require、无 compareVersions，排序必须留在 cli 层（D0）。active 判定（PATH 首命中）与 payload 字段不变。
- **R2 行格式（renderer）**：每条一行行内文字流：`序号.` + 标签胶囊（最新=绿 / 旧版（建议清理）=amber）+ `版本号：<v>` + `安装路径：<p>`（mono，超宽 ellipsis）。条目行与标题 desc 行左缘同一起点（同一容器、无缩进）。命令块仍挂旧版条目下，缩进+底色不变。
- **R3 移除 active 徽标**：用户格式只有「最新/旧版（建议清理）」两态标签——「Clawd 当前使用」不再渲染（payload 的 active 字段保留，契约不变）。
- **R4 i18n ×7（en/zh/zh-TW/ko/ja/pt-BR/es）**：新键 `trellisCliVersionLabel`（版本号：）、`trellisCliPathLabel`（安装路径：）、`trellisCopyCleanup`（复制旧版代码）；`trellisCliInstallExtra` 文案改为「旧版（建议清理）」语义。
- **R5 测试**：settings-tab 主用例改断言行内 DOM 序（含序号、label 键、版本、路径；active 不再出现；复制按钮 = trellisCopyCleanup）；trellis-cli 双装用例加「版本降序」断言（PATH 序相反时数组翻转、active 标记跟条目走）；legacy/单装用例适配。

## 约束（不变项）

- D0：outdated/active/cleanup/排序全在 cli 层；renderer 纯渲染。
- 清理命令只显示+复制绝不执行；win32 installs 恒 []；缺 outdated 旧 payload 降级。

## 验收标准

- [x] trellis-cli 测试：双装 PATH 序=旧→新时 installs 数组=新→旧，active 仍标首命中
- [x] settings-tab 测试：行内断言锁 [序号, 标签, 版本号label+值, 路径label, 路径值]，复制按钮 trellisCopyCleanup
- [x] `npm test` 全量 pass
- [x] spec 三处更新（Signatures installs 顺序、闭环段 UI 格式、Tests 表）
