# i18n Guidelines

> `src/i18n.js`（dashboard 窗口）与 `src/settings-i18n.js`（settings 窗口）各为单文件七语言（en/zh/zh-TW/ko/ja/pt-BR/es）。新键七块全加，漏一块运行时丢文案。

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
- ❌ 按值子串定位插入点（09-25 事故）：`trellisUpgrade: "…"` 这样的值匹配正则会
  命中**另一键字符串内部**的相同文案（ja 的 trellisStaleFix 长句里含同样词），
  新键被拼进句子中间、整个文件语法损坏。插入/替换必须整行锚定：
  `^(\s*)keyName: "value",\s*$`（^ 和 $ 缺一不可），插完立刻
  `node --check` + 按语言块计数验证

## 大小与维护

i18n.js 约 4000 行（持续增长中），七块顺序固定（en → zh → zh-TW → ko → ja → pt-BR → es）。
新增 UI 功能一次通常 3–8 键 × 7 语言；用 Python 行号插入时先 `grep -n` 定位每个
locale 块的同键行，插完立即跑上面的完整性循环。

## 改键前消费点全景（09-27 教训）

> 「改」包含**删除**：删除一个功能时，同样要对其 i18n 键族做消费点全景——
> 键的消费者可能不止一个（09-27 实录：`trellisHintExecuteNext` 唯一消费方
> 是被删的气泡 formatHint，成为死键，check 复查才抓到）。



修一个 i18n 键的缺陷前，先 `grep -rn 't("<key>")' src/` 列全消费点，并问一句：
**这个消费面本身是否已是已知待修对象？**

实录：`dashboardTrellisLinksChildren` 09-26 修活了 `{n}` 占位符（7f32ae98），09-27 关联
分组修剪移除纵向组后同键再变死键删除（8f98410e）。若第一次修复时看过消费点——唯一消费者
`v|` 纵向组正是后来的冗余修剪对象——一次就能做出正确决策，不必让同一个键两轮内经历
"修活→再死→删除"。
