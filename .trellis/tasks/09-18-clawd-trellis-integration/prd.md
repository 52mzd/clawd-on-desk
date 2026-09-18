# Clawd Trellis 管理面板（多项目版本巡检 + 升级）

## Goal

在 Clawd 内提供一个 Trellis 管理面板：用户选择一个（或多个）目录，面板扫描其下的项目，显示每个项目是否安装了 Trellis、当前版本，并支持单个/一键批量升级项目内 Trellis；同时显示本机全局 Trellis CLI 版本、查询远程最新版本并可一键升级。

## 背景事实（已验证）

- 项目侧版本真相：`<project>/.trellis/.version`（内容如 `0.7.0-beta.3`）；该文件**不在** `.trellis/.gitignore` 中，随项目提交，可作可靠判据。
- 项目是否装了 Trellis：存在 `<project>/.trellis/` 目录且内含 `.version` / `scripts/`。
- 全局 CLI 版本：`trellis --version`；远程版本：`npm view @mindfoldhq/trellis dist-tags --json` →
  `{ latest: "0.6.17", beta: "0.7.0-beta.4", rc: "0.6.0-rc.0" }`。
- 升级项目内 Trellis：`trellis update`（项目目录为 cwd）。非交互选项 `-f/--force`（覆盖冲突文件）、`-s/--skip-all`、`-n/--create-new`（生成 `.new` 待合并）。
- 升级全局 CLI：`trellis upgrade`。
- 实测耗时：`trellis update --dry-run` 约 **1.1s/项目**（含联网），`npm view` 约 **0.94s**（一次可拿全通道）。→ 扫描必须分层，批量升级必须并发 + 逐项进度。
- **平台配置真相 = `<project>/.trellis/.template-hashes.json` 的 `hashes` 键前缀**（剔除 `.trellis` / `AGENTS.md` / `.agents`）。实测：全平台项目 23 个顶层目录、`recorded` 得 21 个平台前缀，与 `trellis platforms` 输出的 21 条**完全一致**，零差异。
- **新增平台的官方命令是 `trellis init --<platform> -y`，绝不能带 `-s`/`-f`**。受控实验（同一项目、已有 `.claude`+`.pi`+用户本地改动）：

  | 命令 | 结果 |
  | --- | --- |
  | `trellis init --gemini -y` | `.gemini` 新建、旧平台保留、用户改动保留、记录变成**并集**、走 `handleReinit` 增量（`Tracking 153 files`） |
  | `trellis init --gemini -y -s` | `.gemini` 新建，但记录**被重建为 `.gemini .trellis`**，走 full init（`Tracking 48 files`） |
  | `trellis init --gemini -y -f` | 同上，记录同样被重建 |

  `-s` / `-f` 会**绕过增量分支**，退化到全量 init 并从零重建记录 —— 这才是"记录缩水"的真正原因，不是 CLI 的缺陷。
- `trellis init --<flag> -y` **是幂等的**：重复执行输出 `○ Gemini CLI already configured, skipping`，记录保持并集不变。
- **`trellis update` 不接受 `-y`**（实测 `error: unknown option '-y'`）；可用选项仅 `-f/--force`、`-s/--skip-all`、`-n/--create-new`，**没有平台参数**。
- **`trellis update --dry-run` 不是只读的**：项目 `.version` 与 CLI 版本不一致时它会改写 `.trellis/.version`（受控实验：`0.6.0` 与 `0.5.0` 都被写成 `0.7.0-beta.3`）。严禁在生产路径用它做“预览”。

## Requirements

### R1 目录选择与持久化

- 面板提供目录选择器，用户可添加/移除扫描根目录。
- 扫描根列表持久化到 prefs（`trellis.scanRoots: string[]`），重启后保留。
- 无任何扫描根时展示空态引导，而不是空白列表。

### R2 项目发现与列表

- **扫描深度：只扫所选根目录的直接子目录**（用户已确认），不递归；不跟随符号链接。
- 每行至少展示：项目名、绝对路径、当前版本、目标版本、状态（最新 / 可升级 / 未知）。
- **扫描根的直接子目录全部列出**，并标注"已安装（含版本）"或"未安装"——这正是用户要的"查看目录下面的项目是否安装了 Trellis"。未安装项不提供升级入口。
- 跳过噪声目录：以 `.` 开头的隐藏目录、`node_modules`。
- 列表支持刷新，刷新不得阻塞 UI。

