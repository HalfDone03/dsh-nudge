# 验收清单（VERIFY.md）

本文件给出**可复现**的验证步骤。每一步都写清「命令 → 期望结果 → 证据」。

## 0. 前置

- 不要重启 DSH 也能验证 1–3 步；第 4 步需要重启（Host 侧插件无热更新）。
- 打包的 node（PATH 里没有 node）：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
```

## 1. 语法与单元自测（不需要会话）

```powershell
& $node --check .\lib\index.js
& $node .\scripts\selftest.mjs              # 179 项，含真起 helper 与双卡抢槽位
& $node .\scripts\selftest.mjs --no-live    # 156 项，跳过需要交互桌面的两段（CI 跑这个）
```

期望：

- `node --check` 无输出、退出码 0。
- selftest 输出 `ALL PASS (179 checks)`，退出码 0（CI 上是 `156 checks`；指 `DSH_NUDGE_SCHEMASTERY` 给 schemastery 目录时 186 条）。

证据（实测）：

```
PASS  helper 回报 shown  --  [{"width":412,"height":164,"type":"shown","slot":"owner","scale":1,"left":2146,"placedLeft":2146,"placedTop":1226,"padPx":14,"top":1226,"placement":"corner","dpi":"per-monitor-v2","owner":23876,"count":1,"marginPx":16,"theme":"light","ownerSrc":"ancestor"}]
PASS  卡片在屏幕右下半区  --  left=2146, top=1226, 412x164
PASS  默认贴在右下角（不是记住的位置）  --  "corner"
PASS  物理坐标与 WPF 坐标一致  --  placed=2146,1226 left=2146,top=1226
PASS  可见边框按 margin 内缩（窗口多伸出阴影）  --  padPx=14, marginPx=16
PASS  位置文件里的点被沿用  --  {"placement":"remembered","placedLeft":300,"placedTop":200,...}
PASS  越界位置回落到右下角  --  {"placement":"corner","placedLeft":2146,...}
PASS  dispose 后 helper 退出（无孤儿）  --  exitCode=null, signalCode=SIGTERM
PASS  基线 completed 对得上  --  436x174 色 263/263 暗 72874/72874 亮 933/933 状态 352/352
ALL PASS (179 checks)
```

其中坐标是硬证据：屏幕 2560×1440、工作区高 1392、卡片 412 宽 —— 目标不是窗口贴角，
而是**可见边框**贴角。窗口带 14px 透明阴影 halo，所以窗口要向右下多伸出 `shadowPad`：
`2560-412-16+14 = 2146`、`1392-164-16+14 = 1226`（本次实测卡片高 164），
卡片边框于是落在 `2146+412-14 = 2544`（= 2560−16）与 `1226+164-14 = 1376`（= 1392−16）。
装 16px 的旧版贴的是窗口，边框实际离边 30px，这就是「看着没对齐」的来源。

## 1.5 快照基线与 CI（不需要屏幕）

- `tools/snapshot-baseline.json` 存着三态、清单（`multi`，4 条 / 3 个项目）、浅色（`light`）与两种宽度的像素统计（宽高 + `distinct` / `dark` / `text` / `accent`）。
  selftest 每次渲染完就跟它比：**宽高必须完全一致**，像素计数允许 ±2%（不同机器字体抗锯齿会有几个像素出入）。
- 改了版式、确认新样子是对的之后，跑一次 `& $node .\scripts\selftest.mjs --update-baseline` 重写基线；
  忘了更新就会红，而不是让 README / VERIFY 里的数字自己漂。
- `.github/workflows/selftest.yml` 在每次 push / PR 上跑 `--no-live`（runner 没有交互桌面，起不了真窗口），
  另外还检查 `node --check`、PowerShell 脚本能否解析、以及 `package.json` / `CHANGELOG` / `index.json` 三处版本号是否自洽。


## 1.6 实时配置（不需要会话）

设置界面能改的参数，改完必须立刻生效——宿主不会为了配置改动重新 apply 插件。

```powershell
& $node .\scripts\selftest.mjs --no-live   # 已经包含这一步
```

期望（这 7 条都在 `--no-live` 里，CI 也会跑）：

- `liveConfig` 读到初始值；把底层配置对象改了之后，同一个视图立刻读到新值（`30` / `light`）。
- 填非法值（`staySeconds: 999`）不抛错，沿用上一份能用的配置。
- 视图不污染 `DEFAULTS`。
- `volatile` 引用（`{ get(), [Symbol.for("cosmokit.volatile.write")] }`）会被 deref 成普通值；
  模拟宿主就地改写引用之后，视图立刻跟着变（`42` / `dark` / `failed: false`）。

证据（实测）：

```
PASS  配置对象被改后立刻读到新值  --  30/light
PASS  非法值沿用上一次可用的配置  --  30
PASS  实时配置不污染 DEFAULTS  --  15
PASS  volatile 引用被 deref 成普通值  --  15/true
PASS  宿主就地更新引用后立刻生效  --  42/dark/false
```

设置界面能不能看见 nudge，取决于 `Config` 是不是带 volatile 字段的 Schemastery schema：

```powershell
$env:DSH_NUDGE_SCHEMASTERY = "<含 schemastery 的 node_modules 目录>"
& $node .\scripts\selftest.mjs --no-live   # 多跑 6 条 schema 断言
```

- 只有 `toJSON` + 至少一个 `.volatile()` 字段 + 条目 active 的插件会进表单，命名空间取 entry 的 id（这里是 `nudge`）。
- 顶层 14 个 volatile 字段 + `kinds` 三个子字段各自 volatile；`popupScript` **故意不 volatile**（换脚本要重启）。
- schema 默认值与 `DEFAULTS` 逐个一致；`theme` 的 `pattern` 拦得住 `rainbow`。

证据（实测）：

```
PASS  设置界面会收进表单  --  enabled,staySeconds,...,debugFile,kinds
PASS  Config 是可重建的 schemastery schema  --  object
PASS  schema 解析出的配置也立刻生效  --  30
```

## 1.7 自带的设置页（不需要浏览器）

```powershell
& $node .\scripts\selftest.mjs --no-live   # 这一段纯离线，CI 也跑
```

浏览器半身是 `client.js`（经典脚本，包在 `window.__ModuleLoader__.load({ id, factory })` 里）。
自测用 `node:vm` 造一个假的加载器 + 假 React（`useState` 直接返回初值、`useEffect` 空跑），
把 factory 与页面组件都真调一遍，所以不需要开 DSH 也不需要浏览器。

- 注册契约：`settings.section` / id `nudge`（= 配置命名空间）/ `order` 20（排在插件页 15 之后）/ 标题「提醒弹窗」。
- 只依赖 `slots` 与 `configForms` 两个服务；`inject` 里就这两项。
- 六个分组、16 个控件、开关全是 `checkbox`、配色是三个 `option` 的下拉、静音时段是预填 `22:00-08:00` 的 textarea。
- 点「任务完成」必须写出 `[{ op: "set", path: ["kinds", "completed"], value: false }]`（多段路径）且 revision 用快照里那份。
- `package.json` 同时有 `exports["./client"]` 与 `dsh.client.platform: "web"`；宿主侧有 `configure({ auto: false })`。

证据（实测）：

```
PASS  设置页注册进 settings.section  --  settings.section
PASS  设置页 id 用配置命名空间 nudge  --  nudge
PASS  设置页排在插件页之后  --  20
PASS  设置页控件数量  --  controls=16
PASS  设置页写嵌套配置带 revision  --  [{"ops":[{"op":"set","path":["kinds","completed"],"value":false}],"revision":7}]
PASS  宿主让设置服务别生成重复表单
```

装进 profile 后要看到这一页，得重启 DSH（`设置` 里多一项「提醒弹窗」）。

## 1.8 每张卡的开销（不需要会话）

```powershell
# 每段的毫秒数写在 stderr，stdout 留给宿主 parse 状态协议
powershell -NoProfile -ExecutionPolicy Bypass -File .\lib\popup.ps1 -Snapshot $env:TEMP\shot.png -PayloadB64 $payload -Theme dark -Trace
```

- 原生类型只编译一次：第一次 `Add-Type -OutputAssembly` 落到 `%LOCALAPPDATA%\dsh-nudge\bin\native-<哈希>.dll`，
  之后 `Assembly::LoadFile` 读回来。`trace native-compiled 191ms` → `trace native-cached 45ms`。
- WPF 程序集按需加载（`Initialize-UiRuntime`），并且不再加载用不到的 `System.Drawing`；被抑制的路径完全不碰 WPF。
- 实测（本机 2560×1440 / 100%）：离屏快照 776ms → 450 / 449 / 446ms；真实卡片从进程启动到 `shown` 约 560ms
  （`trace native-cached 45 / payload 64 / visible 26 / ui-runtime 6 / card 224 / measure 11 / window 44 / shown 141`）。
- 剩下的大头是 WPF 冷启动：同进程内画第二张卡只要 ~1ms，所以首张卡那 224ms 是字体/文本布局的一次性开销。

## 1.9 每一项的字号与颜色（不需要会话）

`typography` 是 8 类文字（`title` / `project` / `task` / `reason` / `status` / `time` / `more` / `footer`）
各自的 `{ color, size }`；留空 / 0 表示用主题默认，所以不配时版式与上一版逐像素一致。

- 配置：默认 8 类全是 `{ color: "", size: 0 }`（`字体默认全是「用默认」`）；只改一项时其余保持默认；
  `color: "red"` 抛 `must be "" or #RRGGBB / #AARRGGBB`；`size: 99` 抛 RangeError；`title: 1` 抛 `must be an object`。
