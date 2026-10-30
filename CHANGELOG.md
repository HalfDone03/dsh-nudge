# Changelog

本插件按语义化版本记录改动。日期为提交到 `main` 的时间。

## 未发布
**新增**

- 每一项文字的字号与颜色：配置项 `typography`（`title` / `project` / `task` / `reason` / `status` / `time` / `more` / `footer`，
  每项 `{ color, size }`）。留空 / 0 = 用主题默认，所以不配时版式与 1.0.0 逐像素一致；
  `size` 0–48，`color` 接受 `#RRGGBB` / `#AARRGGBB`，写错在加载时报错而不是静默失效。
  设置页新增「每一项的字号和颜色」一组，**只在「预览弹窗」打开时出现**——没有常驻的卡片当靶子，调字号只能靠猜；
  改完对**所有**卡片生效，预览卡会当场重画一次（重画跳过 3 秒冷却）。
- 自测 179 项（`--no-live` 156；设 `DSH_NUDGE_SCHEMASTERY` 时 186）：字体配置校验 5 条、schema volatile 1 条、
  源码约束 2 条、设置页字体组 4 条、字体快照 A/B 2 条（标题 22 号纯红：高度 174→182、红像素 0→861）。
  设置页的控件数从 17 涨到 33（多了 8 个颜色框与 8 个字号框）。

**修复**

- `scripts/install.ps1` 找不到自带 pnpm：原来只认 `%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies`，
  桌面版（自带运行时在 `<安装目录>\resources\runtime\primary-runtime\dependencies`）一律落空。现在按
  「进程可执行文件所在目录 / 卸载注册项 `InstallLocation`」认安装目录，再拼 4 种运行时布局逐个探测，
  最后回落到 `PATH` 里的 `pnpm`；`DSH_NUDGE_INSTALL_ROOT` 可显式指定安装目录。
  另外，**一处都找不到时改为把 `package.json` 回滚成备份并以退出码 1 结束**——原先只是打印手动命令就
  `exit 0`，留下「manifest 写了插件、`node_modules` 没有」的半装状态，下次启动 DSH 会加载失败。
- `scripts/uninstall.ps1` 同一个毛病，摘完插件后 `node_modules` 剪不掉：现在和 `install.ps1` 共用新的
  `scripts/dsh-deps.ps1`（发现逻辑只写一份），剪枝前后都会告诉你用的是自带 pnpm 还是 PATH 上的；两处都没有时
  说明残留无害（`dsh.profile.bundles` 才决定加载什么），不再只丢一句「Bundled pnpm not found」。
- pnpm 调用统一用 `$ErrorActionPreference = 'Continue'` 包住：PS 5.1 在 `Stop` 下会把 pnpm 写往 stderr 的
  第一行变成终止性的 `NativeCommandError`，改动前只要 pnpm 啰嗦一句就整脚本中断，现在只看退出码。
- README 里过期的 `0.3.0` 引用（市场安装说明、`git clone --branch`、`codeload` 地址、`@v0.3.0` 告警）
  全部改成 `1.0.0`，版本表补上 1.0.0 一行，pnpm 位置改成按装法分列的对照表，文件树补上 `scripts/dsh-deps.ps1`。

---

## 1.0.0 - 2026-10-29
**稳定版**

- 1.0.0 定版：这一版不加功能，只把版本号定下来。三态提醒、合并计数、深浅配色、位置记忆、预览开关、
  自带设置页（`设置 → 提醒弹窗`）以及 `liveConfig` 热更新，接口到此冻结——配置项名字、
  `shown` / `closed` 状态行的字段、`cordis.patch.yml` 的形状都不再变。
- 自测 166 项（`--no-live` 143）保持全绿；往后的改动按「修 bug 发补丁版、加功能才动次版本号」走。

---

## 0.3.3 - 2026-10-28
**新增**

