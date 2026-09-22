# i18n Guidelines

> `src/i18n.js` 单文件七语言（en/zh/zh-TW/ko/ja/pt-BR/es）。新键七块全加，漏一块运行时丢文案。

---

## 加键流程

1. 在 **en 块**加键（锚定语义），紧随其后在其余六块各加同键
2. 七块都必须加——i18n.js 的取词是全 locale 平铺对象，缺键该语言下渲染空串
3. 提交前核对：

   ```bash
   for k in YourNewKeyA YourNewKeyB; do echo -n "$k: "; grep -c "$k:" src/i18n.js; done
   # 每个都应输出 7
   ```

4. renderer 侧取词 `t("dashboardXxxYyy")`；键名带模块前缀（`dashboardTrellis*` 家族）
   便于全局审计

## 反模式

- ❌ 只加 en/zh 就提交（其余五语言静默丢文案）
- ❌ 在 renderer 里写 fallback 英文串绕过 i18n（例外：`"…"` 加载态、`"✕"` 符号等
  语言无关字符可硬编码）
- ❌ 批量脚本按单行 pattern 替换 i18n/测试文件——locale 块内行重复率高，必须带
  上下文锚定（见 cross-layer guide Mistake 9）

## 大小与维护

i18n.js 约 4000 行（持续增长中），七块顺序固定（en → zh → zh-TW → ko → ja → pt-BR → es）。
新增 UI 功能一次通常 3–8 键 × 7 语言；用 Python 行号插入时先 `grep -n` 定位每个
locale 块的同键行，插完立即跑上面的完整性循环。