- schema：`typography` 下 8 个角色、每个角色的 `color` 与 `size` 都带 `meta.volatile`（设置页才收这一组）。
- 源码：`popup.ps1` 有 `Resolve-Typography` / `Get-FontSize` / `Get-FontColor`，14 个文本调用点都改成
  `-Size (Get-FontSize '<角色>' <默认>) -Color (Get-FontColor '<角色>' <默认>)`；两处主题解析后各执行一次
  `$script:Fonts = Resolve-Typography $payload.typography`。宿主把 `typography` 放进 payload，并在预览期间
  发现字体变了就 `restartPreview()`（`previewRestart` 标记让重画跳过 3 秒冷却）。
- 设置页：预览关着时没有字体组（0 个颜色框）；打开后是 8 个颜色框 + 8 个字号框，颜色行带 `#RRGGBB` 写法提示；
  改一格写出 `[{op:"set",path:["typography","title","color"],value:"#FFFF0000"}]` 并带当前 revision。
- 真的进卡片（A/B 快照，临时目录里画，不污染 `screenshots/`）：`completed` 把标题改成 22 号纯红 →
  卡片高度 **174 → 182**，纯红像素 **0 → 861**。

```text
$env:DSH_NUDGE_SCHEMASTERY = '...\node_modules\@deepseek-ai'
& $node .\scripts\selftest.mjs --no-live
```