- 深浅两套配色：配置项 `theme: auto | dark | light`，`auto` 读 Windows 的「应用模式」
  （`AppsUseLightTheme`）自己选，读不到按深色。浅色不是把深色反过来——卡片底色、文字层级、
  分割线、描边、阴影、状态色都是单独一套值。`shown` / `suppressed` / `snapshot` 状态行新增 `theme`，
  调试时还能用 `popup.ps1 -Theme light` 临时覆盖。
- 调试开关进了插件配置：`debugPayload: true` 时把每次弹出的 payload 追加写成 JSONL
  （`debugFile` 留空则落在 `%TEMP%\dsh-nudge-payloads.jsonl`），不用带着环境变量重启宿主；
  原有的 `DSH_NUDGE_DEBUG_PAYLOAD` / `DSH_NUDGE_DEBUG_FILE` 仍然有效。
- 配置能在 DSH 设置里改：`设置 → 插件 → nudge`。`Config` 换成带 `.volatile()` 字段的
  Schemastery schema，宿主的设置页会自动给它渲染表单，改一项**立刻生效**（不用重启），写回的是当前
  profile 的 `cordis.patch.yml`。`popupScript` 故意没标 volatile——换弹窗脚本要重启。
- 插件自带的设置页：`设置 → 提醒弹窗`。新增浏览器半身 `client.js`（经典脚本，包在
  `window.__ModuleLoader__.load({ id, factory })` 里，只 `require("react")`，无需构建），
  注册到 `settings.section`，`order: 20` 排在「插件」页之后，分六组：总开关、提醒哪几类、什么时候弹、
  样子与位置（配色下拉 / 停留 / 边距 / 记住位置）、合并（窗口 / 条数 / 静音时段）、调试（落盘开关与路径）。
  写入走 `configForms.mutate(ops, revision)`，`kinds.completed` 这种多段路径也能写；页面显示「正在读取配置…」
  与只读提示，写失败有中文错误行。因为自带了页面，宿主侧的自动表单用
  `ctx.settings.configure({ auto: false })` 关掉了，两处不会各显示一份。
- 运行时读的是实时配置：新增 `liveConfig()`，每次读属性才展开 volatile 引用并重新校验；
  设置里填了非法值就沿用上一份能用的配置，不会因为手滑写坏一个字段而整晚没提醒。
- `@deepseek-ai/schemastery` 不硬依赖：宿主里能解析就用它生成 schema，解析不到（比如纯 node 跑自测）
  就退回原来的 StandardSchema 校验器。
- 预览弹窗：设置页「调试」组新增 `debugPreview`。打开后立刻弹一张**常驻**卡片——不倒数、不被 watchdog 收走、不被新提醒顶掉，可以慢慢拖动和缩放到满意；关掉开关时卡片自己收场，把位置和大小一起写进 placement 文件。宿主每秒看一次配置，写 stop 文件让卡片自己关窗（而不是杀进程），所以收场前位置一定已经落盘。
- 位置：默认贴着工作区右下角，而且量的是**看得见的边框**——窗口带 14px 透明阴影，多伸出的部分交给屏幕边缘裁，
  于是边框正好离边 `margin`（旧版贴的是窗口，边框实际离边 30px，看着像「没对齐」）。
  你拖过或缩过之后新位置会记住（`%LOCALAPPDATA%\dsh-nudge\placement.json`），之后的卡片回到那里；
  位置如果已经不在任何显示器上就自动回落到右下角。配置项 `rememberPosition` / `placementFile`，`shown` 状态行新增
  `placement`（`corner` / `remembered`）、`placedLeft` / `placedTop` / `padPx`。

**性能**

- 原生类型（`Native.Win` 那堆 DllImport）只编译一次：第一次用 `Add-Type -OutputAssembly` 落到
  `%LOCALAPPDATA%\dsh-nudge\bin\native-<源码哈希前 16 位>.dll`，之后每次用 `Assembly::LoadFile` 读回来。
  每次弹卡都要重编译那道工序从 191ms 降到 45ms。
