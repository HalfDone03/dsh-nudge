# dsh-nudge

DSH（DeepSeek Harness）插件：会话里**任务完成**、**需要你选择**、**执行失败**时，
在桌面**右下角**弹一张置顶小卡片提醒你处理。点一下卡片回到 DSH 窗口，并把这批提醒复制到剪贴板。

![三种状态](screenshots/needs_choice.png)

## 它解决什么

DSH 的回合经常跑很久，或者卡在等你批准/回答上，而你切到别的窗口去了。
这个插件在三种时刻各弹一张卡片（深色玻璃质感、圆角、不抢焦点、盖在任务栏上方）：

| 时刻 | 触发来源 | 卡片标题 |
| --- | --- | --- |
| 回合正常结束 | `session/event` → `turn/end`，`reason.kind` 为 `completed` / `max-tokens` / `blocked` | 任务完成 |
| 等你批准或回答 | `approval/request` 事件、`userQuestions.ask()` 被调用 | 需要你选择 |
| 回合或工具失败 | `turn/end` 的 `reason.kind === 'error'`、`tool/result` 报错 | 执行失败 |

几张卡片同时到达时，1.2 秒合并窗口内的事件会合成一张，标题取最严重的那个，右上角显示累计条数。

## 安装

```powershell
# 只看计划，不写文件
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -DryRun

# 真正安装（会先备份 profile 的 package.json）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

安装脚本做三件事，顺序不能省：

1. 往 profile 的 `package.json` 加一条 `file:` 依赖，并把 `dsh-nudge`
   追加进 `dsh.profile.bundles`；
2. 用 **DSH 自带的 pnpm** 在 profile 目录跑一次 `pnpm install`，把
   `node_modules\dsh-nudge` 建成 junction —— 只改 package.json 是不够的，
   Host 的 Loader 是按包名从 `node_modules` 里解析的，不落盘就会「装了但加载不到」；
3. 校验 `node_modules\dsh-nudge\package.json` 可读，并打印实际版本。

它**不碰** profile 的 `cordis.patch.yml`（那里放的是部署密钥），也**不会**重启 DSH。

**跑之前先退出 DeepSeek Harness**：pnpm 要重写 `node_modules`，Windows 上被占用的文件删不掉。
装完再启动 DSH 才生效——插件跑在 Host 进程里，Host 侧改动没有热更新。

DSH 自带的 pnpm 在 `%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs`，
脚本自动找它；找不到时会打印手动命令（`-SkipPnpm` 可跳过这一步）。

卸载：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

安装与卸载都是幂等的，重复执行不会重复写入；每次改动前都会生成
`package.json.bak-<时间戳>`，写入失败或校验不通过会自动回滚。

## 配置

配置写在 profile 的 `cordis.patch.yml` 里，按 id 覆盖本包的默认值：

```yaml
- id: nudge
  config:
    staySeconds: 12        # 卡片停留秒数，1..600，默认 8
    margin: 16             # 距屏幕工作区右下角的边距，默认 16
    maxItems: 5            # 一张卡片最多列几条，超出显示 +N more
    showWhenFocused: true  # DSH 在前台时也弹；设 false 则前台时不打扰
    mergeWindowMs: 1200    # 合并窗口（毫秒），同一窗口内的多条事件合成一张卡
    alertOnToolError: true # 单个工具调用失败也算「失败」提醒
    muteRanges: ['22:00-08:00']  # 静音时段，支持跨零点
    kinds:                 # 三类提醒各自开关
      completed: true
      needs_choice: true
      failed: true
```

非法配置会在插件加载时报错（`staySeconds` 越界、`muteRanges` 格式不对等），不会静默失效。

## 视觉与排版

卡片默认 384 宽（含阴影留白 412），自适应高度、可拖动缩放，深色玻璃质感。底色是 8° 的竖向渐变（`#F8212530` → `#F8181B24`），边缘 1px `#2BFFFFFF` 微亮描边：

```
┌──────────────────────────────────────────┐
│▌ ✔  任务完成  ③                    23:05 │   ← 强调色竖条 3px / 圆形图标 / 标题 / 计数胶囊 / 最新时间
│  ────────────────────────────────────────│   ← 1px 分隔线
│  ● 部署到生产环境            x2    23:05 │   ← 圆点按类型着色，标题 12.5 半粗
│    等待你批准一个高危操作                  │   ← 明细 11.5 淡白，最多两行后省略
│  ● 跑单元测试                      23:02 │
│    回合已完成                             │
│  还有 2 条未展开                          │   ← 超出 maxItems 时的提示（文案由 JS 下发）
│  点击卡片回到 DeepSeek Harness            │   ← 底部提示
└──────────────────────────────────────────┘
```

- 字体用 `Microsoft YaHei UI → Segoe UI → Arial` 回退链，中文不再掉进 Segoe UI。
- 高度由内容测量决定（`Measure` + `DesiredSize`），长明细换行不会撑破卡片，也不会留白。
- 出现时 180ms 淡入 + 10px 上滑；鼠标悬停边框提亮。
- 条目越多停留越久（`staySeconds + 2 × (条数-1)`），避免没看完就消失。
- 卡片内顺序：先按严重度（失败 > 选择 > 完成），同级别按时间倒序。
- `popup.ps1` 保持纯 ASCII，所有中文文案（标题/展开提示/底部提示）由 `index.js` 下发的 payload 提供。

## 交互

