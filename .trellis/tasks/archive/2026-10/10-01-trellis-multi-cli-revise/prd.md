# PRD：多装检测修订——判定改版本新旧、命令可见、对齐修复

## 背景

10-01-trellis-multi-cli-detect 落地后 x86 实机（双装：`/usr/local/bin` 0.3.10 化石 +
`~/.npm-global/bin` 0.7.0-beta.4）验证反馈四点。核心问题：**「多余」判定基于 PATH 首命中，
但那个 PATH 序是 GUI 拼的增强序（`/usr/local/bin` 排在 `~/.npm-global/bin` 前），与用户终端
PATH 序相反**——把用户终端真正在用的 `~/.npm-global` 版本错标成「多余（可清理）」。若当初
自动清理，删掉的就是在用版本。

## 需求

- **R1（反馈 3+4，判定语义修正）**：「可清理」判定从「非 PATH 首命中」改为「存在更新版本」
  ——版本旧的才标可清理；版本解析失败（null）保守不标；同版本多装互不标。判定在 cli 层
  完成（readGlobalVersion 收集完全部版本后统一定），随 installs entry 以 `outdated` 布尔
  下发，renderer 纯渲染（沿用 D0 架构红线）。
- **R2（反馈 4，徽标语义澄清）**：原「生效」徽标保留 `active` 字段但改文案为「Clawd 当前
  使用」——明确它是 app 视角（GUI 拼的 PATH 首命中），不是终端/系统真相。
- **R3（反馈 2，命令可见）**：可清理行的 cleanup 命令文本渲染出来（mono 小字、可选中、
  ellipsis + title），复制按钮贴在旁边——复制什么一目了然。
- **R4（反馈 1，对齐修复）**：安装行内徽标/路径/版本/按钮垂直居中对齐；命令文本独立成行
  （缩进），避免单行挤爆。

## 约束

- 清理命令**只显示 + 复制，app 零执行**红线不变。
- renderer（vm 沙箱）零命令生成、零版本比较逻辑——全部判定在 cli 层。
- 单装/缺 installs 字段零渲染（向后兼容）不变。
- KISS/DRY/最小修改：只动判定字段、行渲染结构、CSS 与 i18n 文案，不动扫描/清理命令生成。

## 验收标准

- [ ] 双装（0.3.10 + 0.7.0-beta.4，任意 PATH 序）：0.3.10 行标「旧版（可清理）」并显示
      cleanup 命令 + 复制按钮；0.7.0-beta.4 行标「最新」；`active` 行额外带「Clawd 当前
      使用」徽标——PATH 序翻转只换 active 归属，不换 outdated 归属
- [ ] 版本 null 的安装永不标 outdated；全部同版本时无人标 outdated
- [ ] 命令文本在面板上可见（不是只进剪贴板）
- [ ] 行内元素垂直居中（flex align-items: center）
- [ ] 单装、缺 installs、缺 outdated 字段的旧 payload：零渲染/优雅降级不报错
- [ ] 定向测试全绿 + 全量 `npm test` 0 fail
- [ ] spec trellis-panel-contract.md 同步（outdated 契约、版本比较器、徽标语义）