## 2. 三种状态的无头渲染（不需要屏幕）

```powershell
& $node .\scripts\selftest.mjs   # 已经包含这一步，产物在 screenshots\*.png
```

期望：`completed.png` 436×174、`needs_choice.png` 436×291、`failed.png` 436×152、`multi.png` 436×357（4 条 / 3 个项目）、`light.png` 436×188（浅色单条）（436 = 卡片 412 宽 + 两侧各 12px 底色留白；底边同样 12px），均 >4KB。

## 2.5 窗口可拖动 / 可缩放

- 样式位包含 `WS_THICKFRAME`（`GetWindowLong(hwnd, GWL_STYLE) & 0x40000`），这是系统执行缩放的前提。
- 鼠标进入四边/四角 8px 感应区时光标变成 `SizeWE / SizeNS / SizeNWSE / SizeNESW`。
- 想认真调位置和大小就开预览：`设置 → 提醒弹窗 → 调试 → 预览弹窗`。卡片常驻，拖动/缩放都不会被打断，关掉开关时自动把位置与大小写进 `%LOCALAPPDATA%\dsh-nudge\placement.json`。
- 在感应区按下 → `ReleaseCapture()` + `SendMessage(hwnd, WM_NCLBUTTONDOWN, HT<edge>, 0)`，由系统接管缩放；卡片内部按下 → `DragMove()`，位移 < 4px 视为点击（回 DSH + 复制提醒 + 关闭）。
- 内容自适应可用 `-SnapshotWidth <px>` 验证：同一份 payload 在 240 / 300 / 384 / 560 宽下都能排版，宽度严格跟随参数（图片宽 = 卡片宽 + 28 阴影留白 + 24 底边 = +52）。

