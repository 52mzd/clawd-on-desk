# 向导 `-u` 作用域修正：加平台不带 `-u`

## 状态

in_progress（2026-09-27）—— **源码改动已完成并验证**，待同步测试断言与 spec。

## Goal

`-u` 只在**首次 init** 场景加入 argv；**加平台**（已 init 项目）不再带 `-u`。

## 背景（用户实测反馈）

用户对**已 init 的项目**点 Add platform 时，预览命令显示 `-u <目录名>`。

但加平台时 CLI 会**忽略** `-u`（`.developer` 已存在；实测给已 init 项目传别的名字，`.developer` 不变、也不新建 workspace），所以那个值是**纯噪音** —— 会让用户以为「我的身份被设成了目录名」。

而**官方文档**给加平台场景的命令本就不带 `-u`：`trellis init --cursor`。

（用户已确认这是**情况 B**：对话框里没有输入框，即已 init 项目 → 不是 bug，是设计需改进。）

## 已完成的源码改动（含行为验证）

| 文件 | 改动 |
|---|---|
| `src/trellis-cli.js` | 新增并导出 `buildInitArgs(projectPath, flags, options)`：`options.userName === undefined` → **不加 `-u`**；否则走 `resolveUserName` 回退链。`addPlatforms` 改用它 |
| `src/trellis-runtime.js` | `previewAddPlatforms` 改用它；import 清理 `INIT_ARGS` / `INIT_ARGS_SUFFIX` / `resolveUserName` |
| `src/trellis-ipc.js` | staleFixes 命令改用它（不传 userName → 不带 `-u`）；import 同步清理 |
| `src/settings-tab-trellis-wizard.js` | preview 与 install 都只在 `isFirstInstall()` 时带 `userName` |

**行为验证（已跑，通过）**：

```
加平台(无 userName)  : ["init","--gemini","-y"]              ← 不带 -u
首次 init(alice)     : ["init","-u","alice","--gemini","-y"]
首次 init(空→回退)   : ["init","-u","alpha","--gemini","-y"]  ← 回退到目录名
```

## 待办（本次范围）

1. **更新 8 个失败断言**，改为区分场景的期望：
   - `test/trellis-cli.test.js`：`argv contract`、`adds a platform with exactly [init, -u <name>, --gemini, -y]`、`threads options.userName into the init argv and keeps the folder fallback`、`resolveUserName fallback chain (09-27)`
   - `test/trellis-ipc.test.js`：`trellis IPC registration`、`trellis IPC preview and global upgrade`、`gives every stale platform its own read-only repair command`、`reports only the missing platform in the stale fix list`
   - `test/trellis-runtime.test.js`：`preview`、`preview with platforms returns the add-platform plan…`、`previews an added platform with the exact init command…`
   - `test/settings-tab-trellis-wizard.test.js`：`threads the developer name through preview, back and install (09-27)`、`carries the wizard's developer name into preview and install (09-27)`
   - `test/settings-tab-trellis-wizard-static.test.js`：`settings trellis wizard static guards (09-25)`
2. **新增用例**：加平台（不传 `userName`）的 argv **不含** `-u`；staleFixes 命令不含 `-u`
3. **更新契约**：`.trellis/spec/guides/trellis-panel-contract.md` 的「向导的开发者身份（-u）契约」Scenario —— 说明 `-u` 的作用域是**首次 init**，加平台不带
4. **全量 `npm test`** 与基线一致

## 验收标准

- **A1** 8 个失败测试全部通过，且新断言能**区分两种场景**（加平台无 `-u` / 首次 init 有 `-u`）
- **A2** 至少 1 条「加平台 argv 不含 `-u`」的显式断言（cli / runtime / ipc 各一更好）
- **A3** 全量 `npm test` 失败集合与 `/tmp/merge-final.txt` 逐行一致
- **A4** spec 的 `-u` 作用域描述与实现一致；`docs/project/trellis-settings-panel.md` 的 IPC 表若提到 `userName` 语义需同步

## Out of Scope

- 不改 `resolveUserName` 的回退链本身（首次 init 仍需要它兜底）
- 不给加平台场景补输入框（用户已确认不需要）
- 不把 `-u` 从首次 init 路径移除