### R3 版本比对与通道推断

- 远程版本一次查询、多项目复用（不为每个项目各查一次 npm）。
- 通道推断规则：项目版本含 `-beta` → 比对 `beta`；含 `-rc` → 比对 `rc`；否则比对 `latest`。
- 允许用户覆盖通道选择（全局或逐项）。
- 通道/远程查询失败时，只降级该项的"是否可升级"判定为"未知"，**不得**把未知渲染成"已最新"。

### R4 单项目升级

- 每个可升级项目提供独立升级入口。
- 升级执行 `trellis update --force`，cwd 为目标项目目录。
- 升级前可预览（见 R9）；预览为可选步骤，不是升级的前置阻塞。
- 升级前提示该项目文件将被改写；升级后重新读取 `.trellis/.version` 并更新该行状态。

### R5 一键批量升级

- 提供"全部升级"入口，对当前列表中所有"可升级"项执行升级。
- 并发受控（建议 2–4），避免 npm / 磁盘争抢。
- 逐项目实时反馈：等待中 / 进行中 / 成功（旧版本 → 新版本）/ 失败（含原因）。
- 允许中途取消；取消后已完成项保持已升级状态，未开始项不再启动。
- 单项失败不得中断整批；批次结束给出汇总（成功 N / 失败 M）。

### R6 全局 Trellis CLI 版本与升级

- 展示本机全局 `trellis` CLI 版本，并与远程 `latest`（或用户选定通道）比对。
- 提供"升级全局 CLI"入口，执行 `trellis upgrade`，展示结果与新版本。
- 若 `trellis` 不在 PATH / 未安装，展示明确引导与安装命令，而非报错堆栈。

### R7 面板宿主与文案

- 面板宿主：**Settings 内新增 `trellis` tab**（用户已确认）。
- 所有新增用户可见文案需覆盖 `SUPPORTED_LANGS` 全集：`en / zh / zh-TW / ko / ja / pt-BR / es`（**7 种，无 zh-CN**）。
- 文案必须 7 种语言 key 顺序、类型、占位符、函数 arity 完全对齐，否则 `test/i18n.test.js` 的 locale parity 断言失败。

### R8 平台感知与选择

- 面板每个项目行需展示该项目**已配置的 Trellis 平台**（如 Claude Code / Codex / Pi）。
- 判定依据：读 `<project>/.trellis/.template-hashes.json` 的 `hashes` 键，取第一段路径前缀，剔除 `.trellis` / `AGENTS.md` / `.agents`，得到平台目录前缀，再经 21 项映射表转为平台 id/显示名。**只读盘、零 spawn**（不调用 `trellis platforms`）。
- **(a) 筛选**：提供平台多选控件（用户诉求：选择是 codex 还是 pi 还是 claude 这类的），列表只显示"已配置平台"命中选中集合的项目。
- **(b) 限定升级范围：不可实现**。实测 `trellis update` 没有平台参数，只同步记录里登记的平台；禁止用"临时改写平台目录"伪造限定。
- **(c) 新增平台**：用户可为某个项目**补装**未配置的平台。
  - 执行 `trellis init --<platform> -y`（**只带 `-y`，绝不带 `-s`/`-f`**），cwd = 项目路径。
  - 这是与"升级"并列的**独立用户动作**，必须显式点击，且**必须走 R9 预览**。
  - **不与升级合并**：批量升级永远只跑 `trellis update`，绝不隐式 init。
  - 执行后以磁盘为准复核实际新增的平台。
- 不在映射表内的前缀（Trellis 未来新增平台）**必须原样保留**为 `unknown:<prefix>` 并展示，不得丢弃或猜测成已知平台。
- 平台清单与映射以 Trellis 注册表为准，共 **21 个平台**：`claude-code / cursor / opencode / codex / kilo / kiro / gemini / antigravity / devin / qoder / codebuddy / copilot / droid / pi / reasonix / zcode / trae / omp / grok / kimi / snow`。
- 实测事实：`trellis init --claude --pi` 后再 `--gemini`，`.claude` / `.pi` 目录**原样保留** → 追加式新增在 CLI 侧成立且幂等。

