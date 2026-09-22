# IPC Guidelines

> 渲染↔主进程唯一通道形态：preload contextBridge + session-ipc.js 统一 handler。

---

## 新增通道检查单（照 dashboard:trellis-* 家族形态）

1. **handler 全部在 `src/session-ipc.js`**：统一 `rejectUntrustedDashboardEvent` 信任帧
   检查（sender + senderFrame 双验）。不要在 main.js 里单独 `ipcMain.handle`
2. **严格 payload**：键集合精确匹配（单键/双键），多键少键类型错一律 `{status:"invalid"}`
   且**绝不触达 owner**：

   ```js
   const keys = payload && typeof payload === "object" && !Array.isArray(payload)
     ? Object.keys(payload).sort() : [];
   if (keys.length !== 2 || keys[0] !== "cwd" || keys[1] !== "taskPath" || …) {
     return { status: "invalid" };
   }
   ```

   原型污染探针（`__proto__` 键）必须被 `Object.keys` 路径拒绝——已测。
3. **api 依赖注入**：session-ipc 通过 `requiredDependency(options.getXxx)` 收主进程实现
   （main.js 的 api 表）；owner 缺失返回 `{status:"error", message:"xxx-unavailable"}`，
   不 throw
4. **preload 暴露**：`preload-*.js` 里一行 `ipcRenderer.invoke("channel", payload)`，
   不做任何解析
5. **磁盘读写的真正 owner 在 activity/store 模块**（如 `trellis-activity.js`），handler
   只做校验转发。路径类参数在 owner 侧二次校验（信任 root / 逐段白名单），handler 的
   payload 校验是第一道不是唯一一道

## 测试契约

每个新通道必须有两个测试（照 `test/session-ipc.test.js` 既有形态）：

- 信任帧矩阵：无 senderFrame / sender 不匹配 / 帧对象不同 → error envelope + `calls==[]`
- payload 矩阵：null/string/number/array/缺键/多键/空串/`__proto__` → `{status:"invalid"}`
  且 stub owner 断言零调用

通道清单变更时同步 `test/session-ipc.test.js` 的 owned-channels 断言（字母序）。
