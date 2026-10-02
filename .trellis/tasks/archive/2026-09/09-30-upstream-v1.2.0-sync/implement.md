# Implement: 上游 v1.2.0 同步

- [x] 1. `git merge origin/main --no-edit` 停在 6 处冲突
  - 验证：`git status` 显示 exactly 6 个 conflict 文件
- [x] 2. 按裁决表解冲突（design.md 冲突裁决表）
  - 验证：`git diff --check` 无冲突标记残留；`grep -c '<<<<<<<' -r` 为 0
- [x] 3. package-lock version 校正 + `npm install`
  - 验证：install 无 error；`git diff --stat` lock 无大范围意外变更
- [x] 4. `node --check` 全部冲突改动文件 + 语义复核 AGENTS.md
  - 验证：全部通过
- [x] 5. `npm test` 全量
  - 验证：全绿（重点：release-version-contract / trellis-* / session-* / state*）
- [x] 6. `node scripts/verify-release-contributors.js` fork 口径复核
  - 验证：不劣于合并前行为（fork 版本 pre-release 路径）
- [x] 7. 重启 dev app 冒烟（杀掉旧实例 → npm start → 截屏验证）
  - 验证：桌宠在、HUD 在、SpecRune 仍识别（09-30 修复不回退）
- [x] 8. 提交 merge（记录裁决要点）+ journal
  - 验证：`git log` 顺序正确；.pi/.trellis 脏文件未被裹挟（核对暂存区）