## 2.6 多条提醒的可读性

- 阅读顺序按「先在哪、再是谁、最后怎么样」排：**项目文件夹名最大（单条 15.5px / 多条 15px SemiBold，`#FFFFFFFF`）**，第二行是任务名（12.5px，`#F0FFFFFF`），第三行才是成败与原因（10.5px，`失败：…` / `待你选择：…` / `完成`）。更早的版本把任务名放最大、项目压到最后一行，等于先告诉你"干了什么"却没说是哪摊活；现在按「项目 > 任务 > 问题」重排，单条与清单两条路径一致。
- 单条提醒的状态行放在淡色底板上（失败 `#24E74C3C`、待批准 `#24F5A623`），让"为什么"读起来像状态而不是正文；失败/待批准时 kind 词用各自 accent 色，冒号只在后面真跟着原因时才加。
- 不加滚动条：卡片按内容长高；窗口 `MinHeight` 每次缩放都按新宽度重算，把窗口拖矮时不会裁掉内容。
- 明细最多折叠到 6 行（`MaxHeight = 6 × LineHeight`，切在行边界上），窄卡片不会被超长报错撑爆。
- 卡片外框跟随最严重的 kind 染色：failed `#4DE74C3C`、needs_choice `#45F5A623`、其余 `#2BFFFFFF`，扫一眼就知道出事了。
- 不打扰：卡片是 `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` 窗口，永不被激活、不进 Alt+Tab；纯点击不进入系统拖动循环（位移 >4px 才算拖动）；弹出后 320ms 内的点击被忽略；移进卡片会重置停留计时。
- 定位：`MonitorFromWindow`（DSH 主窗口）→ `MonitorFromPoint`（光标）→ `SystemParameters.WorkArea` 三级退化，取 `rcWork` 右下角内缩 `margin`；实测本机 2560×1440、任务栏 48px、卡片 412×164 → `left=2146`、`top=1226`（=1392−164−16+14），其中 `+14` 是把窗口的透明阴影推到屏幕边缘外，让**可见边框**正好落在 `margin` 上。
- 预览模式（`popup.ps1 -Preview -StopFile <path>`）：卡片常驻，不启动停留计时器、不启动 watchdog、右键与单击都不关窗，也不参与单卡互斥（`Initialize-CardSlot` 直接返回 `owned`，`replacePoll` 不启动）——预览卡是用户手里的标尺，不能被新提醒顶掉。宿主每秒看一次配置：`debugPreview` 打开且没在跑就弹一张（距上次结束 <3 秒则等一等），关掉就写 stop 文件，卡片 250ms 内看到就关窗，关窗路径里先 `Save-CurrentPlacement` 再发 `{type:'closed',reason:'preview',preview:true,width,height}`。实测：`staySeconds=1` 的预览卡等 4 秒仍在（`["shown"]` 无 closed），`stopPreview()` 后收到 `{"reason":"preview","preview":true,"width":412,"height":150}`，`placement.json` 里写着 `{"left":2146,"top":1240,"width":412,"height":150}`。
- 只在真的动过之后才落盘：`Save-CurrentPlacement` 先看 `$script:placementDirty`（拖动结束、缩放结束、预览收场时置位）。否则每张卡关掉时都会把「右下角」写成 `remembered`，位置文件既没意义又会让「从没记过位置」这条断言失效——`selftest` 里因此改成每条用例用自己的临时位置文件。
- 记住位置：`Read-Placement` 读 `placement.json`，用 `MonitorBoundsOfPoint` 校验那个点是否还在某台显示器上；在就沿用它（状态行报 `placement: remembered`），不在就回落到右下角（`corner`）。`DragMove()` 与边界缩放循环返回后各调一次 `Save-Placement` 写回物理坐标。
- DPI 量纲：`rcWork` 是物理像素而 WPF 的 `Left/Top` 是 DIP，所以 helper 先申请逐显示器 DPI 感知（`SetProcessDpiAwarenessContext(-4)` → `SetProcessDpiAwareness(2)` → `SetProcessDPIAware()` 三级降级），用目标屏 `GetDpiForMonitor` 缩放边距并把工作区折算成 DIP 做初定位，`Loaded` 后再按 `GetWindowRect` + `SetWindowPos` 用物理像素校正一次。100% 单屏下校正量恒为 0，`placedLeft/placedTop` 与 WPF 的 `left/top` 实测一致（2146/1226）。
- 聚焦哪个实例：helper 的直接父进程是 Host，与 Electron 主进程同名但**没有窗口**，所以不能用
  「按名字取第一个有窗进程」（同时开两个 DSH 会聚焦错的实例）。改为 Toolhelp32 快照一次性拿
  pid→父 pid 表回溯祖先链，取最外层的同名有窗进程：实测链 `powershell(16416) → Host(13992)
  → Host(15648) → DeepSeek Harness(8592, hwnd 4851036) → explorer(7912)`，命中 8592；`shown`
  状态行回报 `owner=8592 / ownerSrc=ancestor`。快照方案把祖先查询从 530ms（逐层 CIM）压到
  1ms 级，helper 从 spawn 到 shown 仍是 1307ms（改前 1423ms）。找不到祖先时回退旧行为并记
  `ownerSrc=fallback`（实测 `-DsProcess msedge` → `owner=7396`，与 msedge 主窗口一致）。
