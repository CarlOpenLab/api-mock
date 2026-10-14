# API Mock

Chrome / Edge 的 DevTools 面板：实时抓取页面上的 fetch / XMLHttpRequest，并按规则改写响应——**响应体、状态码、响应头、延迟、故障**，用来在前端把各种边界情况跑一遍。

装好之后按 F12，和 Elements / Network 并排多一个「API Mock」标签页。

---

## 快速开始

```bash
pnpm install
pnpm build
```

然后：

1. 打开 `chrome://extensions`，右上角开启**开发者模式**
2. 点「加载已解压的扩展程序」，选本项目的 **`dist/`** 目录
3. 跑实验台：`pnpm demo`，浏览器打开 http://localhost:8787
4. **刷新一次页面**（见下方「装完为什么要刷新」），按 F12 切到 API Mock 面板

---

## 用法

面板分两个页签。

**请求页** —— 左边是实时请求流，每行显示方法、URL、应用实际收到的状态码、这条请求被怎么处理了（放行 / 改写 / 伪造 / 失败）、耗时。上面是**过滤框**（匹配 URL 或方法）和结果筛选（全部 / 改写 / 伪造 / 失败 / 放行），底部会显示「已过滤 N / M 条」，右下角可以关掉「跟随最新」让列表别自己跳。

点任意一行看详情：请求头、请求体、响应头、响应体（都是**应用实际收到的**，不是网络上的原始值）。JSON 会自动缩进 + 上色，每个区块的标题可以点开折叠，两栏之间的分隔条可以拖（双击复位）。

> 美化会改动空白。要看应用**逐字节**收到的东西，点响应体右上角的「显示原文」。面板上凡是美化过的 body 都会标出「已美化（空白与原文不同）」。

详情里有个「以此请求建规则」，会带着这条请求的 URL 通配和方法跳到规则页，是主要动线。

**快捷键**（焦点不在输入框里时）

| 键 | 作用 |
|---|---|
| `↓` / `j`、`↑` / `k` | 在请求流里上下切换 |
| `Enter` | 当前选中的请求 → 直接建规则 |
| `Esc` | 取消选中 |

**规则页** —— 左边规则列表（勾选框启停、↑↓ 调优先级、✕ 删除），右边是编辑器。

一条规则由三部分组成：

| 部分 | 说明 |
|---|---|
| **匹配** | URL 模式（通配 / 包含 / 正则）+ 方法。编辑器里有「试试匹配」，粘个真实 URL 进去当场看会不会命中 |
| **动作** | 穿透改写 / 直接伪造；状态码、延迟、故障 |
| **响应头 / 响应体** | 头可以增可以删；体可以整段替换，也可以**深合并**到真实响应上 |

### 两种模式的区别

- **穿透改写**（默认）—— 真实请求照发，拿到响应后在最后一刻改掉。后端副作用真实发生、你没碰的字段都是真的。想让接口返回空列表时，这是唯一真实的做法。
- **直接伪造** —— 完全不发请求，`new Response()` 现造。后端挂了、接口还没写、断网、或者要造一个后端不可能返回的数据时用。「这条请求有没有真的发出去」可以用 Network 面板验证。

### 合并 JSON 是默认选项，因为它最常用

只想改一个字段、别的都别动——写 `{"data": []}` 就够了，真实响应里的其他字段原样保留。数组整体替换（不逐项合并），因为逐项合并在长度不一致时的结果没法预测。

---

## 已知边界

这些是这条技术路线的固有边界，不是 bug：

**拦不到的**

- `navigator.sendBeacon` —— 埋点常用它，不在 fetch / XHR 里
- Service Worker 发起的请求
- 页面资源（img / script / css）
- WebSocket、EventSource

**时序相关的**

- 装完插件后**已打开的页面要刷新一次**。content script 是声明式注入的，只在页面加载时跑；刷新后才会接管。刷新之后建立的每个 iframe 也都会自动接管。
- 装了插件而没开 DevTools 面板时，**规则依然生效**（规则存在 `storage.local`，页面侧一直持有副本）。面板只是编辑和观察的界面，不是开关——要临时全关请用面板上的总开关。

**改写能力的边界**

- **只有真的替换响应体时才会缓冲整个响应。** 只改状态码或响应头时，body 用 `new Response(real.body, …)` 原样透传，SSE 这类流式响应不受影响。这条有专门的验证覆盖。
- **XHR 命中规则时一定会缓冲**——因为 `responseText` 本身就是字符串，绕不开。
- **伪造出来的响应不受 CORS 约束。** 既是特性（能造跨域数据）也是陷阱（本地过了不代表线上过）。
- **`new Response()` 的状态码只能是 200–599**，造不出 1xx，204 / 304 不能带 body。编辑器会直接拦下来而不是让你白试。

**采集开销**

面板顶部「采集 Body」开关控制是否记录**未命中规则**的请求 / 响应体。关掉可以消除全部额外开销（此时未命中的请求只记录 URL、方法、状态码、**响应头**、耗时——头一直都在采，读它不碰 body）。`text/event-stream` 永远不采集——读下去会把流吃掉。

---

## 架构

