# 等待授权桌宠态（②）

## 范围

Clawd 有权限请求 pending 时（permission bubble 可见 / 远程审批等待中），
若桌宠当前是 idle/working 且绑定的 Trellis 任务处于 executing，桌宠切换
到**等待态动画**（复用既有 wait 类素材，如 clawd-idle-reading 或主题
`waiting` 状态；不新增 REQUIRED_STATES）。

## 约束

- 不加新状态机状态：复用 `docs/guides/state-mapping.md` 既有等待类动画，
  通过显示层 override（同 juggling 升级模式：显示层后置调整，不动
  state-priority.js）
- 触发条件：存在 pending permission 请求（`src/permission.js` 的
  pending 状态有现成查询面）**且** pet state 当前非 sleeping/DND
- permission 决议后立即回落原状态
- 主题无等待类素材时静默降级为原状态（不报错）
- 与 DND 交互：DND 压住 bubble 时本功能同样不生效（DND 语义优先）

## 验收

- [ ] 权限请求出现 → 桌宠切等待动画；决议 → 回落
- [ ] sleeping/DND 时不触发
- [ ] 显示层 override 单测（触发/回落/降级三例）
- [ ] npm test 失败集与基线一致