- 右键只关闭：不调用 `Focus-Ds`、不写剪贴板，也不激活窗口（`WS_EX_NOACTIVATE`）。
- 标题上限：任务名按 `TITLE_LIMIT = 42` 截断（带 `…`），标题区 `MaxHeight = 63`（三行）。实测 42 字标题在 384 宽排两行、在最小 260 宽排三行，文字最右 281 < 内沿 285，三行都能完整显示。
- 停留时长：默认 `staySeconds = 15`（原来的 8 秒实测"还没看完就没了"），`stayFor()` 里条目越多越久（+2 秒/条），「需要你选择」再乘三且不少于 30 秒。实测：完成单条 15 秒、完成 3 条 19 秒、失败 2 条 17 秒、待选择单条 45 秒、待选择 4 条 63 秒。鼠标移进卡片会重置计时，右键随时关掉。
- 快照校验：`screenshots/` 里七张图全部由 selftest 用**同一个** WPF 渲染器离屏画出、并逐张与基线比对——
  `completed.png` 436×174、`needs_choice.png` 436×291、`failed.png` 436×152、`multi.png` 436×357（4 条 / 3 个项目，README 里当「合并且逐条可读」的样子）、
  `light.png` 436×188（浅色）、`width-300.png` 352×305、`width-520.png` 572×291。更早那批手工渲染的 `single*.png`（旧版式、带文件夹图标）已删除，避免图与版式各说一套。
  字号层级（`popup.ps1` 常量）：单条 = 项目 15.5 SemiBold → 任务名 12.5 → 原因 10.5；清单每条 = 项目 15 SemiBold → 任务名 12.5 → 明细 10.5。项目名前面**没有图标字形**：原来那处是 Segoe MDL2 Assets 的 `0xE8B7` 文件夹字，10.5-11px 下看起来就是个方块，已整段删除，省下的 16px 归给名字的截断宽度。

## 2.7 单卡互斥与关窗回报（不需要屏幕）

同一时刻只允许一张卡：每个 helper 都算同一个右下角，两批提醒同时到就会叠在一起，各自的计时和
点击目标互不知情。

- `shown` 状态行带 `slot`：`owner`（拿到 `Local\dsh-nudge-card` 互斥量）、`replaced`（顶掉了在位的那张）、
  `parallel`（命名对象不可用，退回旧的「每批一张卡」行为，不会因此不弹）。
- 后来的 helper 先 Set `Local\dsh-nudge-replace` 事件，在位那张每 200ms 轮询一次、在 UI 线程上关窗，
  互斥量随之让出。

实测（现在是 `selftest.mjs` 第 7 组的常驻用例，不再用临时探针：A 停 12 秒、B 停 2 秒）：