```
┌─ 页面 (MAIN world) ───────────────────────────┐
│  inject.js   包装 window.fetch / XMLHttpRequest│
│              持有规则快照，本地同步匹配         │
└────────────────┬──────────────────────────────┘
                 │ window.postMessage
┌────────────────┴──────────────────────────────┐
│  bridge.js  (ISOLATED world content script)   │
└────────────────┬──────────────────────────────┘
                 │ chrome.runtime Port
┌────────────────┴──────────────────────────────┐
│  后台 service worker                          │
│    规则持久化 + 请求流按 tabId 缓冲            │
└────────────────┬──────────────────────────────┘
                 │ Port
┌────────────────┴──────────────────────────────┐
│  DevTools 面板 (React)                        │
└───────────────────────────────────────────────┘
```

几个值得说明的决定：

**为什么要有个 bridge。** MAIN world 的脚本跑在页面自己的环境里，能改到页面用的 `window.fetch`，但**没有任何 `chrome.*` API**；ISOLATED world 的 content script 正好相反。两个世界各缺一半，只能靠 `postMessage` 缝起来。（消息带一次性 nonce，用来和站点自己的 postMessage 区分开——这是卫生措施，不是安全边界：页面本来就能拿原始 `fetch` 绕开 hook。）

**为什么匹配在页面里做，而不是问后台。** 决策必须是同步的（XHR 的同步模式不允许 `await`），而且每次请求都往返一趟消息会白白加延迟。规则变更由后台广播，页面侧持有副本。

**为什么 XHR 的改写要另起一个对象发请求。** `Response` 的 status / headers 在 fetch 里还能重建，但 XHR 的 `responseText` / `status` 是原型上的只读 getter，读的是内部状态，没有 API 能改。反过来想「抑制真实事件、稍后重放」又得连 `addEventListener` 一起劫持，漏一处应用就会看到两次响应。换个对象发请求干净得多。

---

## 开发

```bash
pnpm dev          # 两条构建流水线都进 watch 模式
pnpm typecheck    # 类型检查（app 和 node 两份 tsconfig）
pnpm test         # 单测：匹配、深合并、改写决策、编辑器草稿校验
pnpm verify       # 端到端验证（见下）
pnpm demo         # 只起实验台服务器
```

改完代码后在 `chrome://extensions` 点一下刷新按钮，再刷新页面。

### 测试分三层

| 层 | 覆盖什么 | 怎么跑 |
|---|---|---|
| **单测**（87 条） | 纯逻辑：URL 匹配、JSON 深合并、改写规格、编辑器校验、body 美化与分词 | `pnpm test`，不需要浏览器 |
| **端到端**（92 条） | 真实浏览器 + 真实网络：改写行为、XHR 生命周期、上报链路、面板交互 | `pnpm verify` |
| **实验台** | 手动点着玩 | `pnpm demo` |

`pnpm verify` 值得多说一句。它会起本地服务器 + 无头 Chrome，**加载构建产物里那份 `inject.js` / `bridge.js`**（不是源码的另一份拷贝），用一个假的 `chrome.runtime` 扮演后台，然后跑真实的 fetch 和 XHR。所以它证明的是「你装进扩展的那个文件确实能工作」：

- 改写后的响应，应用侧到底收到了什么（状态码、头、body、`response.url`）
- 只改状态码时**流有没有被缓冲**——服务端发完第一块等 500ms，断言第一块能立刻读到
- 伪造模式下请求**到底有没有溜出去**——靠服务端的路径计数证伪
- XHR 的 `readystatechange` / `load` / `loadend` / `abort` / `error` 时序，以及 `responseType` 的语义
- `hook → postMessage → bridge → Port` 这条上报链路

另有一个面板套件，把构建出来的 `panel.js` 在普通页面里真跑起来，点一遍主要交互（建规则、改字段、保存、启停、删除、清空），断言 UI 反应和写进 storage 的内容都对。

之所以不直接装扩展来测：Chrome 137 起，正式版（非 Chromium / 非 Chrome for Testing）移除了 `--load-extension`，命令行加载会**静默失败**——不报错，只是扩展根本没装上。上面这套「加载产物 + 打桩宿主」的做法绕开了这个限制，而且覆盖到的面更宽。

找不到 Chrome 时用 `CHROME_PATH` 指定可执行文件。

---

## 目录

```
src/
  shared/      规则模型、URL 匹配、JSON 合并、消息协议、storage 键（纯逻辑，可单测）
  content/
    inject.ts    MAIN world 入口
    fetch-hook.ts / xhr-hook.ts / rewriter.ts / context.ts
    bridge.ts    ISOLATED world 中继
  background/   service worker：配置下发 + 请求流缓冲
  devtools/     DevTools 面板（React）
demo/           实验台 + 自动化验证页 + 面板预览页（chrome-stub.js 打桩宿主）
tests/          单测
scripts/        build-content.mjs / watch.mjs / verify.mjs
```

`content` 与 `devtools` 之间没有直接依赖，两边都只认 `shared/`。面板也不 import 后台代码——它只认 `shared/storage.ts` 里那两个键，不关心后台怎么消费。

---

## 构建为什么是两条流水线

manifest 里声明的 content script 是**经典脚本，不能是 ES module**，所以不能用 Vite 那套输出（ESM + 公共 chunk，content script 加载不了）。于是：

- **Vite** → `devtools.html`、`panel.html`、`background.js`（service worker 可以 `type: module`，能分块）
- **esbuild** → `content/inject.js`、`content/bridge.js`（各自打成自包含的 IIFE）

`pnpm verify` 的预检会检查 manifest 引用的文件是否齐全，以及 content script 里有没有混进 ESM 语句——这两类是扩展最典型的静默翻车方式。