### R9 升级预览（纯只读）

- 提供预览能力：在真正升级前，让用户看到“将会发生什么”。
- 预览内容：项目名/路径、平台列表、当前版本 → 目标版本、**将执行的精确命令**（如 `trellis update --force`，cwd = 项目路径）。
- **预览必须零写盘、零 spawn**：不得调用 `trellis update --dry-run`（实测它会写 `.trellis/.version`）。

### R10 平台记录一致性（轻量诊断）

- 平台列表完全来自 Trellis 自己的记录文件（R8），**不引入独立探测逻辑**。
- 唯一附加诊断：若某平台目录（映射表内的 `dirPrefix`）在磁盘上不存在、但记录里仍在，标为 `staleRecord`，行内提示"记录与实际文件不一致，可重新运行 init 修复"。
- **Clawd 不得改写该记录文件**；如需修复只提供可复制的 `trellis init --<platform> -y` 命令。

## Constraints

- **绝不自动升级。** 任何写操作必须由用户显式点击触发；不得后台静默升级项目或全局 CLI。
- **预览零写盘。** 预览路径不得 spawn 任何进程，**尤其禁止 `trellis update --dry-run`**：实测该命令在项目版本与 CLI 版本不一致时会写 `.trellis/.version`，已污染测试仓库。
- **最小写入面。** Clawd 自身只新增代码与 prefs 字段；扫描为只读，不得写入被扫描项目。
  写操作只有两个，且都只能由用户显式点击触发：
  1. `trellis update --force`（升级）
  2. `trellis init --<platform> -y`（新增平台，**只带 `-y`**；带 `-s`/`-f` 会绕过增量分支并重建记录）
  除此之外 Clawd 不得写任何被扫描项目的文件。
- **只对确认含 `.trellis/` 的目录执行升级**，绝不猜测、绝不向父/子目录扩散。
- **禁止 shell 字符串拼接。** 所有外部命令用 `execFile` 风格数组参数传入，路径不得进入 shell 解释（防止含空格/特殊字符/引号的路径被注入）。
- 扫描不得跟随符号链接越出所选根目录；避免扫入 `node_modules`、`.git` 等大目录。
- 并发上限固定且可配置；任一时刻不得无限并发子进程。
- 失败必须保留原始 stdout/stderr 供用户查看，并给出可操作的下一步；不得吞掉错误。
- 遵循项目既有约定：prefs 走 schema + `migrate()`（当前 `CURRENT_VERSION = 20`），settings 写入必须经 `settings-controller.js`，IPC 由主进程 runtime 工厂注册。

## Acceptance Criteria

- [ ] 用户能预览升级（看到平台、当前 → 目标版本、将执行的命令），且预览前后 `shasum` 全项目对比无任何文件变化。
- [ ] 用户在面板添加一个目录后，其下所有含 `.trellis/` 的项目被列出，版本号与 `cat <project>/.trellis/.version` 一致。
- [ ] 扫描根在重启 Clawd 后仍保留。
- [ ] 远程版本查询在一次刷新中只发生一次（可用日志/计数验证），而非每项目一次。
- [ ] 对落后项目点击单项升级后，该项目 `.trellis/.version` 被 `trellis update --force` 写为新版本，列表行刷新后与磁盘一致。
  - **实测澄清**：真实 CLI 写回的是 **CLI 自身版本**（如 0.7.0-beta.3），不是 channel 的 `target`（如 latest 0.6.17）。因此判据是"行显示的版本 == 磁盘 `.version`"，**不是**"== target"。
