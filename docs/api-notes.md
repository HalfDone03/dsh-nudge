# DSH 插件接口取证（dsh-nudge 前置调研）

取证对象：本机 DeepSeek Harness 0.2.1-rc.2（`<DSH 安装目录>\resources\app.asar` 解包副本，
路径前缀 `_recon\asar\dsh\node_modules\@deepseek-ai\`，下称 `<core>`），以及两个已在跑的第三方插件
（`%DSH_HOME%\profiles\desktop\node_modules\`）。
本文所有结论均来自源码，标注 `文件:行号`。

---

## 1. 插件包最小结构

**结论：一个 npm 包 = 一个 cordis 插件；包根 `package.json` 的 `dsh.bundle.patch` 指向一份 cordis patch，
patch 里插入一行该插件的实例。**

- `@tencent-connect/dsh-qqbot/package.json` → `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`
  （`@nanmicoder/dsh-agent-teams`、`dsh-our-free-model`、核心包 `@deepseek-ai/dsh-base` 同款，见
  `<core>dsh-base\package.json` 的 `dsh.bundle.patch`）。
- profile 侧注册：`%DSH_HOME%\profiles\desktop\package.json`
  → `dependencies` 里加包名，`dsh.profile.bundles` 数组里加包名。
  启动顺序 = bundles 顺序 → `cordis.patch.yml`（人工覆盖层）→ `--patch`。
- 插件模块导出：`export { name, inject, Config, apply }`，`apply(ctx, config)` 是入口。
  实例：`<core>dsh-tool-todo\lib\index.js:11`（name）、`:12`（inject）、`:20`（Config，schemastery `z.object`）、
  `:78`（apply）、`:195`（导出表）。
- `type: "module"`、`main` 指向 ESM 入口即可，**不需要编译**，源码 JS 直接跑
  （`dsh-our-free-model` 的 `main: ./index.js` 就是手写 ESM）。
- 本插件不需要渲染进程 UI ⇒ **不写 `dsh.client` 段**（对比 qqbot/agent-teams 才需要 `dsh.client.platform`）。
- 本地安装：`pnpm add file:../路径` 或软链进 `profiles/desktop/node_modules/`，然后 profile `package.json`
  的 `dsh.profile.bundles` 加名字。**改完必须重启 DSH**（Host 侧插件只在启动时装载；渲染进程才有 HMR）。

最小 `cordis.patch.yml`（插件包内自带）：**patch 不是裸列表，必须包在 `- insert:` 里**。
证据：`<core>dsh-base\cordis.patch.yml` 的每一段都是 `- insert:` 后跟一组 `id/name/config/disabled` 行；
按 id 匹配、后写覆盖先写，且一条 patch 会**整体替换**该实例的 `config`（不是深合并）。

```yaml
- insert:
    - id: nudge
      name: 'dsh-nudge'
      config:
        enabled: true
        staySeconds: 8