- WPF 程序集推迟到真要把卡片画出来时才加载，顺手去掉了全脚本没用到的 `System.Drawing`；
  被抑制（前台是全屏/静音时段/开关关掉）的那条路径完全不碰 WPF。
- 新增 `-Trace`：把每段耗时（`payload` / `visible` / `card` / `measure` / `window` / `shown` / `closed`）
  以 `trace <阶段> <毫秒>` 写到 **stderr**——stdout 是宿主解析的状态协议，不能混。
- 实测（本机，2560×1440 / 100%）：清单快照 776ms → 约 450ms；一张真实卡片从进程启动到 `shown` 约 560ms，
  其中 PowerShell 自身启动 ~107ms。剩下的大头是 WPF 冷启动（首张卡搭视觉树 ~224ms，同一个进程里第二张只要 ~1ms）。
  要再往下压只能上「常驻 helper」，代价是一个常驻进程的内存。
**修复**

- 全屏抑制误伤「桌面」与「最大化窗口」：这两类窗口的矩形都铺满整块显示器，原来的矩形比较会把它们判成
  「正在全屏玩游戏」，于是卡片被整批丢弃——什么都不点、前台只剩桌面时，卡片一条都弹不出来
  （`selftest` 里真起窗口的五条因此全红）。现在先排除桌面/任务栏（`GetShellWindow()`、`Progman`、
  `WorkerW`、`Shell_TrayWnd`）与最大化窗口（`IsZoomed`，Win10 起最大化返回扩展边框），再比矩形。
  真起窗口的自测也改用 `suppressWhenFullscreen: false`，结果不再取决于跑自测时桌面在干什么。

**文档与测试**

- README 加了截图区：三态并排、4 条提醒合并成一张清单、浅色卡片、以及把卡片拖到 300 / 520 宽的样子。
  这些图不是效果图——是 `selftest` 用**同一个** WPF 渲染器在离屏窗口里画出来的快照，和真实弹出来的是同一套代码。
- `screenshots/multi.png` 改成由 selftest 生成（新增 `multi` 快照：4 条提醒 / 3 个项目），并进像素基线；
  删掉三张旧版式的手工图 `single.png` / `single-choice.png` / `single-done.png`，免得图与版式各说一套。
- 自测项 99 → 166（`--no-live` 时 143；再设 `DSH_NUDGE_SCHEMASTERY` 指向 schemastery 时 172，多出 6 条 schema 断言）：清单快照的三条断言 + 基线比对、浅色快照、7 条配色配置校验、
  3 条配色/调试开关的源码断言、一条「桌面/任务栏/最大化窗口不算全屏」的源码断言，以及一条「调试开关能由插件配置打开」的实跑。
  基线里三态与清单显式钉成深色、`light.png` 单独一条（暗像素从 7 万多降到 817，确实换了一套底）。
- 新增 7 条实时配置断言（读到初始值、改了就变、非法值不炸且沿用旧值、不污染 `DEFAULTS`、
  volatile 引用被 deref、模拟宿主就地改引用后立刻生效）与 6 条 schema 断言（可重建、15 个顶层 volatile 字段、
  `kinds` 子字段各自 volatile、`popupScript` 不是 volatile、设置表单收得进去、schema 解析出的配置也立刻生效）。
- 新增 15 条设置页断言，**离线**用 `node:vm` 跑 `client.js`（假 `__ModuleLoader__` + 假 React，不开浏览器）：
  bundle 注册 id、`inject` 只有 `slots`/`configForms`、注册进 `settings.section`、id 是 `nudge`、顺序 20、
  标题是中文、六个分组的文案、17 个控件、10 个 checkbox、配色三选项、静音时段预填、
  以及「点开关写出多段路径 + 带 revision」；另有两条源码断言盯着 `exports["./client"]` / `dsh.client` 与
  `configure({ auto: false })`。