- [ ] "全部升级"对 N 个落后项目并发执行且并发数不超上限；其中 1 个失败时其余仍完成，并给出成功/失败汇总。
- [ ] 取消批量升级后不再启动新项目，且不产生半写状态。
- [ ] 全局 CLI 区显示真实 `trellis --version`；远程比对正确；升级入口可执行并回显新版本。
- [ ] `trellis` 未安装时显示引导文案，无未捕获异常。
- [ ] 含空格与特殊字符的目录路径能被正确扫描与升级（无注入、无路径截断）。
- [ ] 无用户点击时，任何项目的 `.trellis/` 内容不发生改变（自动升级不发生）。
- [ ] 无扫描根 / 目录不可读 / npm 离线三种降级路径均有明确 UI 反馈。
- [ ] 新增文案在全部受支持语言中均有对应条目（缺失 key 不裸露到 UI）。

- [ ] 平台列表读自 `.template-hashes.json`，与 `trellis platforms` 输出一致（21 平台全配置项目下两条路径结果相同）。
- [ ] 记录里出现表中不存在的未来平台前缀时，面板原样展示 `Unknown (<prefix>)`，不丢弃也不误判。
- [ ] 新增平台：执行 `trellis init --gemini -y` 后 `.gemini` 出现、面板平台列更新、原有平台目录与用户改动完好。
- [ ] 新增平台后记录变为**并集**（旧平台仍在），且重复执行同一新增命令输出 `already configured, skipping` 且记录不变。
- [ ] 新增平台的预览展示"将新增平台 / 将执行命令"，且未点击确认前不产生任何写入。
- [ ] Clawd 在任何路径下都**未改写** `.template-hashes.json`（该文件只由 Trellis CLI 写）。

## Open Questions

- ~~Q1 面板宿主~~ → **已定：Settings 内新增 `trellis` tab**。
- ~~Q2 扫描深度~~ → **已定：只扫所选根的直接子目录**。
- **Q3 刷新时机** → 已定：纯手动刷新。不引入启动时任务、定时器或 watcher；进入 tab 不自动联网。
- **Q3.5 预览** → **已定：支持预览，但预览必须纯只读**（不 spawn 任何进程）。用户原话“Q4 升级策略要支持预览”。
  - **关键实测发现**：`trellis update --dry-run` **不是只读命令** —— 当项目 `.version` ≠ CLI 版本时，它会**写入 `.trellis/.version`**（受控实验复现：`0.6.0` → `0.7.0-beta.3`，`0.5.0` → `0.7.0-beta.3`，仅这一个文件变化）。
  - 因此：**禁止在生产路径调用 `--dry-run`**。Clawd 的“预览”改为**纯计算**（版本对比 + 平台列表 + 将执行的命令），零写盘。
- ~~Q4 升级策略~~ → **已定：MVP 只用 `--force`**，UI 不开放策略选择器。
- ~~Q5 是否提供 `trellis init`~~ → **已改：提供**（见 R8(c)，用户答复"可以选择升级，或者新增平台"）。未安装 Trellis 的项目本身仍不做 init（只做平台级新增）。
- **Q6** R8 平台选择语义 → **已定：(a) 筛选 + (c) 新增平台**（用户答复「C，可以选择升级，或者新增平台」）。
  - **(b) 不可行**：实测 `trellis update` 无平台参数（仅 `-f/--force`、`-s/--skip-all`、`-n/--create-new`，且不接受 `-y`）。
- **Q7（已定，结论与初稿相反）** `trellis init` 新增平台**只带 `-y`**，**既不带 `-s` 也不带 `-f`**。
  - 三组受控实验（同一项目、已有 `.claude`+`.pi`+用户改动，追加 `--gemini`）：
    `-y` → 增量 `handleReinit`（`Tracking 153 files`），记录变并集；
    `-y -s` 与 `-y -f` → 均**绕过增量分支**，退化为 full init（`Tracking 48 files`）并**重建记录为 `.gemini .trellis`**。
  - 因此：升级 `trellis update --force`；新增平台 `trellis init --<flag> -y`。**两条路径的 argv 常量必须分开定义。**

## Notes

- 本任务跨主进程（扫描/执行/IPC）、Settings UI、prefs、i18n 四个层面，属复杂任务：需补 `design.md` 与 `implement.md` 后方可 `task.py start`。
- 与 `00-bootstrap-guidelines` 无依赖关系。
- 命名建议：主进程模块 `src/trellis-scanner.js` / `src/trellis-cli.js` / `src/trellis-ipc.js`；UI `src/settings-tab-trellis.js`。