```
A 已弹出: {"width":412,"height":178,"type":"shown","slot":"owner",...}
A 之后收到: {"type":"closed","reason":"replaced"}
B 收到: {"width":412,"height":178,"type":"shown","slot":"replaced",...}
B 之后收到: {"type":"closed","reason":"timeout"}
```

- 关窗原因固定五种：`clicked`、`dismissed`（右键）、`timeout`（到点）、`replaced`（被新卡顶掉）、
  `watchdog`（绝对寿命兜底）。
- `clicked` 那条会带 `clipboard` 布尔值：`Set-Clipboard` 抛异常（剪贴板被别的程序占着）时是 `false`，
  宿主日志里能看见，不再假装复制成功。
- 非 Windows 平台 `createPlugin` 直接早退（`process.platform !== "win32"`），不注册任何监听——
  `package.json` 的 `os` 只在安装期生效，开发态跨平台跑会每个回合 spawn 失败刷警告。

## 2.8 全屏时不打扰（不需要屏幕）

游戏、放映、演示时照样弹卡会挡住画面；更麻烦的是，独占全屏的进程看到任何置顶窗口都可能自己最小化或闪一下。
所以 helper 在弹卡前做两道**只读**判断（`suppressWhenFullscreen`，默认开）：

1. `SHQueryUserNotificationState`（shell32）：返回 1（锁屏/屏保）、2（全屏应用忙）、3（D3D 全屏）、
   4（放映模式）、7（沉浸式全屏应用）时算「现在不适合打扰」；5（接受通知）与 6（新账号第一小时）不动。
2. 前台窗口矩形是否正好盖满它所在显示器的**物理**矩形（`rcMonitor`，容差 2px）。这条用来抓
   「无边框全屏」——系统查询在窗口化全屏下不会报全屏。

第 2 条会误伤两种「矩形=整块屏」的窗口，所以在比矩形之前先排除：

- **桌面本身**（`GetShellWindow()`，窗口类 `Progman` / `WorkerW`）与任务栏（`Shell_TrayWnd` /
  `Shell_SecondaryTrayWnd`）：它们铺满整块屏，但显然不是「正在玩游戏」。
- **最大化窗口**（`IsZoomed`）：Windows 10 起最大化窗口的 `GetWindowRect` 返回的是**扩展边框**，
  同样铺满整块屏，任务栏盖在它上面而不是在它外面——只看矩形会把它们全判成全屏。

这个误伤是真出过的：修之前台式机什么都不点（前台 = 桌面 `Progman`，矩形 `0,0,2560,1440`）时，
`selftest` 里真起窗口的五条全红，状态行是 `{"theme":"light","reason":"fullscreen","type":"suppressed","state":5}`
——卡片会被整批吞掉。修完用生产配置（`suppressWhenFullscreen: true`、前台是桌面）实测：

```
{"width":412,"height":164,"type":"shown","slot":"owner","theme":"light",...}
{"type":"closed","reason":"timeout"}
```

真起窗口的几段自测现在显式用 `suppressWhenFullscreen: false`（否则结果取决于跑自测时桌面在干什么），
抑制逻辑本身由第 6 组的源码断言钉住。

`$SuppressWhenFullscreen`：命中任一条就整批**丢弃**（不排队，卡片模板已经建好但不会 Show），
状态行写 `{"type":"suppressed","reason":"fullscreen","state":N}`，进程立刻退出。

实测证据（2560×1440、任务栏 48px 的普通桌面）：

```
QUNS state = 5 (hr=0)                       # 接受通知：不该抑制
foreground rect = -8,-8,2568,1400           # 我的终端（最大化，带隐形边框）
monitor bounds  = 0,0,2560,1440
foreground covers monitor = False           # 底部差 40px = 任务栏，正确判为「不是全屏」
```

抑制分支本身（把实时状态 5 临时列进勿扰集合的脚本副本，跑完即删）：

```
{"reason":"fullscreen","type":"suppressed","state":5}   exit=0
```

未打补丁的原脚本在普通桌面照常弹出：

```
{"width":412,"height":164,"type":"shown","slot":"owner",...}
{"type":"closed","reason":"timeout"}
```