## 0.3.2 - 2026-10-26
**工程与测试**

- 修 CI：`run:` 块里的输出与 `::error::` / `::warning::` 文案改成 ASCII。GitHub 会把脚本落成
  无 BOM 的 UTF-8，Windows PowerShell 5.1 按 ANSI 读，中文串会吃掉引号直接语法错——v0.3.1 那次
  两个 run 全红就是这个原因。插件运行时没有变化，只是把 CI 弄绿。
- 顺带把「PowerShell 能解析」那步改成逐个文件单独 `ParseFile` 并打印出错文件，红的时候能直接看出是谁。

## 0.3.1 - 2026-10-26
**工程与测试**

- 加了 CI（`.github/workflows/selftest.yml`）：每次 push / PR 在 `windows-latest` 上跑
  `node --check`、PowerShell 脚本解析、`selftest.mjs --no-live`（runner 没有交互桌面，跳过真起窗口那两段），
  外加一条版本号自洽检查（`package.json` 与 `CHANGELOG` 标题必须一致，`index.json` 落后只告警）。
- 快照有了基线（`tools/snapshot-baseline.json`）：三态与两种宽度的像素统计（宽高 + distinct / dark / text / accent）
  固化进仓库，selftest 每次渲染完就比对，宽高必须一致、计数允许 ±2%。改版式后跑
  `selftest.mjs --update-baseline` 重生成，忘更新就会红。
- 自测项 91 → 99（`--no-live` 时 89），新增每条快照的「不是空白图」断言与 5 条基线比对。
- 发版收口成一条命令：`tools\release.ps1 -Version 0.3.1`（支持 `-DryRun` / `-SkipChecks` / `-NoPush` /
  `-NoRelease` / `-Title`），依次做自测 → 改版本号 → 改 CHANGELOG 标题 → 改 README 的「当前版本」与版本一览 →
  提交 → 打 tag → 改 `index.json` 指针 → `gh release create` → push。
- 记一条 PowerShell 的坑：脚本里写中文必须存成 **UTF-8 with BOM**，Windows PowerShell 5.1 会把无 BOM 的
  UTF-8 按 ANSI 解，中文串会把后面的引号吃掉，`Parser::ParseFile` 直接报一堆语法错
  （顺带：用编辑器改带 BOM 的文件后要确认 BOM 还在，很多工具保存时会丢掉）。
- 记一条正则的坑：`[regex]::Replace(input, pattern, replacement, 1)` 的第 4 个参数是 `RegexOptions`
  不是「替换次数」，传 1 等于 `IgnoreCase` 且替换全部匹配——改 README 表格时因此插了两遍。

## 0.3.0 — 2026-10-26

**变更**

- 卡片字号层级改成「项目 > 任务 > 问题」：项目文件夹名 15.5/15 半粗排在第一位（原来是任务名最大、
  项目挤在最后一行 11px），任务名降到 12.5，成败与原因降到 10.5。单条与清单两条路径一致；
  清单里每条也是「项目 → 任务名 → 明细」三行，明细为空就只排两行。
- 项目名前面的文件夹图标（Segoe MDL2 Assets `0xE8B7`）整段删掉：10.5-11px 下它看起来就是个方块，
  和「最大的字」抢注意力；删掉后项目名直接顶到左边，省下的 16px 归给 `CharacterEllipsis` 的截断宽度。
- 停留时长默认 `staySeconds` 8 → 15 秒（条目越多越久仍 +2 秒/条），「需要你选择」乘三且下限抬到
  30 秒：实测完成单条 15 秒、失败 2 条 17 秒、完成 3 条 19 秒、待选择单条 45 秒、待选择 4 条 63 秒。
  鼠标移进卡片会重置计时，右键随时关掉，新增的时间不会挡住你正在做的事。

**新增**

