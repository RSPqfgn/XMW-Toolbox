# XMW Toolbox 开发文档

面向开发者的内部架构说明与扩展 API 参考。本文档不会告诉你「这个脚本能做什么」——那是 [README](../README.md) 的职责。

运行环境：Tampermonkey / Violentmonkey，站点为 <https://world.xiaomawang.com>。整个项目是**单个文件**的 user script，无构建步骤、无第三方运行时依赖。

---

## 1. 概览

`XMW Toolbox.user.js` 是一个自包含的 IIFE，`'use strict'`，内部用大写开头的模块常量组织。核心思路：

- **一个中央 DOM 监听器**（`Watcher`）取代散落各处的 `setInterval`，新增功能只需 `Watcher.watch(selector, cb)`。
- **声明式设置系统**（`Settings`）：功能只声明设置项，设置界面据此自动生成，无需手写界面。
- **零依赖 UI**（Shadow DOM）：弹窗、确认框、Toast 样式与站点完全隔离。
- **单文件交付**：不需要打包器，改完直接提交。

模块一览：

| 模块 / 对象 | 职责 |
| --- | --- |
| `META` / `ORIGIN` / `SELECTORS` / `TASK_ACTION_CLASS` | 元信息、站点源、选择器集中管理 |
| `Util`（`h`、`gmFetch`、`waitForSelector` 等） | 通用工具函数 |
| `Watcher` | 中央 DOM 监听器：MutationObserver 即时响应 + 1s 兜底轮询 |
| `Settings` | 声明式设置系统 + v1 配置迁移 |
| `UI` | Shadow DOM 弹窗 / 确认框 / Toast |
| `Menu` | 油猴菜单注册表 |
| `Features` | 功能注册表：每个功能是独立模块 |
| `AutoTask` | 自动任务状态机 |
| `悬浮球` | 可拖动的工具入口 |
| Panels（自动任务 / 查询 / 设置） | 内置面板 |
| `exposeExtensionAPI` | 暴露 `unsafeWindow.XMWToolbox` 扩展 API |

## 2. 启动流程

`main()` 在 `document-idle` 时执行一次：

```
main()
├─ Settings.load()       读取存储、迁移 v1 旧键、补齐默认值
├─ Menu.register(...)    注册「自动任务 / 查询 / 设置」+ Menu.setup()
├─ Features.start()      启动所有已注册功能
├─ exposeExtensionAPI()  写入 unsafeWindow.XMWToolbox
└─ AutoTask.resume()     判定本标签页是否为自动任务执行标签页，是则接管
```

## 3. 模块详解

### 3.1 META / SELECTORS —— 元信息与选择器

站点是 React 应用，类名带构建哈希。因此大量选择器用 `[class*="前缀"]` 匹配稳定片段，抵抗哈希变化。改动选择器时尽量沿用这一约定。

### 3.2 Watcher —— 中央 DOM 监听器

```js
// 元素出现时回调；返回取消函数
const stop = Watcher.watch(selector, el => { ... }, {
    cooldown: 0, // ms：同一元素两次回调的最小间隔
    once: false, // true：每个元素只触发一次
});
```

- 通过 `MutationObserver` 对 `${document}` 新增节点即时扫描，并额外保留 **1s 兜底轮询** 覆盖 MutationObserver 可能漏掉的场景。
- 只有存在注册的监听器时才启动定时器，避免无效开销。
- `Watcher.every(ms, fn)` 提供定时执行（用于 XPath 等选择器无法表达的轮询）；`Watcher.xpath(expr)` 做单次 XPath 查询。

### 3.3 Settings —— 声明式设置系统

功能通过 `Settings.define` 声明设置项，设置界面据此自动生成（新增设置基本不用改界面代码）。

- 存储为**单个 JSON 对象**，键为 `toolbox.settings`。
- `Settings.set()` 触发 `onChange` 回调，使悬浮球显隐 / 大小等无需刷新即时生效。
- 首次运行自动从 v1 散键迁移，废弃键自动清理。

`define` 接收的设置项结构：

```js
{
    key: 'appearance.floatingBallSize', // 唯一键，建议「分组.名称」
    group: 'appearance',                // 设置分组 id（见 defineGroup）
    label: '悬浮球大小',
    desc: '…',                          // 可选，界面上的说明文案
    default: 46,                        // 默认值
    type: 'select',                     // 'toggle'（默认） | 'select'
    options: [{ value, label }],        // type 为 select 时必填
    reload: false,                      // true：改完需刷新页面生效
}
```

分组需先注册：`Settings.defineGroup({ id: 'tasks', label: '自动任务' })`。内置分组：`tasks`（自动任务）、`appearance`（界面定制）。

### 3.4 UI —— Shadow DOM 组件

弹窗、确认框、Toast 全部挂载到 Shadow Root，内置 `SHADOW_CSS` 样式与站点完全隔离，无任何外部依赖（历史上曾用 SweetAlert2，已移除）。

