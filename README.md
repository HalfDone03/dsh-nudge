# dsh-nudge

[![selftest](https://github.com/HalfDone03/dsh-nudge/actions/workflows/selftest.yml/badge.svg)](https://github.com/HalfDone03/dsh-nudge/actions/workflows/selftest.yml)

DSH（DeepSeek Harness）插件：会话里**任务完成**、**需要你选择**、**执行失败**时，
在桌面**右下角**弹一张置顶小卡片提醒你处理。点一下卡片回到 DSH 窗口，并把这批提醒复制到剪贴板。

![三种状态](screenshots/needs_choice.png)

## 它解决什么

DSH 的回合经常跑很久，或者卡在等你批准/回答上，而你切到别的窗口去了。
这个插件在三种时刻各弹一张卡片（深色玻璃质感、圆角、不抢焦点、盖在任务栏上方）：

| 时刻 | 触发来源 | 卡片标题 |
| --- | --- | --- |
| 回合正常结束 | `session/event` → `turn/end`，`reason.kind` 为 `completed` / `max-tokens` | 任务完成 |
| 回合被策略拦截 | `turn/end`，`reason.kind === 'blocked'`（归档会话、过期 goal 等） | 执行失败 |
| 等你批准或回答 | `approval/request` 事件、`userQuestions.ask()` 被调用 | 需要你选择 |
| 回合或工具失败 | `turn/end` 的 `reason.kind === 'error'`、`tool/result` 报错 | 执行失败 |

几张卡片同时到达时，1.2 秒合并窗口内的事件会合成一张，标题取最严重的那个，右上角显示累计条数。
子代理会话（`delegationDepth > 0` 或有 `parentSession`）不单独弹，避免每个子任务都响一次。

## 版本

当前 **0.3.2**（2026-10-26）。逐条改动看 [CHANGELOG.md](CHANGELOG.md)，
带说明的发布记录在 [Releases](https://github.com/HalfDone03/dsh-nudge/releases)，
市场索引指向的具体提交写在仓库根目录的 `index.json`。

| 版本 | 日期 | 一句话 |
| --- | --- | --- |
| 0.3.1 | 2026-10-26 | CI、快照像素基线与一条命令发版 |
| 0.3.0 | 2026-10-26 | 版式改成「项目 > 任务 > 原因」、默认停留 15 秒、全屏时不打扰、同一个时刻只留一张卡、点击聚焦提醒来源的那个实例 |
| 0.2.1 | 2026-10-24 | 工具失败按 `message.isError` 判定、审批卡片带上下文、标题走 `sessionTitle` 服务、排序与缓冲修正、子代理过滤 |
| 0.2.0 | 2026-10-23 | 卡片跟随 DSH 所在屏幕、右键只关闭、补不抢焦点与拖动缩放 |
| 0.1.0 | 2026-10-22 | 首版：三种时刻各弹一张置顶卡片，点击聚焦 DSH 并复制摘要 |

## 安装

两种装法：**有 Discover 入口就用 A（三步，推荐）**，没有就走 B / C。

### A. 插件市场里一键装（DSH 0.2.1+）

`Plugins → Discover → Index sources → 添加`，粘贴：

```
https://gcore.jsdelivr.net/gh/HalfDone03/dsh-nudge@main/index.json
```

回到 Discover 就能看到「DSH 轻推提醒」，点安装。市场自己写 profile、跑 pnpm，装完重开 DSH 生效。
索引是标准的 format 1，`source` 用 git 提交钉死（仓库根目录 `index.json` 的 `source.commit`），装到的一定是 `0.3.0` 这一版。

上面那条不通就换镜像（同一份内容，路径一样）：

```
https://fastly.jsdelivr.net/gh/HalfDone03/dsh-nudge@main/index.json
https://testingcf.jsdelivr.net/gh/HalfDone03/dsh-nudge@main/index.json
https://cdn.jsdmirror.com/gh/HalfDone03/dsh-nudge@main/index.json
```

两个坑：

- **别用 `raw.githubusercontent.com`**——国内常年连不上，一条索引读不出来整个 Discover 就是空的；
- **别用 `@v0.3.0`**——jsDelivr 对标签会永远返回打标签那一刻的 `index.json`，那份里的 `commit` 还是旧指针。用 `@main`。

这条要求机器上有 `git`（pnpm 拉 `git+https` 规格要用它）。没有 git 就走 C。

### B. 手动安装（有 git）

```powershell
git clone --branch v0.3.0 https://github.com/HalfDone03/dsh-nudge.git
cd dsh-nudge

# 只看计划，不写文件
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -DryRun

# 真正安装（会先备份 profile 的 package.json）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

### C. 没有 git

下这个压缩包解压，进目录跑 B 里那两条命令：

```
https://codeload.github.com/HalfDone03/dsh-nudge/tar.gz/refs/tags/v0.3.0
```

（npm 上装不到：`dsh-nudge` 这个名字已被别人占用。）

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
    staySeconds: 15        # 卡片停留秒数，1..600，默认 15；待选择的卡片另按三倍算（不少于 30 秒）
    margin: 16             # 距屏幕工作区右下角的边距，默认 16
    maxItems: 8            # 一张卡片最多列几条（1..20），超出显示「还有 N 条未展开」
    showWhenFocused: true  # DSH 在前台时也弹；设 false 则前台时不打扰
    suppressWhenFullscreen: true  # 前台是全屏应用（游戏/放映/演示）时整批不弹，默认开
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

两条路径：只有一条提醒时走“单条”，两条以上走“清单”。**两种排版都是项目名最大**——先看清是哪摊活，再看是哪个任务，最后才是报了什么。

单条（失败示例）：

```
────────────────────────────────────────────
▌ ✖ 执行失败 · 20:09

 dsh-nudge
 修构建脚本
 失败：vite build 找不到入口模块
 点击卡片回到 DeepSeek Harness
────────────────────────────────────────────
```

- `▌` 左侧 3px 强调色竖条，颜色跟随类型（完成 `#2ECC71` / 待选择 `#F5A623` / 失败 `#E74C3C`）；整张卡的外框也跟着泛色。
- `dsh-nudge`：项目文件夹名，15.5 半粗，**全卡最大的字**，一行截断——扫一眼就知道是哪摊活。名字前面不放图标：那个位置原来是 Segoe MDL2 Assets 的文件夹字形，小字号下就是个方块，删掉还把 16px 还给了截断宽度。
- `修构建脚本`：任务名，12.5，第二行，最多三行（超过 54px 按整字截断并补 `…`）。
- `失败：…`：第三行，状态词 + 一句话原因，10.5；失败和待选择带同色淡底板，完成只写「完成」。

多条（4 条、3 个项目）：

```
────────────────────────────────────────────
▌ ✖ 执行失败 ④ · 20:09
 ──────────────────────────────────────────
 ● dsh-nudge · 失败 · 20:09
   修构建脚本
   vite build 退出码 1
 ● web-console · 完成 · 20:02
   跑完 26 个单测
────────────────────────────────────────────
```

- 每条三行：项目（15 半粗，最大）→ 任务名（12.5）→ 明细（10.5）；右侧竖排「状态 + 时间」。
- 明细为空的条目只排两行（项目 + 任务名）——右侧已经写了「完成」，再补一句「回合已完成」是废话。
- 超出 `maxItems` 时底部出现「还有 N 条未展开」（文案由 JS 下发，脚本保持纯 ASCII）。

- 字体用 `Microsoft YaHei UI → Segoe UI → Arial` 回退链，中文不再掉进 Segoe UI。
- 高度由内容测量决定（`Measure` + `DesiredSize`），长明细换行不会撑破卡片，也不会留白。
- 出现时 180ms 淡入 + 10px 上滑；鼠标移进卡片边框提亮，同时重置停留计时。
- 停留时长：条目越多越久（`staySeconds + 2 × (条数-1)`，默认 15 秒起）；「需要你选择」再乘三且不少于 30 秒。
- 卡片内顺序：先按严重度（失败 > 选择 > 完成），同级别按时间倒序。
- `popup.ps1` 保持纯 ASCII，所有中文文案（标题/展开提示/底部提示）由 `index.js` 下发的 payload 提供。

## 交互

- **可拖动、可缩放**：按住卡片拖动即可换位置；把鼠标移到四边或四角（光标会变成缩放箭头）拖动即可改大小，最小 260×118。卡片是透明的无边框窗口，所以缩放走的是 `ReleaseCapture` + `WM_NCLBUTTONDOWN`，交给系统原生缩放循环处理。
- **内容自适应**：卡片宽度不再写死，文字、清单、项目标签都按当前可用宽度重新换行排版；拖大不会留白，拖小自动折行。
- **一眼看清是哪摊活**：字最大的永远是项目文件夹名，其次是任务名，最后才是一句话的成败原因（`失败：…` / `待你选择：…` / `完成`）。多条提醒逐条三行排版，右侧竖排「完成 / 待你选择 / 失败 + 时间」。不加滚动条，卡片按内容长高，窗口最小高度也跟随内容。
- **不打扰**：卡片不抢焦点、不抢鼠标——它是 `WS_EX_NOACTIVATE` 窗口，永不会被激活；只在指针真的移动超过 4px 时才开始拖动，纯点击不会进入系统拖动循环；弹出后 320ms 内落下的点击会被忽略。失败时整张卡的外框会泛红，扫一眼就知道出了事。
- **跟着你走**：卡片出现在 DSH 窗口所在的那块屏幕（取不到就退到光标所在屏，再退到主屏）；右键只关掉卡片，不切焦点、不写剪贴板。
- **自动消失**：`staySeconds` 秒后淡出（到点关闭，无残留进程）。
- **点一下**：把 DSH 窗口切到前台，并把提醒内容（标题 + 明细）放进剪贴板。
  DSH 的 Web GUI 是单页应用，没有「按会话 id 直达」的 URL，所以只能聚焦窗口 + 复制线索。
- **同一时刻只有一张卡**：按用户会话挂一个命名互斥量（`Local\dsh-nudge-card`），新的一批提醒通过 `Local\dsh-nudge-replace` 事件请上一张退场（200ms 内响应），再接管右下角——多开几个 DSH 也不会叠一屏。拿不到命名对象时退回旧行为（每批一张卡），不会因此不弹。
- **全屏时不打断你**：前台是全屏应用（游戏、放映、演示）就整批不弹，`suppressWhenFullscreen` 默认开。判定有两道：先问系统「现在适合打扰吗」（`SHQueryUserNotificationState`），再看前台窗口是否正好盖满物理屏——后者能抓住「无边框全屏」的游戏和 F11 浏览器，而普通最大化的窗口因为露出任务栏不算全屏。两个检查都是**只读查询**：不挂钩子、不抓输入、不碰游戏窗口，鼠标和键盘完全不受影响。被跳过的批次直接丢弃（不排队），状态行走 `{"type":"suppressed","reason":"fullscreen"}`。

## 发布

包已按可发布形态配好：`type: module`、`main`/`exports`、`dsh.bundle.patch`、
`files` 白名单（21 个文件、约 298 KB，只含 `lib`/`scripts`/`cordis.patch.yml`/README/VERIFY/CHANGELOG/`screenshots/*.png`；`docs/` 只留在仓库里）、
`engines: { node: ">=20.3.0", dsh: ">=0.2.1-rc.2" }`、`os: ["win32"]`、`publishConfig.access: public`。

```powershell
npm login
npm publish            # 名字带 scope 时用 npm publish --access public
```

发版走脚本，别手敲（手敲过几次，漏过踩 tag、漏过建 Release）：

```powershell
# 本机默认 ExecutionPolicy 不让直接跑 .ps1，所以用 powershell -File 的形式
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\release.ps1 -Version 0.3.1 -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\release.ps1 -Version 0.3.1
```

它按顺序做：挑 node 跑语法检查与 99 项自测 → 改 `package.json` 版本 → 把 `CHANGELOG.md` 顶部的
「未发布」换成本版标题 → 更新本文件里的「当前版本」与版本一览表格 → 提交 → 打附注 tag → 把 `index.json`
的 `versions[0]` 三字段指向这个提交并再提一条
`chore(release): 索引指向 x.y.z 最终提交 (<hash>)` → `gh release create --latest` → push `main` 与 tag。
`-NoPush` 只做本地、`-NoRelease` 免建 Release、`-SkipChecks` 跳过自测、`-Title "…"` 换掉 tag 里那句摘要
（默认取该版 CHANGELOG 第一条 bullet，去掉 markdown 记号后截 60 字）。

它做的事就是下面这三条**市场索引与发布记录**的收尾（`index.json` 在仓库根目录，jsDelivr 的 `@main` 直接读它）：

1. 改 `package.json` 的 `version`、把 `CHANGELOG.md` 顶部的「未发布」换成本版标题，提交后打 tag（`v<版本>`）；
2. 再提一条 `chore(release): 索引指向 x.y.z 最终提交 (<hash>)`，把 `index.json` 的
   `versions[0].version` / `publishTimestamp` / `source.commit` 指向上一步那个提交；
3. 建 GitHub Release：`gh release create v<版本> --title "v<版本> — 一句话" --notes-file <该版本的 CHANGELOG 段>`，
   最新一版再加 `--latest`。**只 push git tag 不会生成 Release**，仓库首页的「Releases」区块会是空的。

`@main` 上永远是最后一条索引，所以用户点「安装」拿到的就是 `source.commit` 钉死的那一版；
这也是为什么上文的坑里说「别用 `@v<版本>`」——标签里的 `index.json` 会停在当时那个指针。

发布前自检（`release.ps1` 里已经包含，手工时照抄）：

```powershell
& $node --check .\lib\index.js
& $node .\scripts\selftest.mjs      # 99 项全绿；CI 上跑的是 --no-live（89 项）
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

怎么知道有没有新版：看 [Releases](https://github.com/HalfDone03/dsh-nudge/releases)（每版都有一句话摘要），
或者直接看 [CHANGELOG.md](CHANGELOG.md)。市场里装的话，插件页出现「更新」按钮就是索引里已经有更高版本。

## 自测

不依赖真实会话，直接驱动插件逻辑与弹窗脚本：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node .\scripts\selftest.mjs              # 99 项，含真起窗口与双卡抢槽位
& $node .\scripts\selftest.mjs --no-live    # 89 项，跳过需要交互桌面的两段（CI 跑这个）
```

当前 **99 项全绿**，覆盖：配置校验与默认值、静音时段（含跨零点）、事件合并计数、
严重度排序、三类开关、真起弹窗并收到 `{"type":"shown"}` 与右下角坐标、dispose 后无孤儿进程、
三种状态各渲染一张 436px 宽快照（尺寸、非空与像素基线比对），以及一组源码静态约束——
脚本必须纯 ASCII、项目名前不许出现图标字形、字号阶梯必须是「项目 > 任务 > 原因」、
单卡槽位、剪贴板回报、全屏抑制的两道判断与调试开关不许被删。
最后一组会**真跑两张卡**：A 占位拿到 `slot:"owner"`，B 上来后 A 收到 `closed/replaced`、
B 标记 `slot:"replaced"`，验证「同一时刻只有一张卡」，顺带验证 payload 落盘。

快照有像素基线（`tools/snapshot-baseline.json`）：宽高必须一致，`distinct/dark/text/accent`
允许 ±2%。改了版式、确认新样子是对的之后跑一次：

```powershell
& $node .\scripts\selftest.mjs --update-baseline
```

忘了更新就会红，省得 README / VERIFY 里的数字自己漂。CI（`.github/workflows/selftest.yml`）
在每次 push / PR 上跑 `--no-live`，并检查 `package.json` / `CHANGELOG` / `index.json` 三处版本号是否自洽。

想核对「卡片上到底写了什么」（比如怀疑标题取错），把 payload 落盘打开：

```powershell
$env:DSH_NUDGE_DEBUG_PAYLOAD = "1"
$env:DSH_NUDGE_DEBUG_FILE = "$env:TEMP\nudge-payloads.jsonl"   # 可省略，默认写到临时目录
```

之后每次弹卡都会往该文件追加一行 JSON（`{at, payload}`）；写入失败只留一条 debug 日志，不影响弹卡。

快照模式可以单独跑，不需要会话也不需要屏幕：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -STA -File .\lib\popup.ps1 `
  -Snapshot .\screenshots\custom.png -PayloadB64 <base64 的 JSON>
```

## 文件

```
dsh-nudge/
├─ package.json          插件包声明（dsh.bundle.patch 指向 cordis.patch.yml）
├─ index.json            市场索引（format 1）：版本号 + 钉死的 source.commit
├─ cordis.patch.yml      bundle patch：把插件插进 Host 的插件图
├─ CHANGELOG.md          逐版改动（版本号以这里为准）
├─ lib/
│  ├─ index.js           插件逻辑：事件钩子、合并去重、配置校验、helper 进程管理
│  └─ popup.ps1          WPF 弹窗（纯 ASCII 脚本，含快照渲染模式）
├─ scripts/
│  ├─ install.ps1        注册进 profile（幂等、备份、失败回滚）
│  ├─ uninstall.ps1      从 profile 摘除
│  └─ selftest.mjs       99 项自测（`--no-live` 89 项、`--update-baseline` 重写像素基线）
├─ tools/
│  ├─ release.ps1        一条命令发版（自测→版本号→tag→索引指针→Release→push）
│  └─ snapshot-baseline.json  快照像素基线，改了版式要跟着重生
├─ .github/workflows/selftest.yml  CI：windows-latest 上跑 --no-live 与版本号自洽检查
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
  中文注释会乱码甚至语法错误；`popup.ps1` 里没有非 ASCII 字符。所有中文（含点击后写进
  剪贴板的抬头）都由 `lib/index.js` 的 payload 下发。
- **高 DPI 要按显示器算**：`MonitorInfo.rcWork` 是物理像素，而 WPF 的 `Left/Top` 是 DIP，
  系统级 DPI 感知下这两者在缩放屏上不同量纲，卡片会偏出角落。helper 先申请 per-monitor-v2
  感知（失败逐级降级到 per-monitor / system），边距按目标屏 DPI 放大，`Loaded` 后再用
  物理像素 `SetWindowPos` 钉一次；100% 单屏下这次校正是 no-op。
- **点击要聚焦「这个」实例**：helper 的直接父进程是 Host，和 Electron 主进程同名却没有窗口，
  所以「按进程名取第一个有窗进程」在同时开两个 DSH 时会切错窗口。改为用 Toolhelp32 快照回溯
  祖先链，取最外层的同名有窗进程（逐层 spawn CIM 要 530ms，快照是 1ms 级）。
- **一张卡只能有一个主人**：每个 helper 都算同一个右下角，两批提醒同时到就会叠在一起，各自的
  计时和点击目标互不知情。`Local\dsh-nudge-card` 互斥量选主，后来者 Set 一下
  `Local\dsh-nudge-replace` 事件把在位的那张请走（200ms 轮询、UI 线程上关窗），再接管位置。
- **剪贴板会失败，别装作成功**：`Set-Clipboard` 在别的程序占着剪贴板时会抛异常，旧代码把它包在
  空 `catch` 里，用户以为复制了其实没有。现在关窗时补一条 `{"type":"closed","reason":"clicked","clipboard":true|false}`
  状态行，宿主日志里能看见到底写没写成。
- **非 Windows 直接不注册**：卡片是 powershell + WPF 画的，`package.json` 的 `os` 只在安装期拦，
  开发态跨平台跑会每个回合 spawn 失败刷警告，所以 `createPlugin` 在非 win32 上早退。
- **要写中文的 PowerShell 脚本得存成 UTF-8 with BOM**：5.1 会把无 BOM 的 UTF-8 当 ANSI 解，
  中文串会把它后面的引号吃掉，`Parser::ParseFile` 报一堆「意外的标记」。
  `lib/popup.ps1` 因此干脆保持纯 ASCII；`tools/release.ps1` 有中文提示，所以带 BOM。
- **版式不能只靠人眼盯**：快照的尺寸和像素统计固化在 `tools/snapshot-baseline.json`，
  改完版式忘了重生基线，自测直接红——比等 README 里的数字和实际图悄悄分叉强。
