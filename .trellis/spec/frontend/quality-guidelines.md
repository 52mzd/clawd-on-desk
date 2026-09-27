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
- **vm stub 属性分歧（09-28 教训）**：行为套件的 vm `FakeElement` 是手写 DOM
  子集，renderer 代码读到 stub 未实现的标准属性（实测：`childElementCount`）时
  **不报错、静默 undefined**——`!el.childElementCount` 恒真，空态门槛在有内容时
  也追加空提示，测试与生产 DOM 分歧却绿灯。规则：renderer 新读一个标准 DOM
  属性，同步给 FakeElement 补实现（getter 形态）；写「不出现空态」类负向断言
  前，先确认 stub 真的实现了门槛读的那个属性

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

## Manifest 消费纪律（09-27 教训）

`implement.jsonl` / `check.jsonl` 里 curate 的 spec 是**实现输入**，不是任务收尾的仪式：
动工前通读清单里每一份。check 阶段若发现自己引用过但没读过的 spec，按流程违规处理。

实录：`trellis-detail-command` 裸类名（renderer 引用、CSS 无定义）违反本文「CSS 类定义↔
引用双向存在」硬线，而本文当时正躺在 check.jsonl 里未被实现阶段读过——直到复查补读才
被抓（0a26a9b6）。教训不是"加一条硬线"（硬线本来就在），而是**引用≠消费**：把 spec 写进
manifest 的那一刻不等于它进入了实现者的工作记忆。