两道检查都只是读系统状态与窗口矩形：不装钩子、不抓输入、不接触游戏窗口，鼠标键盘与游戏完全不受影响。
`selftest.mjs` 第 6 组用源码断言钉住这两道判断与宿主传参，防止被顺手删掉。

## 2.9 深浅两套配色（不需要屏幕）

`popup.ps1` 把颜色收成一套 token（`$script:CardTop/CardBottom/TextPrimary/…/ShadowOpacity`），
`Set-CardTheme` 一次赋一套值，深色是默认、浅色另配一套：

| token | dark | light |
| --- | --- | --- |
| `CardTop` / `CardBottom` | `#FF20242E` / `#FF171A22` | `#F7FBFCFE` / `#F4ECEEF3` |
| `TextPrimary` / `TextBody` | `#FFFFFFFF` / `#FFD8DDE6` | `#FF14171C` / `#FF23282F` |
| `TextMuted` / `TextFaint` | `#FF9AA3B2` / `#FF6E7686` | `#FF5B6472` / `#FF8A929E` |
| `CardEdge` / `RuleColor` | `#33FFFFFF` / `#1FFFFFFF` | `#22000000` / `#14000000` |
| `FrameBg` / `ShadowOpacity` | `#FF101218` / `0.45` | `#FFF0F2F5` / `0.18` |

取值顺序：`-Theme`（命令行，仅调试）→ payload 的 `theme`（来自插件配置）→ `auto`。
`auto` 读 `HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize\AppsUseLightTheme`，
`1` 走浅色、`0` 走深色，读不到按深色（老系统上没这个键）。

实测（`-Snapshot` 落 PNG 后取像素）：

```
dark  : 角 31,31,31    卡片顶 32,36,46
light : 角 240,242,245  卡片顶 248,249,251     # 本机 AppsUseLightTheme=1，auto 就是浅色
```

`shown` / `suppressed` / `snapshot` 三种状态行都带 `theme`，`selftest` 里 live 那段的 `shown` 现在是
`"theme":"light"`（这台机器系统是浅色），快照则显式钉成 `dark`（三态 + 清单）与 `light`（`light.png`），
避免「跟随系统」让基线与 CI 随机漂。

## 3. 卡片图内容自证（纯像素，不需要屏幕）

`screenshots\*.png` 是 `-Snapshot` 无头渲染的结果，再合成到纯色底（#1F1F1F，四周 12px 留白），
**不含任何桌面内容**，可以安全公开。`selftest.mjs` 每次重跑都会重新生成。

自证方法（不依赖看图，纯像素统计）：

```powershell
Add-Type -AssemblyName System.Drawing
foreach ($f in 'completed','needs_choice','failed') {
    $bmp = [System.Drawing.Bitmap]::FromFile(".\screenshots\$f.png")
    $seen = @{}; $dark = 0; $accent = 0; $text = 0
    for ($y = 0; $y -lt $bmp.Height; $y += 2) { for ($x = 0; $x -lt $bmp.Width; $x += 2) {
        $c = $bmp.GetPixel($x, $y); $seen["$($c.R),$($c.G),$($c.B)"] = 1
        if ($c.R -lt 70 -and $c.G -lt 70 -and $c.B -lt 80) { $dark++ }
        if ($c.R -gt 150 -and $c.G -gt 150 -and $c.B -gt 150) { $text++ }
        if (($c.G -gt 150 -and $c.R -lt 130) -or ($c.R -gt 200 -and $c.G -lt 120) -or ($c.R -gt 200 -and $c.G -gt 140 -and $c.B -lt 110)) { $accent++ }
    } }
    "{0}: {1}x{2} distinct={3} dark={4} accent={5} text={6}" -f $f, $bmp.Width, $bmp.Height, $seen.Count, $dark, $accent, $text
    $bmp.Dispose()
}
```

期望（实测）：

```
completed:    436x174 distinct=152 dark=18532 accent=117 text=254
needs_choice: 436x291 distinct=252 dark=30041 accent=286 text=523
failed:       436x152 distinct=157 dark=15540 accent=103 text=543
```