- 全屏时不打扰（`suppressWhenFullscreen`，默认开）：前台是全屏应用（游戏、放映、演示）时整批不弹。
  两道**只读**判断：`SHQueryUserNotificationState` 返回 1/2/3/4/7 视为勿扰；再看前台窗口是否正好盖满
  它所在显示器的物理矩形（抓「无边框全屏」的游戏和 F11 浏览器，普通最大化因为露出任务栏不算全屏）。
  不装钩子、不抓输入、不碰游戏窗口，鼠标键盘完全不受影响；被跳过的批次直接丢弃（不排队），
  状态行写 `{"type":"suppressed","reason":"fullscreen","state":N}`。
- payload 落盘调试开关：设 `DSH_NUDGE_DEBUG_PAYLOAD=1` 后，每次弹卡把 `{at, payload}` 追加到
  `DSH_NUDGE_DEBUG_FILE`（默认临时目录下 `dsh-nudge-payloads.jsonl`），事后能核对「卡片上到底写了什么」。
  写失败只留一条 debug 日志，绝不影响弹卡。

**性能**

- 原生类型（`Native.Win` 那堆 DllImport）只编译一次：第一次用 `Add-Type -OutputAssembly` 落到
  `%LOCALAPPDATA%\dsh-nudge\bin\native-<源码哈希前 16 位>.dll`，之后每次用 `Assembly::LoadFile` 读回来。
  每次弹卡都要重编译那道工序从 191ms 降到 45ms。
- WPF 程序集推迟到真要把卡片画出来时才加载，顺手去掉了全脚本没用到的 `System.Drawing`；
  被抑制（前台是全屏/静音时段/开关关掉）的那条路径完全不碰 WPF。
- 新增 `-Trace`：把每段耗时（`payload` / `visible` / `card` / `measure` / `window` / `shown` / `closed`）
  以 `trace <阶段> <毫秒>` 写到 **stderr**——stdout 是宿主解析的状态协议，不能混。
- 实测（本机，2560×1440 / 100%）：清单快照 776ms → 约 450ms；一张真实卡片从进程启动到 `shown` 约 560ms，
  其中 PowerShell 自身启动 ~107ms。剩下的大头是 WPF 冷启动（首张卡搭视觉树 ~224ms，同一个进程里第二张只要 ~1ms）。
  要再往下压只能上「常驻 helper」，代价是一个常驻进程的内存。
**修复**

- 高 DPI / 多显示器定位：helper 改为逐显示器 DPI 感知（`SetProcessDpiAwarenessContext(-4)` →
  `SetProcessDpiAwareness(2)` → `SetProcessDPIAware()` 三级降级），边距按目标屏 `GetDpiForMonitor`
  放大，并在 `Loaded` 后按物理像素把窗口再钉一次到工作区右下角。旧实现是系统级 `SetProcessDPIAware`，
  `MonitorInfo.rcWork`（物理像素）与 WPF 的 `Left/Top`（DIP）在缩放屏上不同量纲，卡片会偏出角落。
- 点击卡片写入剪贴板的抬头改由 payload 下发（`clipboardHeader`），不再写死
  `DeepSeekRuntime session alert`；`popup.ps1` 仍保持纯 ASCII，旧宿主未传该字段时回落到英文抬头。
- 点击聚焦到**提醒来源的那个实例**：helper 的直接父进程（Host）与宿主主进程同名但没有窗口，
  旧实现「按进程名取第一个有窗进程」在同时开两个 DSH 时会聚焦错实例。改用 Toolhelp32 快照
  一次性取 pid→父 pid 表，回溯祖先链取最外层的同名有窗进程（实测命中 Electron 主进程 8592，
  而不是父进程 13992）；找不到祖先时回退旧行为。`shown` 状态行新增 `owner` / `ownerSrc`
  便于自证，且改为弹出时就解析，点击路径不再等 lookup。
