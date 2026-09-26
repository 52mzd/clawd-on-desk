# Design：Trellis 安装向导支持 `-u` 开发者身份

## 范围（已由用户确认）

- **只做 `-u, --user <name>`**，其他 init 参数不做
- **i18n 走方案 C**：向导现有 19 个 key + 新增 3 个 key，**各补 7 语言**

## 架构与数据流

```
Settings 渲染进程                                   主进程
┌────────────────────────────┐                    ┌──────────────────────────────────┐
│ settings-tab-trellis.js    │                    │ settings-tab-trellis-wizard.js   │
│  openAddPlatformWizard()   │                    │  renderAddSelect()  ← 输入框      │
│                            │                    │  state.userName     ← 跨阶段保持  │
└──────────┬─────────────────┘                    └──────────┬───────────────────────┘
           │  ① bridge.api.trellisUserSuggestion()  ← 新增（默认值探测，异步填入）
           │  ② bridge.api.trellisPreview({ paths, platforms, userName })
           │  ③ bridge.api.trellisAddPlatform(path, platforms, userName)
           ▼                                                 ▼
┌────────────────────────────────────────────────────────────────────────────────────┐
│ src/trellis-ipc.js   payload 校验 + 分发                                            │
│   settings:trellis-user-suggestion   ← 新增通道                                     │
│   settings:trellis-preview           ← payload 增加可选 userName                    │
│   settings:trellis-add-platform      ← payload 增加可选 userName                    │
└──────────┬─────────────────────────────────────────────────────────────────────────┘
           ▼
┌────────────────────────────────────────────────────────────────────────────────────┐
│ src/trellis-runtime.js   previewAddPlatforms / addPlatforms                          │
│ src/trellis-cli.js       resolveUserName()  ← 新增 helper（唯一回退链实现点）        │
│                          addPlatforms(projectPath, ids, { userName })               │
└────────────────────────────────────────────────────────────────────────────────────┘
```

## 契约（跨层）

> 详细的 7 段式契约在实现时补进 `guides/trellis-panel-contract.md`（该文件是 Trellis 外部进程契约的归属地）。

### IPC payload 变更

| 通道 | 现状 | 变更 |
|---|---|---|
| `settings:trellis-preview` | `{ paths, platforms?, channel? }` | **+ `userName?: string`**（可选，缺省走回退链） |
| `settings:trellis-add-platform` | `(path, platforms)` | **+ `userName?: string`**（可选） |
| `settings:trellis-user-suggestion` | — | **新增**，返回 `{ name: string }`（读不到时 `""`） |

### 统一回退链（唯一实现点）

```js
// src/trellis-cli.js
function resolveUserName(projectPath, candidate) -> string
// 顺序：normalize(candidate) → normalize(path.basename(projectPath)) → "clawd"
// normalize：trim；lone surrogate 丢弃；白名单 [\p{L}\p{N}\p{M}\p{So}_.\-]
//            （首字符不含 `.`）；拒绝 / \ 与整值 `..`；截断 64 code points
```

> 第二轮修订（H1）：原实现只拒绝 `/` `\` `..`，而 Windows 上 `run()` 用
> `shell: true`（Node 只拼接、不转义 argv），含 `;` / `&` / `|` / `$()` 的值可命令注入。
> 改为白名单后，含空格或任一 ASCII shell 元字符的名字一律回退目录名；中文/日文/韩文/emoji 仍可用。

**三处调用点共用**（`trellis-cli.js:316`、`trellis-ipc.js:84`、`trellis-runtime.js:205`）——
DRY，且保证回退语义不漂移。

### 默认值探测（`git config user.name`）

- 主进程 spawn `git config user.name`
- **`git` 位于 `/usr/bin/git`，launchd 默认 PATH 含 `/usr/bin`** → **无需 PATH 增强**
  （对照 `guides/trellis-panel-contract.md` 的 GUI PATH 契约：只有装在三方目录的 CLI 才需要）
- 失败 / 超时（3s）/ 空 → 返回 `{ name: "" }`，**绝不抛错阻塞向导**
- 主进程侧**进程内缓存**（同一 Settings 窗口生命周期内只读一次）

## UI 设计

### 显示条件与位置

| 项 | 决定 |
|---|---|
| 条件 | `state.project.installed === false`（首次 init） |
| 位置 | 平台列表**之后**、动作按钮**之前** |
| 跨阶段 | `state.userName` 保存输入值；从 preview `back` 回 select 时回填 |

### DOM 结构

```html
<div class="trellis-wizard-field" data-field="user">
  <label class="trellis-wizard-field-label" for="trellis-wizard-user">Developer name</label>
  <input id="trellis-wizard-user" class="trellis-wizard-input" type="text"
         data-user maxlength="64" placeholder="usually your git username">
  <p class="trellis-wizard-hint">
    Trellis creates .trellis/workspace/&lt;name&gt;/ as your personal workspace.
  </p>