- **可拖动、可缩放**：按住卡片拖动即可换位置；把鼠标移到四边或四角（8px 感应区，光标会变成缩放箭头）拖动即可改大小，最小 300×118。卡片是透明的无边框窗口，所以缩放走的是 `ReleaseCapture` + `WM_NCLBUTTONDOWN`，交给系统原生缩放循环处理。
- **内容自适应**：卡片宽度不再写死，文字、清单、项目标签都按当前可用宽度重新换行排版；拖大不会留白，拖小自动折行。
- **每条都写清项目和任务**：多条提醒时逐条列出，每条第一行是任务名，第二行是「📁 项目 · 明细」；单条时任务名做主标题、项目单独一行。不加滚动条，卡片按内容长高，窗口最小高度也跟随内容，拖不小到看不清。
- **不抢焦点**：卡片 `ShowActivated=false`，不会打断你正在敲的字。
- **自动消失**：`staySeconds` 秒后淡出（到点关闭，无残留进程）。
- **点一下**：把 DSH 窗口切到前台，并把提醒内容（标题 + 明细）放进剪贴板。
  DSH 的 Web GUI 是单页应用，没有「按会话 id 直达」的 URL，所以只能聚焦窗口 + 复制线索。
- **同一时刻只有一张卡**：新的一批提醒会顶掉上一张，避免叠一屏。

## 发布

包已按可发布形态配好：`type: module`、`main`/`exports`、`dsh.bundle.patch`、
`files` 白名单（12 个文件、约 248 KB，只含 `lib`/`scripts`/`cordis.patch.yml`/文档/三张实拍图）、
`engines: { node: ">=20.3.0", dsh: ">=0.2.1-rc.2" }`、`publishConfig.access: public`。

```powershell
npm login
npm publish            # 名字带 scope 时用 npm publish --access public
```

发布前自检：

```powershell
& $node --check .\lib\index.js
& $node .\scripts\selftest.mjs      # 23 项全绿
```

三条硬要求，少一条装上就是坏的：

1. `dsh.bundle.patch` 必须指向真实存在的 patch 文件——没有它 DSH 不认这是组合包；
2. `cordis.patch.yml` 里的 `name` 必须是包名，`id` 才是实例 id；
3. `engines.dsh` 写错范围会在 pnpm 之前被拦掉（`incompatible-version`），
   确认没问题可用 `dsh plugin allow-version <包@版本> --dsh-version <运行时> --accept-risk` 豁免，
   但插件升级或 DSH 升级都不会继承这条豁免。

## 更新

| 场景 | 做法 | 要重启 DSH |
| --- | --- | --- |
| 本地 `file:` 依赖改了代码 | 重新 `install.ps1`（或插件页重装） | 要 |
| 本地 `link:` 依赖改了代码 | 直接改 `lib/*` | 要 |
| 只改配置（`config`） | 改 profile patch / 插件页开关 | 启用 HMR 时不用 |
| 发布新版 | 改 `version` → `npm publish` → 插件页「更新」 | 要 |
| 回滚 | 装回旧版本，或恢复 `package.json.bak-<时间戳>` | 要 |

registry 安装是 `saveExact`（精确版本），不改版本号重装拿不到新代码。

## 自测

不依赖真实会话，直接驱动插件逻辑与弹窗脚本：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node .\scripts\selftest.mjs
```

当前 **23 项全绿**，覆盖：配置校验与默认值、静音时段（含跨零点）、事件合并计数、
严重度排序、三类开关、真起弹窗并收到 `{"type":"shown"}` 与右下角坐标、dispose 后无孤儿进程、
三种状态各渲染一张 372px 宽快照（尺寸与非空校验）。

快照模式可以单独跑，不需要会话也不需要屏幕：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -STA -File .\lib\popup.ps1 `
  -Snapshot .\screenshots\custom.png -PayloadB64 <base64 的 JSON>
```

## 文件

```
dsh-nudge/
├─ package.json          插件包声明（dsh.bundle.patch 指向 cordis.patch.yml）
├─ cordis.patch.yml      bundle patch：把插件插进 Host 的插件图
├─ lib/
│  ├─ index.js           插件逻辑：事件钩子、合并去重、配置校验、helper 进程管理
│  └─ popup.ps1          WPF 弹窗（纯 ASCII 脚本，含快照渲染模式）
├─ scripts/
│  ├─ install.ps1        注册进 profile（幂等、备份、失败回滚）
│  ├─ uninstall.ps1      从 profile 摘除
│  └─ selftest.mjs       23 项自测
├─ screenshots/          三态卡片图（纯色底，无桌面内容）
└─ docs/api-notes.md     事件源与弹窗选型的取证笔记（带源码行号）
```

## 实现要点（踩过的坑）

- **Host 进程里没有 Electron**：DSH 的 Host 是 `ELECTRON_RUN_AS_NODE` 子进程，拿不到
  Electron 的 `Notification`，所以弹窗交给 `powershell.exe -STA` 的 WPF 窗口。
- **一次性 helper，不用常驻 + stdin**：Windows PowerShell 5.1 的 `[Console]::In`
  在重定向管道下会把命令压到下一次写入才交付（实测延迟数秒乃至挂死）。
  现在每条提醒起一个一次性进程，payload 走命令行 base64，到点或点击即退出。
- **状态行必须写裸 stdout**：`Write-Output` / `[Console]::Out` 在 dispatcher 回调里
  不会及时冲刷，改用 `[Console]::OpenStandardOutput()` 直接写字节。
- **窗口可能被隐藏启动**：宿主用 `windowsHide` 拉起 helper 时，首个 WPF 窗口会带着
  隐藏标志出现，`Show()` 后要 `ShowWindow(SW_SHOWNOACTIVATE)` + `SetWindowPos(HWND_TOPMOST, …NOACTIVATE)` 强制可见。
- **脚本保持纯 ASCII**：PowerShell 5.1 会把无 BOM 的 UTF-8 脚本按 ANSI 读，
  中文注释会乱码甚至语法错误；`popup.ps1` 里没有非 ASCII 字符。
