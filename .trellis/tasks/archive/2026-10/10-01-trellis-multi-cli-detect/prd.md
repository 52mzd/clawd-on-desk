# PRD：多 trellis CLI 检测与清理向导

## 背景

10-01-trellis-cli-roots-unify 交付了「设置页亮出实际命中的 CLI 路径」。x86 实机验证后
用户反馈：路径小字能显示，但只显示**首个命中**——机器上还有第二个安装（化石 0.3.10）
时用户看不到它，只能凭终端 `which -a` 自己找。要求升级为全量检测 + 清理向导。

用户原话（需求源）：
1. 能显示路径小字，建议如果扫描到其他路径，一起显示并给出清理无用的向导
2. Dashboard 项目已出现（上任务 backfill 生效，与本任务无关）
3. 原方案第 3 点（手动删化石后重启验证）不做了，靠本需求的向导闭环

## 需求

### R1 全量安装检测

- 扫描 `augmentedCliPath` 候选 PATH 的**全部**目录，收集所有 trellis 安装
  （不只首个命中）
- 每个安装取一次版本（`<绝对路径> --version`，复用形状锚定解析）
- PATH 顺序首个命中标记「生效」，其余标记「多余（可清理）」
- 设置页全局卡片：多装（≥2）时列表展示全部安装（生效 ✓ + 多余 ⚠ + 版本 + 路径）；
  单装时保持现状（一条路径小字，无列表）

### R2 清理向导（只给命令，不执行）

- 对每个「多余」安装生成清理命令并给复制按钮（复用 buildCopyButton）：
  - npm 布局（realpath 命中 `<prefix>/lib/node_modules/@mindfoldhq/trellis/`）：
    `npm uninstall -g @mindfoldhq/trellis --prefix <prefix>`
  - prefix 目录用户不可写 → 命令前加 `sudo`
  - 非 npm 布局回退：`rm -f <bin路径>`（同样按写权限定 sudo）
  - 无法判定（realpath 失败等）→ 不渲染按钮
- **红线：app 绝不执行删除/uninstall**——命令只显示 + 复制，用户到终端自己执行

## 非目标

- 不检测 npm/bun/pnpm 之外包管理器的 trellis 安装元数据（按目录探测 + realpath 足够）
- 不自动清理、不弹确认删除对话框
- 不改 Dashboard 侧任何东西

## 验收标准

- [ ] 双装环境（fixture 模拟）：scan 返回 `global.installs` 两条，active 正确，
      版本各对应自身
- [ ] 设置页多装渲染：列表两行（✓ 生效 + ⚠ 多余带版本）+ 多余行有复制按钮，
      按钮点击后剪贴板含清理命令
- [ ] 单装环境：无列表无向导（现状行为不变，向后兼容）
- [ ] `global` 既有字段（installed/version/path/error）语义与现状一致——
      `installs` 是纯增量，老 fake（无 installs）UI 不渲染向导
- [ ] 清理命令：npm 布局生成 uninstall + --prefix；/usr/local 类不可写 prefix 带
      sudo；用户目录 prefix 不带 sudo；非 npm 布局 rm 回退；realpath 失败无按钮
- [ ] app 零删除执行路径：源码无任何「执行清理命令」的调用点（静态可查）
- [ ] 定向测试 + 全量 `npm test` 全绿