```

## 2. Host 侧事件源（三类触发怎么拿）

统一入口：**`ctx.on('session/event', (session, raw) => {})`** —— `raw = { type, data }`，
`session.header.id` 是 sessionId。
证据：qqbot `dist\gateway\bootstrap.js:83`（`ctx.on('session/event', outboundHandler)`）、
`dist\transport\outbound.js:26`（`route(session, raw)`，内部用 `session.header.id`）、
`dist\transport\events.js:4`（明写"ctx.on('session/event') 回调参数"为 `{type, data}`）。

会话事件全表：`<core>dsh-session\lib\types\known-event-types.js:21-84`（turn/start、turn/end、
approval/asked、approval/decided、tool/call、tool/result、agent/inbox/spliced、job/settled…）。

### 2.1 「任务完成」/「失败」

`turn/end` 的 `data.reason` 是判别式联合，`kind` 取值只有五种：
`completed` / `blocked` / `max-tokens` / `error` / `aborted`
（`<core>dsh-agent-loop\lib\index.js:961,966,981,1013,1019`，落盘在 `:1029`）。

- `kind === 'error'` → **失败**；错误体在 `reason.error`（`{ code, message }`，code 缺省 `"UNKNOWN"`），
  参考 qqbot `dist\transport\events.js` 的 `extractTurnError`。
- `kind === 'completed' | 'blocked' | 'max-tokens'` → **完成**（`max-tokens` 建议单独文案：被截断）。
- `kind === 'aborted'` → 用户手动中断，默认不弹（配置可开）。

### 2.2 「需要用户选择」

两条独立信号，都要接：

1. **审批（approval）**：`ctx.get('approval')` 存在即服务可用；用 waterfall 挂观察者
   `ctx.on('approval/request', (req, next) => { /* 通知 */ return next() })`
   （qqbot `dist\features\approval-channel.js:50-71`；注意必须 `return next()` 放行，否则会劫持审批）。
2. **提问（ask_user_question）**：`ctx.get('userQuestions')` 服务的 `.ask(request)` 是唯一入口，
   `request.agent.id` 即 sessionId。做法是**包装** `.ask`（原样转发 + 先发通知），
   qqbot 就是这么干的：`dist\features\question-channel.js:34-55`（`uq.ask = async fn`，保留 `origAsk`，
   卸载时还原，并打 `__qqQuestionPatched` 幂等标记）。注意用它自己的 `pending`/abort 语义，
   别吞掉 rejection（`ASK_ABORTED` 表示用户没答就中断）。

### 2.3 agent 状态 / 待处理 inbox（用于"完成"判定与去抖）

`ctx.agents`（qqbot `dist\index.js:11`）；`ctx.get('agents')` 亦可。参考
`<core>dsh-desktop-host\lib\index.js:101`：`agent.status`、`agent.inbox.nextTurn/nextStep`。
建议：`turn/end` 后若 `agent.inbox.nextStep.length > 0` 说明还有后续，不弹"完成"，等真正空闲。

### 2.4 可直接用的骨架

```js
export const name = 'nudge'
export const inject = ['agents']
export const Config = z.object({ enabled: z.boolean().default(true) })

