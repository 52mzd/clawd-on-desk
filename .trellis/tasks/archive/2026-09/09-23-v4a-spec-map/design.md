# v4-a 规范地图 技术设计

## 复刻基线

完全复刻 `dashboard:trellis-task-doc` 四层链路（v3 已验证）：

```
trellis-activity.readTaskDoc → main.js api 表 getTrellisTaskDoc
  → session-ipc.js handle("dashboard:trellis-task-doc", 校验)
  → preload-dashboard.js 暴露 → dashboard-renderer.js fetch + renderMarkdownDoc
```

## 模块边界

### 1. `src/trellis-activity.js` — 新增两个读函数

- `readSpecTree(cwdOrRoot)`：列该 root 下 `.trellis/spec/**/*.md`
  - root 必须通过现有信任谓词（与 readTaskDoc 同一入口校验，避免平行实现）
  - 递归深度帽 3 层、文件数帽 200、返回 `[{path, group}]`（group = 一级目录名，根文件 group="spec"）
  - 缺 spec 目录 → `{status:"ok", files:[]}`
- `readSpecDoc(cwdOrRoot, relPath)`：读单个 spec 文档
  - relPath 严格校验：非空 string、`/` 分隔、无 `..` 段、无反斜杠、必须 `.md` 结尾、normalize 后仍以 `spec/` 开头
  - 大小帽复用 task doc 同一常量（不新造数字）
  - 成功 → `{status:"ok", content, truncated}`；文件超帽 → truncated（同 task doc 语义）

### 2. `src/main.js` — api 表两项

- `getTrellisSpecTree: (payload) => _trellisActivity.readSpecTree(payload.root)`
- `getTrellisSpecDoc: (payload) => _trellisActivity.readSpecDoc(payload.root, payload.relPath)`
- `_trellisActivity` 缺失时返回既有 `{status:"error", message:"trellis-activity-unavailable"}`（与邻居一致）

### 3. `src/session-ipc.js` — 两个 handler

- `dashboard:trellis-spec-tree`：payload 严格单键 `{root:string}`，非 string 拒绝
- `dashboard:trellis-spec-doc`：payload `{root:string, relPath:string}` 双键严格
- 校验失败 → 既有 error envelope 形态

### 4. `src/preload-dashboard.js` — 暴露

```js
getTrellisSpecTree: (payload) => ipcRenderer.invoke("dashboard:trellis-spec-tree", payload),
getTrellisSpecDoc: (payload) => ipcRenderer.invoke("dashboard:trellis-spec-doc", payload),
```

### 5. `src/dashboard-renderer.js` — Spec 浏览面板

- Trellis 视图工具行加「规范」按钮（roots 管理区旁）
- 面板复用 trellis detail overlay 的容器/遮罩/关闭模式；左栏文件列表（按 group 分段）、右栏 `renderMarkdownDoc(trellisDocBuilder, content)`
- 多 root：顶栏 root 徽标切换（复用项目 chip 形态）；单 root 不渲染切换器
- 缓存：`Map<root+relPath, {loading, result}>`，面板关闭全清（同 trellisDetailDocs 语义）
- 零开销：面板未开 = 无 fetch、无渲染

### 6. i18n — 七语言键

`dashboardTrellisSpecTitle` / `dashboardTrellisSpecEmpty` / `dashboardTrellisSpecLoadFailed` / `dashboardTrellisSpecRoot`

## 安全边界（不放松）

- spec 内容渲染走 `renderMarkdownDoc` 白名单构建器：script/onerror/javascript: 全惰性文本（v3 已测，不重造）
- 路径穿越：relPath 分段校验 + normalize 后前缀断言，两层都过才算数
- 只读：不提供任何写入通道

## 兼容性

- 新增通道不改既有通道 payload；listTrellisRoots 响应不动
- spec 目录不存在/为空是常态（不是错误）——返回空列表，UI 显示空态文案

## 回滚

单提交独立；回滚 = revert 该提交，无数据迁移、无存储格式变化。
