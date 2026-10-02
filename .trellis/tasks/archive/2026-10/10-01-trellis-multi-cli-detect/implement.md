# Implement：多 trellis CLI 检测与清理向导

前置：`git status` 确认（.trellis/.pi 脏文件常态不动）；改动全在
`src/trellis-cli.js`、`src/settings-tab-trellis.js`、`src/settings.css`、
`src/settings-i18n.js` + 三份测试。

## 步骤

- [x] 1. `src/trellis-cli.js`：`scanTrellisBinPaths` 纯函数（全量收集，win32 → []）；
  `resolveTrellisBinPath` 重构为基于它（行为不变）
  - 验证：`node --check src/trellis-cli.js` && 既有 resolveTrellisBinPath 用例仍绿
- [x] 2. `src/trellis-cli.js`：`buildCleanupCommand`（realpath → npm 布局 uninstall /
  rm 回退 / W_OK sudo 判定 / shell quote）
  - 验证：`node --check src/trellis-cli.js`
- [x] 3. `src/trellis-cli.js`：`readGlobalVersion` 重构（全量收集 → 逐个 spawn
  `--version` → installs 数组；installed/version/error/path 取首命中，与现状语义
  对齐；无安装时 error:null）
  - 验证：`node --check src/trellis-cli.js`
- [x] 4. `src/settings-i18n.js`：7 语言加 3 键（trellisCliInstallsTitle /
  trellisCliInstallActive / trellisCliInstallExtra）
  - 验证：`node --check src/settings-i18n.js`
- [x] 5. `src/settings-tab-trellis.js` + `src/settings.css`：多装列表渲染
  （标题 + 行 + 复制按钮）与样式
  - 验证：`node --check src/settings-tab-trellis.js`
- [x] 6. 测试：`test/trellis-cli.test.js`（scanTrellisBinPaths / installs /
  buildCleanupCommand）、`test/trellis-ipc.test.js`（installs 投影）、
  `test/settings-tab-trellis.test.js`（多装渲染 + 复制 + 单装/缺字段不渲染）
  - 验证：`node --test test/trellis-cli.test.js test/trellis-ipc.test.js
    test/settings-tab-trellis.test.js`
- [x] 7. 全量回归：`npm test`
- [x] 8. 实机冒烟：本机 `npm start` → Settings → Trellis：单装环境无列表（现状
  不变）；必要时用 tmp 双 bin 目录 PATH 模拟多装走查渲染
- [x] 9. spec 更新：`.trellis/spec/guides/trellis-panel-contract.md`——
  readGlobalVersion 签名加 installs、scanTrellisBinPaths/buildCleanupCommand 契约、
  「清理命令只显示不执行」红线
  - 验证：`grep -n "installs" .trellis/spec/guides/trellis-panel-contract.md`

## 收尾

- 提交：单 commit `feat(trellis): 多 CLI 安装检测与清理向导——全量扫描、生效标记、可复制清理命令`（中文，Co-Authored-By 尾行；只 add 本任务 src/test/spec 路径，
  提交前核对 `git diff --cached --stat`）
- 注意 `.trellis/` 与 `.pi/` 既有脏文件不入提交（memory: trellis-dirty-files-stay-local）
- 完成后 `/trellis:finish-work` 归档 + journal
- 重编 x64 包供 x86 实机验证（多装列表 + 向导）

## 回滚点

- 每步独立可退；最坏 revert 单 commit，无存储迁移