</div>
```

**实现约束**（对齐 vm 沙箱）：

- 用 `<input data-user>`（与现有 `data-platform` 的取值方式一致）
- **不用 `insertBefore`**（vm 沙箱无此方法）—— 沿用现有整体 `innerHTML` 重建
- 默认值**渲染后异步填入**（`input.value = name`），**不异步化** `openAddPlatformWizard` 的调用链

### 预览阶段无需改动

`renderAddPreview` 已通过 `commandBlock(bridge, addPlan.command)` 显示命令；只要 runtime 收到 `userName`，
预览块就会显示 `-u <name>` —— **UI 侧零改动**。

## i18n（方案 C）

### 待补 key（22 个 × 7 语言）

**现有 19 个**（当前只在 `settings-tab-trellis-wizard.js` 的英文 `FALLBACK` 里）：

```
settingsTrellisWizardAddTitle / UpgradeTitle / SelectHint / Preview / ConfirmInstall
settingsTrellisWizardConfirmUpgrade / UpToDate / Running / Done / Failed
settingsTrellisWizardCancel / Close / Retry / CommandTitle / DryRunTitle
settingsTrellisWizardAddedPlatforms / NothingToAdd / ProjectLabel / VersionLabel
```

**新增 3 个**：

```
settingsTrellisWizardUserNameLabel
settingsTrellisWizardUserNameHint
settingsTrellisWizardUserNamePlaceholder
```

### 插入流程（必须遵守 i18n spec）

1. `grep -n` 定位 `settings-i18n.js` 中每个 locale 块（顺序固定：en → zh → zh-TW → ko → ja → pt-BR → es）
2. **整行锚定插入**：`^(\s*)keyName: "value",\s*$`（`^` 与 `$` 缺一不可）
   —— 09-25 事故：按值子串匹配会命中**另一键字符串内部**的相同文案，把新键拼进句子中间
3. 插完立即 `node --check src/settings-i18n.js`
4. 完整性校验：每个 key 出现 **7 次**
   ```bash
   for k in settingsTrellisWizardAddTitle … settingsTrellisWizardUserNamePlaceholder; do
     echo -n "$k: "; grep -c "$k:" src/settings-i18n.js
   done   # 每个都应为 7
   ```
5. 保留向导内的英文 `FALLBACK`（作为 `bridge.t` 不可用时的最后防线）

## 兼容与迁移

| 场景 | 行为 |
|---|---|
| 旧调用点未传 `userName` | 回退链兜住 → **与现状完全一致**（目录名） |
| 加平台（`installed === true`） | 不渲染输入框；`userName` 可缺省 |
| 现有测试 | payload 字段可选 → 不破坏；`trellis-cli.test.js` 的 `-u` 断言仍成立 |

## 权衡

| 决策 | 选择 | 备选与理由 |
|---|---|---|
| 默认值探测时机 | 渲染后异步填入 | 备选「异步化 `openAddPlatformWizard`」—— 改动调用链，收益小 |
| `userName` 传递 | IPC payload 可选字段 | 备选「专用通道」—— 过度设计 |
| 回退链实现 | `trellis-cli.js` 单一 helper | 备选「三处各写」—— 违反 DRY 且回退语义会漂移 |
| i18n | 整套补 7 语言（C） | A（只英文）违反 spec；B（只补新键）导致界面混搭 |

## 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| IPC payload 变更破坏现有测试 | 字段**可选**，缺省走回退链 | 单 commit revert |
| i18n 插入损坏文件 | 整行锚定 + `node --check` + 按语言块计数 | 同上 |
| `git config` 卡住向导 | 3s 超时 + 捕获 → 空值 + 进程内缓存 | 同上 |
| 输入值含路径分隔符 | `resolveUserName` 拒绝 `/ \ ..` 并截断 64 | 同上 |

## 不在本设计范围

- 其他 init 参数（`--monorepo`、`-t/--template`、`--with-statusline`、`-f`/`-s`）
- Settings 主页（非向导）的 `trellis*` key —— 它们已在 `settings-i18n.js`
- 把 `-u` 从加平台路径中移除（实测无风险）