- 同一时刻只留一张卡：以前每个 helper 各算同一个右下角，两个 DSH 实例各弹一张就会叠在一起，
  计时与点击目标互不知情。现在用 `Local\dsh-nudge-card` 互斥量选主，后来者 Set
  `Local\dsh-nudge-replace` 事件把在位那张请走（200ms 轮询、UI 线程关窗）再接管；
  `shown` 新增 `slot`（`owner` / `replaced` / `parallel`）。命名对象不可用时退回旧行为，不会不弹。
- 剪贴板写入失败不再静默：`Set-Clipboard` 被别的程序占着时会抛异常，旧代码用空 `catch` 吞掉，
  用户以为复制了其实没有。关窗时补一条 `{"type":"closed","reason":…,"clipboard":true|false}` 状态行，
  宿主日志能看见；同时补齐 `clicked` / `dismissed` / `timeout` / `replaced` / `watchdog` 五种关窗原因。
- 非 Windows 平台不再空转：`createPlugin` 在 `process.platform !== "win32"` 时直接返回，
  不注册任何监听。`package.json` 的 `os` 字段只在安装期拦，开发态或容器里跑会每个回合 spawn 失败刷警告。

**测试**

- 自测 70 → 91 项：修掉三条已经和实现脱节的用例名（「主角行是任务名（最大的字）」「最少停 20 秒」），
  停留时长断言从松阈值改成具体值（15 / 19 / 45 秒），并新增 7 条源码静态约束——`popup.ps1` 必须
  纯 ASCII、不许出现图标字形 `0xE8B7`、字号阶梯必须是 15.5 / 15 > 12.5 > 10.5、清单行项目名必须排在
  任务名前、单卡槽位与替换事件必须在、`closed.clipboard` 必须在、payload 必须带剪贴板抬头。
  再补 3 条全屏抑制与调试开关的静态约束，以及第 7 组**真跑两张卡**验证单卡互斥
  （A `slot:"owner"` → B `slot:"replaced"` → A `closed/replaced` → B `closed/timeout`，
  顶替在 3 秒内完成），同一段流程顺带验证 payload 每次落盘两行。

**兼容**

- payload 只新增一个可选字段，新旧 `index.js` / `popup.ps1` 混装都不会报错（helper 侧有默认值）。
- 状态行只增不改：`shown` 多出 `slot`，并新增 `closed` 一种类型；宿主侧按行解析、未知类型忽略，
  旧宿主不会因为多一行而报错。
- `suppressed` 补了 `reason`（`foreground` / `fullscreen`）与 `state`（系统通知状态码）两个字段，
  旧解析只认 `type`，多出的字段不影响。
- 排版与停留时长的改动只在 `lib/` 内，不改 payload 结构；`screenshots/*.png` 已按新排版重新渲染，
  `VERIFY.md` 的像素统计同步更新。

## 0.2.1 — 2026-10-24

**性能**

- 原生类型（`Native.Win` 那堆 DllImport）只编译一次：第一次用 `Add-Type -OutputAssembly` 落到
  `%LOCALAPPDATA%\dsh-nudge\bin\native-<源码哈希前 16 位>.dll`，之后每次用 `Assembly::LoadFile` 读回来。
  每次弹卡都要重编译那道工序从 191ms 降到 45ms。
- WPF 程序集推迟到真要把卡片画出来时才加载，顺手去掉了全脚本没用到的 `System.Drawing`；
  被抑制（前台是全屏/静音时段/开关关掉）的那条路径完全不碰 WPF。
- 新增 `-Trace`：把每段耗时（`payload` / `visible` / `card` / `measure` / `window` / `shown` / `closed`）
  以 `trace <阶段> <毫秒>` 写到 **stderr**——stdout 是宿主解析的状态协议，不能混。
- 实测（本机，2560×1440 / 100%）：清单快照 776ms → 约 450ms；一张真实卡片从进程启动到 `shown` 约 560ms，
  其中 PowerShell 自身启动 ~107ms。剩下的大头是 WPF 冷启动（首张卡搭视觉树 ~224ms，同一个进程里第二张只要 ~1ms）。
  要再往下压只能上「常驻 helper」，代价是一个常驻进程的内存。
