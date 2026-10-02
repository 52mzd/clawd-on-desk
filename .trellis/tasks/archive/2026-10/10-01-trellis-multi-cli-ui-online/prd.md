# PRD: 多装 CLI 列表单行编排——徽标回归路径行

## 背景

两行结构版（8ea7896e）实机反馈（截图 5.png）：「还是逻辑编排有问题，/usr/local/bin/trellis 和旧版字样以及版本号可以放在一行的，当前使用字样以及 /Users/Dae_1/.npm-global/bin/trellis 还有版本号也可以在一行。」——徽标独立成行把一条安装的完整信息（路径+状态+版本）拆到两行，需要上下扫视拼装；用户要求回到单行编排。

三轮反馈脉络：①第一版徽标行内右置（纯文字无形态）→「没对齐」；②两行结构（徽标独立行）→「逻辑编排有问题」；③本轮：单行 + 胶囊徽标紧随路径 + 版本唯一右置——对齐问题由 CSS 布局解决（版本右缘锚定），不牺牲单行直觉性。

## 需求（R1–R4）

- **R1 渲染块**：每个安装一行 `installRow` = 路径 + 徽标 + 版本号。徽标直接 append 到 installRow（rank 先、in-use 后，语义紧贴它描述的对象）；删除 `trellis-cli-install-badges` 独立容器。命令块（缩进+底色+复制按钮）保持不变。
- **R2 CSS 单行布局**：`.trellis-cli-install-row` gap 8→6px；path `flex: 0 1 auto`（不再占满，窄窗先收缩 ellipsis）；badge `flex: 0 0 auto`；version 加 `margin-left: auto`（唯一右置元素，右缘跨行对齐的前提）。删除 `.trellis-cli-install-badges` 规则；胶囊形态与三态配色（最新=绿 / 旧版=amber / Clawd 当前使用=accent，含 dark）不动。
- **R3 测试**：主用例 badgeRows deepStrictEqual 断言改为 installRows 行内断言——每行 children = [路径文本, 徽标文本..., 版本文本]，锁「徽标与路径版本同行 + rank 先于 in-use + 版本行尾」。既有扁平文本断言（installs:2、两路径、三徽标词、两版本、cleanup 命令）不变。
- **R4 spec 更新**：trellis-panel-contract.md GUI PATH 节「闭环」段 UI 描述 + Tests 表 settings-tab-trellis 行，改为单行结构表述。

## 约束（不变项）

- D0：outdated/cleanup/active 判定全在 cli 层，renderer 纯渲染；清理命令只显示+复制绝不执行。
- 缺 outdated 字段旧 payload 降级、单装/缺 installs 零渲染行为不变。

## 验收标准

- [x] `node --test test/settings-tab-trellis.test.js` 全 pass；新断言 deepStrictEqual 锁 DOM 序 [path, rank badge, in-use badge, version]
- [x] `npm test` 全量 pass（12020+）
- [x] spec 两处描述更新为单行结构
- [x] 视觉验收：路径左缘对齐、版本右缘对齐、徽标胶囊紧随路径
