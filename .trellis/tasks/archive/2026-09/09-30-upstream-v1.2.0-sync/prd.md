# PRD: 同步上游 v1.2.0 并叠加二开重新编译测试

## 背景

上游 rullerzhou-afk/clawd-on-desk 已发布 v1.2.0（origin/main 领先本地 48 提交，
merge-base fa9bcaa4）。本地 main 为二开工作区（领先 298 提交：trellis 集成全套、
spec 体系、HUD/dashboard 面板、发版批次）。用户要求：主程序先同步最新上游源码，
再叠加二开，重新编译测试。

## 需求

1. `git merge origin/main` 进本地 main，保留 298 个二开提交与 48 个上游提交的全部历史。
2. 解决 6 处冲突（干跑 merge-tree 已勘明，裁决表见 design.md）。
3. 二开语义零回退：trellis 集成、HUD 面板、spec 体系、fork 发版口径全部保持。
4. 重新安装依赖、全量测试、重启 dev app 冒烟验证。

## 不做

- 不趁机重构/清理任何上游或二开代码（scope discipline）。
- 不向 fork 仓库 push（fork 只走导出发布，见记忆 trellis-dirty-files-stay-local / fork-re-export-procedure）。
- 不在本任务内做读取端分组 PR（后续独立任务，本次同步为其提供干净基线）。

## 验收标准

- [ ] `git merge origin/main` 完成，无未解决冲突标记（`git diff --check` 干净）。
- [ ] package.json version = `1.2.0-trellis.1.0`（上游 1.2.0 + 二开新基线）。
- [ ] `npm install` 后 lock 一致（无冗余 diff）。
- [ ] `npm test` 全量通过。
- [ ] `node scripts/verify-release-contributors.js` 在 fork 版本口径下通过（或维持
      fork 既有排除行为不劣化）。
- [ ] dev app 重启后：桌宠/HUD 正常、SpecRune 项目仍被识别（09-30 修复不回退）、
      Trellis 视图可用。
- [ ] 提交信息记录合并性质与冲突裁决要点。