**修复**

- `tool/result` 改按 `message.isError` 判断失败：普通工具错误不再漏报（`data.error` 只在 HarnessError 时出现）；明细优先取工具结果正文，而不是只显示错误码。
- 审批卡片改用 `displayReason / reason / toolName`：不再永远显示「等待你批准一个操作」。
- 组合包补丁的 `maxItems` 与代码默认值对齐（5 → 8）；索引和标签指向包含该修复的提交。
- 卸载 `userQuestions.ask` 包装时还原成原函数，不再在服务对象上留下绑定旧实现的 own property。
- `turn/end` 的 `blocked` 归为失败提醒，不再显示绿色「任务完成」。
- 标题改为从 `sessionTitle` 服务读取（`SessionHeader` 没有 `title` 字段）；子代理会话不再单独弹窗。
- 合并卡片按完整时间戳排序，跨零点时 `00:01` 不会排到 `23:59` 后面。
- `flush()` 兜住 runner 异常并清掉挂着的定时器；stdout 状态行支持跨 chunk 拼接。
- 静音时段与 `kinds` 增加严格的类型/范围校验；`os` 限定 `win32`。

**测试**

- 自测 70 项，新增 `createPlugin` 事件接线用例：`turn/end`、`tool/result`、`approval/request`、`userQuestions.ask`、dispose 还原与 rejection 透传；以及标题服务、`blocked`、子代理过滤、异常 runner、跨 chunk、跨零点排序。

## 0.2.0 — 2026-10-23

**读得清**

- 多条提醒不再折叠成一行：每条两行（任务名 / 「📁 项目 · 明细」），右侧竖排「完成 · 待批准 · 失败」标签 + 时间。
- 卡片外框按最严重的状态染色：失败泛红、待批准泛黄。
- 失败/待批准的报错内容精简后再上卡（去掉堆栈帧，最长 140 字），明细最多折叠到 6 行。
- 单条提醒：任务名（或精简后的错误）做主角行，项目单独一行。

**不打扰**

- 卡片是 `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` 窗口：永不被激活、不进 Alt+Tab、不抢键盘焦点。
- 纯点击不进入系统拖动/缩放循环（位移 > 4px 才算拖动），弹出后 320ms 内的点击被忽略。
- 鼠标移进卡片会重置停留计时；另有绝对生命周期兜底，卡片不会被钉在屏幕上。
- 右键只关闭卡片，不切换焦点、不写剪贴板。

**能摆布**

- 窗口可拖动、可从四边和对角缩放，内容按当前宽度重新排版。
- 卡片出现在 DSH 窗口所在的那块屏幕（退化顺序：DSH 窗口 → 光标所在屏 → 主屏）。
- 去掉滚动条：卡片按内容长高，最小高度随内容重算。

**细节**

- 任务名超过 42 字按整字截断并补 `…`；标题区最多三行，最窄 260 宽也装得下，不会被 WPF 在半行处硬切。
- 「需要你选择」的卡片停留时间是普通卡片的三倍、最少 20 秒——这类提醒要你动手，8 秒瞥一眼就没了等于没提醒。
- 多条清单里成功的条目不再写「回合已完成」这种废话，第二行只留项目名。
- 清单里的状态词统一成「完成 / 待你选择 / 失败」，与单条卡片一致（原来是「待批准」）。

**其它**

- 一次最多列 8 条（`maxItems`）；点击复制的内容上限 20 条。
- 自测 37 项（含内容逻辑、快照像素、真 helper 生命周期）。

## 0.1.0 — 2026-10-22

- 首版：任务完成 / 需要你选择 / 执行失败三种时刻各弹一张置顶卡片，点击聚焦 DSH 并复制摘要，超时自动关闭。
