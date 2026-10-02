# Implement: 清理三平台 CI 测试债

按类分批，每批可独立验证。**只动 test/，不动 src/、不动 workflows。**

## 批次 1 — D 类：upgradeGlobal dist-tag 用例自包含（mac+linux 债）

- [x] `test/trellis-cli.test.js:727` "passes a known dist-tag as `--tag <tag>`"：按同 describe `:707` 用例模式改造——`makeBinDir()` + handler 以 `[binPath]` 键应答 `--version` + `cliWith(stub, { env: { PATH: binDir } })`，断言保持 `calls[1].args` deepStrictEqual `["upgrade","--tag","beta"]`（calls[0] = before 探测，calls[1] = upgrade，序列确定化）。（实现偏离：makeBinDir+`env.PATH` 在 win 宿主上 POSIX 扫描恒空→calls[1] 仍 undefined；改为注入 `platform:"win32"` 走 shell-fallback 探测，三平台序列一致、断言原样不变）
- [x] `test/trellis-cli.test.js:734` "treats null the same as omitted"：同上模式，断言 `["upgrade"]`。（同上：platform:"win32" 注入）
- [x] 验证：`node --test test/trellis-cli.test.js`（mac 本地全绿）。（68 pass / 0 fail / 0 skip）

## 批次 2 — A 类：POSIX 扫描语义用例 win32 宿主 skip（12 个）

- [x] `test/trellis-cli.test.js` 文件顶部（helper 区）加一个 helper：`const itPosixScan = process.platform === "win32" ? it.skip : it;` 并注释理由（scanTrellisBinPaths 的 POSIX ":" 分割 + X_OK 语义在 win32 宿主的 fs/path.join 上不可能成立；win32 生产路径 win32→[] 不走此扫描）。
- [x] 将 12 个用例的 `it(` 换成 `itPosixScan(`：459 "parses a version with a v prefix…"、476 "reports the resolved binary path…"、485 "lists every install…"、531 "never flags an unparsable…"、561 "reports a failed spawn…"、575 "keeps installed true but version null…"、583 "reads the CLI version, not the project version…"、602 "reads the CLI version from the other banner branch too"、711 "runs trellis upgrade and re-reads the version"、836 "returns the first executable trellis…"、850 "skips a trellis without the execute bit…"、876 "collects every executable trellis in PATH order"。
- [x] 逐个核对行号对应用例名与 CI 失败清单一致（行号会随批次 1 改动漂移，以用例名为准）。（12 个用例名逐一对应，grep 计数 itPosixScan=12）
- [x] 注意：批次 1 已把 727/734 改为显式 PATH（不再依赖宿主），它们**不进** skip 名单；711 在 win 上挂的原因也是 POSIX 扫描（before/after 各一次 readGlobalVersion 扫描真实 PATH）→ 进入 skip 名单。（727/734 采用 platform:"win32" 注入而非 PATH fixture，同样不进 skip 名单）
- [x] 验证：mac 本地 `node --test test/trellis-cli.test.js` 全绿且 skip 数为 0（mac 上 helper 等价 it）。

## 批次 3 — B 类：H1 shell 注入回归 win32 宿主 skip（1 个）

- [x] 先读 `test/trellis-cli.test.js:342` 用例与 `:320-370` 上下文，确认其语义为「在非 win32 宿主上以 shell:true 真实 spawn 验证 win32 拼接不执行注入」。
- [x] win32 宿主 skip（helper `itNotWinHost = process.platform === "win32" ? it.skip : it`，注释：win 宿主上真实 cmd.exe 的 payload 生命周期与 POSIX spawn 模型不同，该回归的证明力仅存在于 POSIX 宿主）。（机理：cmd.exe 把 `;` 当参数分隔符，payload 天然死链，sanity 断言必挂）
- [x] 验证：`node --test test/trellis-cli.test.js`。

## 批次 4 — C 类：跨平台路径断言宿主感知（5 处）

逐个读用例与被测代码后修，**期望值跟随宿主构造，不硬编码不放松**：

- [x] `test/trellis-roots.test.js:56`：读 `src/trellis-roots.js` 的 normalize 语义；若 normalize 有意用宿主 path（生产输入永远是本机真实路径），期望值改用与被测模块相同的 path 构造。（normalizeRootPath = path.normalize 去尾分隔符，宿主感知；期望改 `path.join("/proj", "b")`，与文件既有风格一致）
- [x] `test/trellis-activity.test.js:306`：期望路径改 path.join 构造；sanitized 项目名（`-proj-app` vs `D--proj-app`）优先复用被测模块导出的 sanitize 函数生成期望，若无导出则按平台条件构造并注释依据（Claude Code 在 Windows 把盘符编入 sanitized 目录名属真实上游行为）。（claudeProjectsDirName 未导出，测试内联同规则 replace 链 + path.resolve(CWD) 动态构造，盘符不硬编码）
- [x] `test/recap-trellis.test.js:184`：读 fixture 的 fs stub key 路径形态，统一为 path.join 构造，保证 win 宿主 key 匹配。（被测对 roots 先 path.resolve（win 加盘符）再 path.join，stub key 从 `path.resolve("/proj/.trellis")` 派生）
- [x] `test/trellis-archive.test.js:156`：同上。（archiveBase 字面量直传不做 resolve，首层 readdir key 保持字面量；子层 key path.join 构造）
- [x] 验证：`node --test test/trellis-roots.test.js test/trellis-activity.test.js test/recap-trellis.test.js test/trellis-archive.test.js`。

## 批次 5 — 全量与 CI 验证

- [x] `npm test` 全量 0 fail（mac）。（12235 tests / 12171 pass / 0 fail / 64 既有 skipped）
- [x] `node --check` 不需要（无 src 改动）；git diff 确认只碰 test/。（本任务改动仅 5 个 test/*.test.js；工作区另有 trellis CLI update 产生的 .trellis//.pi/ 无关未提交变更，未触碰）
- [ ] 推验证分支 `ci/test-debt-cleanup` 到 fork，`gh workflow run test.yml --ref ci/test-debt-cleanup`，三 job 全 success。（主会话执行）
- [ ] 若 Windows 仍有残余失败：拉日志归因——属新暴露的环境依赖则按同类原则补修，属疑似 src 真 bug 则记录证据停止并回报。（主会话执行）

## 回滚点

每批一个 commit（`test: ...`），CI 验证失败可按批回退。全部通过后合 main，观察 main push 的 test.yml 转绿。
