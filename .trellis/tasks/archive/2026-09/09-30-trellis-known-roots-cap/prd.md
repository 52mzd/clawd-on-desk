# 修复 Trellis 已注册项目被 32 上限静默截断

## Goal

把 trellis-activity 的 `KNOWN_ROOTS_MAX` 与 trellis-roots 的 `MAX_ROOTS` 对齐。注册面允许 64 个 root、消费面只认前 32 个的不一致，让第 33+ 个注册项目（实测 SpecRune，索引 32）在 Dashboard 的任务列表（readActiveList）、归档浏览（readArchiveList）与 HUD 面板非 anchor 项目（readHudTaskPanel）中静默消失——注册成功但永远不生效，无任何提示。

## 背景事实（2026-09-30 实测）

- `~/.clawd/trellis-roots.json` 现有 34 个注册 root；`collectKnownRootCwds()`（src/trellis-activity.js:246-253）`slice(0, KNOWN_ROOTS_MAX=32)` 把 SpecRune（索引 32）与 spec++（索引 33）截掉。
- 边界精确吻合：索引 31 的 write-notes-like-deepseek 在 readArchiveList 中可见，索引 32 的 SpecRune 不可见。
- 数据格式全部兼容：readTaskDetail/readSpecTree/HUD anchor 面板对 SpecRune 均正常，缺的只是"行"的生成。
- 截断按注册顺序，新注册的项目最先被截——用户视角即"新加的项目识别不了"。

## Requirements

- 消费面上限与注册面上限保持一致：单一常量来源，不出现两处各自维护的数字（DRY）。
- 扫描保持有界：上限仍是一个有限值（= MAX_ROOTS），不是无界枚举。
- 注册超限的行为不变：`trellis-roots.js` 的 add/recordPick 仍按 MAX_ROOTS 拒绝。
- 最小修改：只动常量来源与引用点，不改 collectKnownRootCwds 的结构（persistedRoots 优先 + rootCache 去重补齐的顺序语义保持）。

## Acceptance Criteria

- [x] `KNOWN_ROOTS_MAX` 不再独立写死 32：与 `trellis-roots.js` 的 `MAX_ROOTS`（导出为 `TRELLIS_ROOTS_MAX`）同源。
- [x] 单测：注册 34 个 root 时，`readActiveList`/`readArchiveList` 能覆盖第 33、34 个 root 的任务（用 fake fs 构造索引 32 的项目）。
- [x] 单测：注册数超过 MAX_ROOTS 时仍被 add 拒绝（既有行为回归保护）。
- [x] 既有 trellis-activity / trellis-roots 相关测试全绿。

## Notes

- SpecRune 与 spec++ 当前真实环境即处于被截断状态，修复后无需用户任何操作即可恢复识别。
- spec 更新：`.trellis/spec/guides/trellis-panel-contract.md` 覆盖 `src/trellis-*.js`，若其中有与 root 数量上界相关的契约描述需同步。