```js
const { host, root } = UI.mount(className); // root 是含样式的 ShadowRoot
const modal = UI.openModal({
    title, width = 560,
    content,            // Node 或 HTML 字符串
    footer = [],        // Node[]，通常是按钮
    onClose(reason),    // reason: 'close' | 'overlay' | 'escape' | 自定义
});                     // 返回 { close, body, root }

const ok = await UI.confirm({ title, message, okText, cancelText }); // Promise<boolean>
UI.toast(message, { type = 'info', duration = 2400 });               // type: info|success|warning|error
```

### 3.5 Menu —— 油猴菜单注册

```js
Menu.register(label, handler); // 追加一条菜单项，Menu.setup() 时统一注册
```

### 3.6 Features —— 功能注册表

每个功能是独立模块，声明自己的设置项与启动逻辑：

```js
Features.register({
    id: 'auto-receive',
    settings: [/* 设置项定义 */],
    setup() { /* 这里启动 Watcher 监听、绑定逻辑 */ },
});
```

`Features.start()` 遍历执行各功能的 `setup()`，单个失败不影响其余功能。

### 3.7 AutoTask —— 自动任务状态机

自动任务（签到 / 点赞 / 收藏 / 发布）的核心难点是**跨页面执行**：不同任务散落在不同页面。方案是持久化状态机：

- **状态持久化**：一次运行的状态（`steps` 步骤队列 + `cursor` 游标 + 阶段 + 结果）写入 GM 存储。
- **标签页隔离**：起始页生成 `runId`，写入 `sessionStorage`，并 `window.open` 打开带上 `#runId=…` 的任务标签页。
- **单标签页接管**：执行标签页每次加载时 `AutoTask.resume()`，由 URL hash 取出 `runId`，从持久化的游标继续推进，走完整个步骤队列。

步骤的 `kind` 由一个 `HANDLERS` 分发表处理：

```
receive      → doReceive        领奖（点击所有可领取奖励）
detect       → doDetect         检测任务完成状态
finish       → doFinish         结算并汇总结果
signIn       → doSignIn         进入首页签到
collectLinks → doCollectLinks   在作品列表页收集候选作品链接，动态插入点赞/收藏步骤
react        → doReact          对单个作品做点赞 / 收藏（幂等 + 激活态校验）
openEditor   → doOpenEditor     打开作品编辑器
fillRelease  → doFillRelease    填充发布信息并提交
```

主要任务类型（`REACT_CONFIG` / `TASKS`）：`signIn`（签到）、`like`（点赞，需 3 次）、`collect`（收藏，需 1 次）、`publish`（发布作品）。点赞 / 收藏通过运行时收集候选作品链接、按需插入 `react` 步骤动态扩展队列。

失败会记录到 `errors` 并由 `showReport` 汇总到弹窗报告。起始页作为**控制入口**，任务进度通过遮罩与 Toast 反馈，可随时中止。

### 3.8 悬浮球

可拖动、记忆位置的工具入口；点击弹出「自动任务 / 查询 / 设置」。显隐与大小由设置项驱动，`Settings.set` 的 `onChange` 使其即时生效。

### 3.9 查询

按 ID 查询 **用户 / 作品 / 工作室** 信息，通过 `gmFetch` 拉取目标页面、`parseHtml` 解析并抽取关键字段，支持快速跳转。

## 4. 扩展 API（`unsafeWindow.XMWToolbox`）

脚本启动后把 `Object.freeze` 的 API 写入 `unsafeWindow.XMWToolbox`，供其他 user script 接入。这是为未来扩展系统预留的接口。

```js
const t = unsafeWindow.XMWToolbox;

t.version;                       // "2.0.0" 当前脚本版本
t.settings.define(defs);         // 注册一组设置项（见 3.3 的 def 结构）
t.settings.get(key);             // 读取设置值
t.settings.set(key, value);      // 写入设置值（触发 onChange）
t.menu.register(label, handler); // 追加一条油猴菜单项
t.watcher.watch(selector, cb, opts); // 监听元素出现（见 3.2）
t.ui.mount(className);           // 创建含样式的 Shadow 容器 → { host, root }
t.ui.openModal(opts);            // 打开弹窗（见 3.4）
t.ui.confirm(opts);              // 确认框 → Promise<boolean>
t.ui.toast(message, opts);       // Toast（见 3.4）
```

### 4.1 一个最小扩展示例

```js
// 在 XMW Toolbox 之后运行的另一个 user script
const toolbox = unsafeWindow.XMWToolbox;
if (!toolbox) { console.warn('XMW Toolbox 未加载'); return; }

// 1. 注册一个设置项（会出现在「界面定制」分组）
toolbox.settings.define([
    { key: 'myExt.enabled', group: 'appearance', label: '我的扩展', default: true, reload: true },
]);

// 2. 追加一条油猴菜单
toolbox.menu.register('我的扩展', () => {
    toolbox.ui.toast('Hello from extension!', { type: 'success' });
});

// 3. 监听某个站点元素出现
if (toolbox.settings.get('myExt.enabled')) {
    toolbox.watcher.watch('div[class*="myTarget"]', el => {
        console.log('元素出现：', el);
    });
}
```

### 4.2 注意事项

- `ui.openModal` 的 `content` 可传 DOM 节点或 HTML 字符串；`footer` 为按钮节点数组。
- `reload: true` 的设置项改动需要刷新页面才能生效。
- 所有 API 对象均被 `Object.freeze` 冻结，不可覆盖。