# Implement：HUD 全局字号重设计

## 顺序清单

1. [x] `src/session-hud.html`：`:root` 三 token + 12 处 font-size 改引 token + 色点/间距/面板 max-height 320px
2. [x] `src/session-hud.js`：HUD_ROW_HEIGHT 34、四宽度常量、`__test` 导出核对
3. [x] `src/session-hud-renderer.js`：容器空白点击 toggle（冒泡判定交互祖先）+ 锚定最后绑定会话
4. [x] `test/session-hud.test.js`：6 处 bounds 断言 + computeHudHeight 数值更新
5. [x] `test/session-hud-style.test.js`：token 断言（定义存在 + 引用无裸 font-size）
6. [x] `test/session-renderer-behavior.test.js`：空白点击开合用例
7. [x] `src/i18n.js`：无新增键（面板键已就位）

## 验证命令

```bash
node test/session-hud.test.js
node test/session-hud-style.test.js
node test/session-renderer-behavior.test.js
node test/run-tests.js   # readme 预存除外
```

## 风险文件

- src/session-hud.js（HUD_ROW_HEIGHT 是高度公式与 reserved offset 的双消费常量——只改常量值，不动公式）
- src/session-hud.html（token 定义遗漏会造成裸值不一致——style 测试守卫）
