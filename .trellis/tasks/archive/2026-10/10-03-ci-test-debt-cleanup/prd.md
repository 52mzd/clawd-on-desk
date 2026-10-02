# PRD: 清理三平台 CI 测试债

## 背景

`test.yml`（push main / PR / manual 触发，ubuntu + macos + windows 矩阵跑 `npm test`）在 main 上**每次 push 都是 failure**（225fcc83 / a1dc98be / d7a4ea3a / 1fe97e82 全红），tag 触发的 Build & Release 全量测试同样红。发版被迫走 manual validation-only + attach 的旁路。

失败共 21 个用例，全部是**既有测试的隐式环境依赖**，与任何近期代码变更无关；本地 macOS（装有 trellis CLI、POSIX 路径）碰巧全绿所以一直未暴露。macOS/Linux 各失败 2 个，Windows 失败 19 个。

### 失败分类（run 37039478733 取证）

**A 类 · POSIX 扫描语义用例（trellis-cli.test.js，12 个）**：行 459/476/485/531/561/575/583/602/711/836/850/876。
`scanTrellisBinPaths` / `readGlobalVersion` 以 `platform:"darwin"` 运行时按 POSIX 语义 `split(":")` 分割 PATH 并检查 X_OK 执行位；用例依赖 `makeBinDir()` 在真实 fs 创建可执行文件。在 Windows 宿主上：`C:\Users\...` 的盘符冒号被 `split(":")` 切碎 + `path.join` 用反斜杠 + 无执行位语义 → 扫描恒空 → `installed:false / path:null / installs:[]` 断言全炸。Windows 生产路径本就不走该扫描（win32 → []），这批用例在 win 宿主上语义不可能成立。

**B 类 · win32 shell 真实执行用例（trellis-cli.test.js:342，1 个）**：H1 注入回归——在 POSIX 宿主上以 `shell:true` 真实 spawn 验证 argv 拼接安全性，前置断言 "payload must be live"。Windows 宿主上真实 cmd.exe 行为不同导致 payload 生命周期断言失败。该用例的语义是「在非 win32 宿主上模拟 win32 拼接」。

**C 类 · 跨平台路径断言（5 个文件位置）**：断言值硬编码 POSIX 路径形态，被测代码用宿主 `path` 模块：
- `test/trellis-roots.test.js:56`：actual `\proj\b` vs expected `/proj/b`
- `test/trellis-activity.test.js:306`：actual `\home\tester\...\D--proj-app\...` vs expected `/home/tester/.../-proj-app/...`
- `test/recap-trellis.test.js:184`：injected fs 扫描返回 null ≠ 期望对象
- `test/trellis-archive.test.js:156`：injected fs traversal 计数 0 ≠ 1

**D 类 · 隐式依赖本机 trellis（mac+linux 各 2 个）**：`trellis-cli.test.js:727/734` upgradeGlobal dist-tag 用例未传 `env.PATH` → 继承宿主 PATH → 断言 `calls[1]` 假设 before 探测发生过（本机装了 trellis 碰巧成立；CI 干净 PATH 无 trellis → calls 只有 1 条 → `calls[1]` undefined）。

## 需求

1. `test.yml` 三平台矩阵在修复合入 main 后全绿（绿 = conclusion success，允许因环境缺失的既有 skip，不允许新增 fail）。
2. 修复不得削弱既有断言的 bug 捕捉能力：A/B 类用例在 win32 宿主上 **skip 是可接受的**（语义不可能成立），但 POSIX 宿主上的覆盖必须原样保留；禁止为过 CI 改松断言值。
3. D 类必须让用例自包含（显式 `env: { PATH: <受控 binDir> }`，参考同 describe 内 `:707` "runs trellis upgrade and re-reads the version" 的既有模式），不依赖宿主环境。
4. C 类优先「期望值随宿主构造」（path.join / 复用被测模块的路径函数），保持跨平台验证语义；仅当 fixture 输入本身就是 POSIX-only 语义时才 skip。
5. 只改 `test/*.test.js`；`src/` 一律不动。若实现中发现疑似 src 真 bug（而非测试问题），停下记录证据并回报，不擅自改行为。

## 验收标准

1. 本地 `node --test test/trellis-cli.test.js test/trellis-roots.test.js test/trellis-activity.test.js test/recap-trellis.test.js test/trellis-archive.test.js` 全绿。
2. 本地 `npm test` 全量 0 fail（macOS 宿主）。
3. 推送验证分支后，以 workflow_dispatch 触发 `test.yml`（ref=验证分支）：ubuntu / macos / windows 三 job 全部 success。
4. skip 的用例必须在 CI 输出里以 skipped 计数可见（`it.skip` 形态），且每个 skip 处有注释说明「POSIX 扫描语义在 win32 宿主不成立 / win32 shell 模拟仅在 POSIX 宿主有效」类理由。
5. 既有断言除 D 类的 calls 索引自包含化外，其余断言值不变（C 类期望值改为宿主感知构造不算削弱）。

## 约束

- 修法遵循 `.trellis/spec/frontend/quality-guidelines.md`：无 lint 配置，质量线 = `node --check` + 定向测试 + 全量基线 diff。
- 验证回路：mac 本地跑；Windows/Linux 用 fork 的 `test.yml` workflow_dispatch @分支 验证（不占 main）。
- A 类 skip 判定用 `process.platform === "win32"`，集中为一个文件级 helper（避免 12 处重复三目）。
- 不新增测试文件；不改动 `.github/workflows/*`。
