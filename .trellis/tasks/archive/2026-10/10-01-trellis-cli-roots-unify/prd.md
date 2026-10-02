# Trellis CLI 发现修复三连：PATH 扩充、亮出 CLI 路径、Settings→Dashboard 目录互通

## Goal

实机案例（用户 x86 Mac，2026-10-01）：`~/.npmrc` 把 npm prefix 配成 `~/.npm-global`，
trellis 0.7.0-beta.4 装在那里；`/usr/local/bin` 还留着旧 prefix 时代的 0.3.10 化石。
GUI app 的 PATH 补偿列表只认识 `/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`，
于是 Clawd 永远调用化石 CLI——版本显示 0.3.10、`upgrade` 命令不存在。同时用户在
Settings 加的扫描目录（prefs `trellisScanRoots`）Dashboard 完全看不见（Dashboard 读
独立的 `~/.clawd/trellis-roots.json`），体感为「加了目录但面板全空」。

三个修复打包：

1. **PATH 扩充**：`augmentedCliPath` 覆盖常见 JS 包管理器的全局 bin 目录
2. **亮出 CLI 路径**：Settings → Trellis 面板显示实际命中的 trellis 二进制路径
3. **目录互通**：Settings 扫描目录发现的项目根单向同步注册进 Dashboard rootsStore

## Requirements

### R1 PATH 扩充（`src/trellis-cli.js`）

- 追加固定目录（POSIX only，win32 行为不变）：`~/.npm-global/bin`、`~/.bun/bin`、
  `~/Library/pnpm`、`~/.volta/bin`
- 枚举 `~/.nvm/versions/node/<v>/bin`：每个已装的 node 版本目录都追加，新版本优先
- 新目录一律**追加在现有列表之后**：已能命中的环境行为不变（向后兼容）
- 目录不存在时静默跳过；去重保持现有语义
- 不引入 deno 等无 trellis 安装惯例的目录（避免 speculative）

### R2 亮出 CLI 路径（cli 层 + IPC 透传 + Settings UI）

- `readGlobalVersion()` 返回值新增 `path` 字段：按**与 spawn 完全相同的 PATH**
  逐目录解析出的第一个可执行 `trellis` 的绝对路径；找不到为 `null`
- win32 上 `path` 恒为 `null`（spawn 走 shell 解析 `.cmd`，fs 定位无意义）
- Settings → Trellis 全局 CLI 卡片：版本号旁以弱化小字显示该路径（有值才显示），
  无新增 i18n 文案键（路径本身非文案）
- scan 信封透传不加新通道：`global` 对象整体已透传，字段追加即可

### R3 目录互通（单向喂新，不级联删除）

- 用户在 Settings 保存扫描目录（`settings:trellis-set-roots`）成功后：扫描出的
  **installed === true** 的项目根（bare `.trellis/` 不算）逐个注册进
  `_trellisRootsStore`，duplicate/limit 静默忽略；有任何新注册时推送
  `dashboard:trellis-roots-changed`
- app 启动时对存量 `trellisScanRoots` 做一次同样同步（修复已配置用户），不推送事件
- **删除不级联**：Settings 移除扫描目录不动 rootsStore（roots 是 Dashboard 独立
  资产，可能还来自面板 picker 或会话发现；级联删除会误伤）
- 同步是尽力而为：扫描失败/部分失败不阻塞 `set-roots` 返回 ok

## Acceptance Criteria

- [ ] `~/.npm-global/bin` 等四个固定目录出现在 `augmentedCliPath` 产出的 PATH 尾部
      （POSIX）；win32 输出与现状逐字节相同
- [ ] `~/.nvm/versions/node/` 下每个版本目录的 `bin` 都被追加，目录缺失/不可读时
      不抛错、输出不含空段
- [ ] 现有三个目录仍排在新目录之前（现有命中的环境不变）
- [ ] `readGlobalVersion()` 在 POSIX 下返回 `path`（含 symlink 目标可达性检查）；
      找不到/非 POSIX 为 `null`
- [ ] Settings 全局 CLI 卡片渲染版本行时，`global.path` 有值则显示路径文本
- [ ] `settings:trellis-set-roots` 成功后同步回调被调用；仅 installed 项目被注册；
      duplicate 幂等；不级联删除
- [ ] 启动时存量同步执行一次，不推送 roots-changed
- [ ] 全量测试通过；`.trellis/spec/guides/trellis-panel-contract.md` 补记新契约

## Constraints

- KISS/最小修改：不合并两套存储（rootsStore 独立文件设计保留），不动
  `trellisScanRoots` 的 prefs schema
- 同步逻辑可测：`trellis-ipc` 通过注入回调解耦（不直接持有 rootsStore）
- 外发内容（若未来 PR）中文；本任务只落 fork main