判定标准：
- 三张 MD5 必须互不相同（相同说明渲染没生效）
- `dark` 占采样区九成以上（卡片确实画出来了）
- `accent` 各自出现对应强调色（完成=绿、选择=琥珀、失败=红）
- `text` 大于 150（文字真的渲染了，不是一张空卡）
- 四角像素必须等于 `31,31,31`（纯色底，证明图里没有任何桌面内容）

> 上面这套是**手动**自证（隔点采样、阈值见脚本）。`tools/snapshot-baseline.json` 是 selftest 用的
> **自动**基线，统计口径不同（全像素、亮度阈值 40/150），所以两边的 `dark`／`distinct` 数字不能直接对照，
> 各自内部一致即可。改了版式两边都要重测：手动的重跑本段脚本，自动的跑 `--update-baseline`。

## 4. 装进 profile 后真跑（需要重启 DSH）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -DryRun   # 只看计划
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1            # 真装
```

期望：

- `-DryRun` 只打印 `dependency:` / `bundle list: append` / `dry run -- no files were written`，不改文件。
- 真装打印 `backup: …package.json.bak-<时间戳>` 与 `installed`，并在 profile 的
  `package.json` 里新增 `"dsh-nudge": "file:…"` 依赖和一条 bundles 条目。
- 再跑一次 → `already installed -- nothing to do`（幂等）。
- 卸载：`uninstall.ps1` → `uninstalled`；再跑一次 → `not installed -- nothing to do`；
  卸载后的 `package.json` 与安装前逐字段一致。

以上四点在临时 profile 上已实测通过（`-ProfileDir <临时目录>`，未触碰真实 profile）。

真机安装记录（2026-10-25，真实 profile `~\.dsh\profiles\desktop`）：DSH **运行中**直接跑 `install.ps1`
也成功——pnpm 只增量加了这一条依赖，没有重写既有包（`dshmarket` / `billion-context` /
`cc-safety-net` / `dsh-context` 都还在，`cordis.patch.yml` 修改时间仍是安装前），幂等重跑打印
`already installed`。注意落地形态是**目录拷贝**而非链接：本机 profile 的 `pnpm-workspace.yaml`
设了 `nodeLinker: hoisted`，`file:` 依赖会被复制进 `node_modules`，所以**改完源码要重跑
`install.ps1` 再重启 DSH 才生效**。判别方法：在源码 `lib\` 下建个临时文件，若
`node_modules\dsh-nudge\lib\` 里不出现，即证明是拷贝。

重启 DSH 后，用任意会话触发三种情况：

| 触发方式 | 期望 |
| --- | --- |
| 让一个回合正常跑完 | 右下角弹「任务完成」绿卡，15 秒后自动消失 |
| 让 Agent 调 `ask_user_question`，或触发一次需要批准的操作 | 弹「需要你选择」琥珀卡，等你处理 |
| 让一个回合报错（例如让工具失败） | 弹「执行失败」红卡 |
| 点击卡片 | 提醒来源的那个 DSH 实例被切到前台（按祖先链定位，不是「第一个同名进程」），剪贴板里是这批提醒的标题+明细 |
| 卡片显示期间关掉 DSH | helper 进程随之退出，不留孤儿窗口（`Get-Process powershell` 无新增常驻） |

## 5. 已知边界

- 只验证过**单显示器 2560×1440 @ 100%**；多显示器与高 DPI 已改为逐显示器 DPI 感知
  （`SetProcessDpiAwarenessContext(-4)` → `SetProcessDpiAwareness(2)` → `SetProcessDPIAware()`
  三级降级）+ 物理像素校正，逻辑上能对齐，但**仍未在真机多屏 / 非 100% 缩放上跑过**。
- 点击只能聚焦 DSH 窗口 + 复制线索：Web GUI 是单页应用，没有按会话直达的 URL。
- 聚焦按祖先链定位已实测（`owner=8592/ownerSrc=ancestor`），但**没有在真开两个 DSH 的情况下
  点过卡片**——再点一次会抢当前前台焦点，所以只验证了句柄来源，没验证「切过去」的可见效果。
- 卡片是「提醒」不是「操作面板」：批准/回答仍需回到 DSH 里做。
