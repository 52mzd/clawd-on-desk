# Quality Guidelines

> 无 lint 配置、无 TS。质量线 = node --check + Node 内置 test runner + 基线 diff 纪律。

---

## 提交前检查线

1. **语法**：`node --check src/<file>.js`（每个改动文件；html/css 无工具，靠 review）
2. **定向测试**：`node --test test/<相关套件>.test.js`
3. **全量 + 基线 diff**（仓库有 39 个预存红，必须比对而不是看绝对数）：

   ```bash
   npm test 2>&1 | grep "^✖" | sed 's/ ([0-9.]*ms)$//' | sort > /tmp/fail-now.txt
   git stash -q && npm test 2>&1 | grep "^✖" | sed 's/ ([0-9.]*ms)$//' | sort > /tmp/fail-base.txt
   git stash pop -q
   diff /tmp/fail-base.txt /tmp/fail-now.txt   # 必须为空
   ```

   一次性 flaky（codex-log-monitor 并发时序）单跑确认全绿即可判预存。

## 渲染器测试

- **不引 jsdom**。行为断言走两路：
  - `test/dashboard-trellis-panel.test.js`：view-model 纯函数直测
  - `test/session-renderer-behavior.test.js`：**预存红**（stash 基线同红不算新增）；
    renderer 主体（DOM 构建/overlay 流程）依赖手动真机冒烟（dev app 重启 + 用户验收）
- 新增纯逻辑（parser/状态推导）提为可导出模块（`trellis-checklist.js`、
  `trellis-phase.js` 形态）进单测；DOM 胶水不留测试债

## 真机冒烟

dev 实例重启法（macOS 本机）：

```bash
kill <ownerPid from ~/.clawd/runtime.json>   # 或 pkill -f "Electron \."
npm start & sleep 10
python3 -c "import json;print(json.load(open('$HOME/.clawd/runtime.json'))['ownerPid'])"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:23333/state   # 200 = 健康启动
```

## Review 硬线

- `git diff -- src/ | grep "^+" | grep console.log` 必须为空（debug 残留）
- `git diff -- src/ | grep "^+" | grep -iE "innerHTML"` 逐个核对：静态常量模板豁免，
  任何含运行时插值的必须改 createElement
- CSS 类新增后核对「定义 ↔ renderer 引用」双向存在（死 CSS / 裸类名）