export function apply(ctx, config) {
  const alerts = createAlerter(ctx, config)          // 见 lib/alert.js
  if (ctx.get('session') ?? true) {                   // 会话事件
    ctx.on('session/event', (session, raw) => {
      if (raw?.type !== 'turn/end') return
      const reason = raw.data?.reason ?? {}
      if (reason.kind === 'error') alerts.push('failed', session.header.id, reason.error)
      else if (reason.kind !== 'aborted') alerts.push('completed', session.header.id, reason)
    })
  }
  if (ctx.get('approval')) {
    ctx.on('approval/request', (req, next) => {
      alerts.push('needs_choice', req?.agent?.id, req)
      return next()
    })
  }
  const uq = ctx.get('userQuestions')
  if (uq && typeof uq.ask === 'function' && !uq.__alertPatched) {
    const orig = uq.ask.bind(uq)
    uq.ask = async (request) => {
      alerts.push('needs_choice', request?.agent?.id, request)
      return orig(request)
    }
    Object.defineProperty(uq, '__alertPatched', { value: true, configurable: true })
    ctx.effect(() => () => { uq.ask = orig })
  }
  ctx.effect(() => () => alerts.dispose())
}
```

`ctx.effect(() => disposeFn)` 是 cordis 的标准清理钩子（`<core>dsh-desktop-host\lib\index.js:112`）。

## 3. 会话定位（点击弹窗之后）

- **没有会话级深链**：Web GUI 是 SPA，前端路由里没有 `/session/<id>`、没有 `?session=`，
  会话切换走客户端 store + API（`<core>dsh-client-ui-session\lib`、`<core>dsh-api-session-controller\lib` 中
  grep `history.pushState` / `location.hash` / `/session/` 均无匹配）。
- 因此**不要**指望点击直接跳到会话。可行降级（按优先级）：
  1. `SetForegroundWindow` 聚焦 DeepSeek Harness 主窗口（`<DSH 安装目录>\DeepSeek Harness.exe`，
     Win32 `FindWindow`/`EnumWindows` + `ShowWindow(SW_RESTORE)`）；
  2. 同时把 `sessionId` + 会话标题写进剪贴板，或在弹窗正文显示标题，人工一眼能找到；
  3. 若将来核心加了路由，再补 URL 跳转（弹窗里留一个 `url` 字段即可，无需改结构）。
- 弹窗要展示"会话标题"：`session/title` 事件（`known-event-types.js:57`）里拿，或 `agent.session.header`。
  拿不到就退化显示 sessionId 前 8 位 + 最后一条 assistant 摘要。

## 4. 右下角弹窗选型

**推荐 A：独立 WPF 窗口 helper（`powershell.exe -STA -File popup.ps1`）**。已在本机实测可跑。

| 方案 | 结论 |
| --- | --- |
| A. WPF 独立窗口 | 可控（置顶、无边框、圆角、不抢焦点 `ShowActivated="False"`、`Topmost="True"`）；PowerShell 5.1 自带 WPF，无需装任何东西；缺点是每弹一次起一个 `powershell.exe`（约 60–80MB 内存、100–200ms 启动），要用守护/常驻进程复用 |
| B. Windows Toast（WinRT `ToastNotificationManager`） | 出现在通知中心，但 PowerShell 调 WinRT 需要 AppUserModelID 归属，未注册的 exe 常常**静默不显示**；样式不可控（没法做计数合并卡片）；不适合本项目 |
| C. 渲染进程内注入 | 只能画在 DSH 窗口里，窗口最小化/被遮挡就等于没提醒，与"桌面右下角"诉求不符 |

实现要点（来自本机 spike，`_recon\spike\popup-spike.ps1`）：

- 用 `[System.Windows.SystemParameters]::WorkArea` 定位，**不要**用 `PrimaryScreen.Bounds`（会压到任务栏下面）。
- 必须 `powershell.exe -STA`（WPF 需要 STA；用 `pwsh` 时 WPF 程序集不保证存在）。
- 常驻单实例：helper 从 stdin 逐行读 JSON 事件、复用同一个窗口，`add_Click` 里 `SetForegroundWindow`。
  这样避免每次 popup 起进程，也天然满足"多条合并计数"。
- 三条坑：
  1. **DPI**：进程不声明 DPI 感知时坐标会被系统缩放，`WorkArea` 与真实像素不一致 →
     helper 里先 `SetProcessDpiAwarenessContext(-4)` 或读 `GetDpiForWindow` 再换算 96dpi 基准。
  2. **多显示器**：`WorkArea` 只反映主屏；要看鼠标所在屏或配置里指定屏幕，用 `Screen.FromPoint` 取目标屏工作区。
  3. **进程生命周期**：DSH 退出/插件 dispose 必须杀掉 helper（`child.kill()` + `process.on('exit')` 兜底），
     否则每次重启留一堆孤儿窗口；helper 侧也要监听 stdin EOF 自杀。
- 点击穿透：窗口是普通窗口，不需要 `WS_EX_TRANSPARENT`；但 `ShowActivated=False` +
  `Focusable=False` 才能做到"置顶不抢焦点"。

## 5. 验证手段（给 t4 用）

- 视觉：WPF 可在**不显示**的情况下用 `RenderTargetBitmap` 把窗口内容渲染成 PNG，做纯逻辑回归；
  再配合真实截屏（`System.Drawing` `CopyFromScreen`）验证位置。
- 位置断言：截屏后取预期矩形（`WorkArea.Right-宽-边距`）与矩形外各采样若干像素，比较均值差异；
  比"人眼看图"更可靠。
- 事件逻辑：`scripts/selftest.mjs` 直接调用 `apply()` 拿到 context mock，喂 `turn/end` /
  `approval/request` / 假 `userQuestions.ask` 三种事件，断言 alert 队列与 popup 调用参数。
