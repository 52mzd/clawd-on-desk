# Implement：多装检测修订

前置：`git status` 确认（.trellis/.pi 脏文件常态不动）；改动全在 `src/trellis-cli.js`、
`src/settings-tab-trellis.js`、`src/settings.css`、`src/settings-i18n.js` + 三份测试。

## 步骤

- [x] 1. `src/trellis-cli.js`：`compareVersions`（简化 semver，解析失败 0）+ 导出
  - 验证：`node --check src/trellis-cli.js`
- [x] 2. `src/trellis-cli.js`：`readGlobalVersion` 收集后统一定 `outdated`
  （newest = 可解析版本最大者；严格旧才 true；null/同版本 false）
  - 验证：`node --check src/trellis-cli.js`
- [x] 3. `src/settings-i18n.js`：`trellisCliInstallActive`/`trellisCliInstallExtra` 文案改 +
  新键 `trellisCliInstallLatest`，7 语言
  - 验证：`node --check src/settings-i18n.js`
- [x] 4. `src/settings-tab-trellis.js`：行结构改两行容器（徽标矩阵 + 独立版本 +
  outdated 行命令文本 + 复制按钮）；缺 outdated 字段降级
  - 验证：`node --check src/settings-tab-trellis.js`
- [x] 5. `src/settings.css`：`.trellis-cli-install-row/-cmd` 垂直居中、cmd 行缩进与
  mono/ellipsis、版本与命令文本弹性布局
  - 验证：`node --check src/settings-tab-trellis.js`（结构未破坏）
- [x] 6. 测试：`test/trellis-cli.test.js`（compareVersions 用例 + installs outdated 归属
  用例改写）、`test/trellis-ipc.test.js`（fixture 加 outdated）、
  `test/settings-tab-trellis.test.js`（徽标矩阵/命令可见/复制/降级）
  - 验证：`node --test test/trellis-cli.test.js test/trellis-ipc.test.js
    test/settings-tab-trellis.test.js`
- [x] 7. 全量回归：`npm test`
- [x] 8. 实机冒烟：模拟 launchd PATH 跑 `readGlobalVersion` 双装 fixture——0.3.10 标
  outdated、0.7.0-beta.4 标最新、命令文本进面板（vm 走查）
- [x] 9. spec 更新：`.trellis/spec/guides/trellis-panel-contract.md`——installs entry 加
  outdated、compareVersions 契约、徽标语义（Clawd 当前使用 ≠ 系统真相）、「可清理 =
  版本旧而非 PATH 序」红线、Tests 行
  - 验证：`grep -n "outdated" .trellis/spec/guides/trellis-panel-contract.md`

## 收尾

- 提交：单 commit `fix(trellis): 多装检测修订——可清理判定改版本新旧、清理命令可见、行内对齐`（中文，Co-Authored-By 尾行；只 add 本任务 src/test/spec 路径，提交前核对
  `git diff --cached --stat`）
- 注意 `.trellis/` 与 `.pi/` 既有脏文件不入提交（memory: trellis-dirty-files-stay-local）
- 完成后 `/trellis:finish-work` 归档 + journal
- 重编 x64 包供 x86 实机验证

## 回滚点

- 每步独立可退；最坏 revert 单 commit，无存储迁移
