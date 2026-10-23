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
& $node .\scripts\selftest.mjs
```

期望：

- `node --check` 无输出、退出码 0。
- selftest 输出 `ALL PASS (70 checks)`，退出码 0。

证据（实测）：

```
PASS  helper 回报 shown  --  [{"left":2132,"width":412,"top":1203,"type":"shown","count":2,"height":173}]
PASS  卡片在屏幕右下半区  --  left=2132, top=1203, 412x173
PASS  dispose 后 helper 退出（无孤儿）  --  exitCode=null, signalCode=SIGTERM
ALL PASS (70 checks)
```

其中坐标是硬证据：屏幕 2560×1440、工作区高 1392、卡片 412 宽 173 高 →
`2560-412-16 = 2132`、`1392-173-16 = 1203`，正好贴在工作区右下角。

## 2. 三种状态的无头渲染（不需要屏幕）

```powershell
& $node .\scripts\selftest.mjs   # 已经包含这一步，产物在 screenshots\*.png
```

期望：`completed.png` 436×177、`needs_choice.png` 436×250、`failed.png` 436×175（436 = 卡片 384 宽 + 两侧 14px 阴影留白，再各加 12px 底色留白），均 >4KB。

## 2.5 窗口可拖动 / 可缩放

- 样式位包含 `WS_THICKFRAME`（`GetWindowLong(hwnd, GWL_STYLE) & 0x40000`），这是系统执行缩放的前提。
- 鼠标进入四边/四角 8px 感应区时光标变成 `SizeWE / SizeNS / SizeNWSE / SizeNESW`。
- 在感应区按下 → `ReleaseCapture()` + `SendMessage(hwnd, WM_NCLBUTTONDOWN, HT<edge>, 0)`，由系统接管缩放；卡片内部按下 → `DragMove()`，位移 < 4px 视为点击（回 DSH + 复制提醒 + 关闭）。
- 内容自适应可用 `-SnapshotWidth <px>` 验证：同一份 payload 在 240 / 300 / 384 / 560 宽下都能排版，宽度严格跟随参数（图片宽 = 卡片宽 + 28 阴影留白 + 24 底边 = +52）。

## 2.6 多条提醒的可读性

- 阅读顺序按「先是谁、再怎么样、最后在哪」排：**任务名最大（单条 15.5px / 多条 13px SemiBold）**，第二行是成败与原因（11.5px，`失败：…` / `待你选择：…` / `完成`），第三行才是项目（11px，`#8AFFFFFF`）。之前把错误摘要当主角行，等于先告诉你"错在哪"却不说是哪个任务，已改。
- 单条提醒的状态行放在淡色底板上（失败 `#24E74C3C`、待批准 `#24F5A623`），让"为什么"读起来像状态而不是正文；失败/待批准时 kind 词用各自 accent 色，冒号只在后面真跟着原因时才加。
- 不加滚动条：卡片按内容长高；窗口 `MinHeight` 每次缩放都按新宽度重算，把窗口拖矮时不会裁掉内容。
- 明细最多折叠到 6 行（`MaxHeight = 6 × LineHeight`，切在行边界上），窄卡片不会被超长报错撑爆。
- 卡片外框跟随最严重的 kind 染色：failed `#4DE74C3C`、needs_choice `#45F5A623`、其余 `#2BFFFFFF`，扫一眼就知道出事了。
- 不打扰：卡片是 `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` 窗口，永不被激活、不进 Alt+Tab；纯点击不进入系统拖动循环（位移 >4px 才算拖动）；弹出后 320ms 内的点击被忽略；移进卡片会重置停留计时。
- 定位：`MonitorFromWindow`（DSH 主窗口）→ `MonitorFromPoint`（光标）→ `SystemParameters.WorkArea` 三级退化，取 `rcWork` 右下角内缩 `margin`；实测本机 2560×1440、任务栏 48px、卡片 412×173 → `left=2132`、`top=1203`（=1392−173−16），与旧主屏逻辑在同一屏上结果一致。
- 右键只关闭：不调用 `Focus-Ds`、不写剪贴板，也不激活窗口（`WS_EX_NOACTIVATE`）。
- 标题上限：任务名按 `TITLE_LIMIT = 42` 截断（带 `…`），标题区 `MaxHeight = 63`（三行）。实测 42 字标题在 384 宽排两行、在最小 260 宽排三行，文字最右 281 < 内沿 285，三行都能完整显示。
- 停留时长：`stayFor()` 里条目越多越久（+2 秒/条），「需要你选择」再乘三且不少于 20 秒（实测 24 秒）；其余仍是 8 秒起。
- 快照校验：`screenshots/multi.png` 436×337（4 条 / 3 个项目）、`screenshots/single.png` 436×234（失败单条）、`screenshots/single-choice.png` 436×234（待批准单条）、`screenshots/single-done.png` 436×205（完成单条）。像素实测的纵向文字带：头部 12px → 任务名 16px → 状态 12px → 原因 9-11px → 项目 10-11px，最大字号确实落在任务名上。

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
completed:    436x177 distinct=140 dark=19008 accent=135 text=169
needs_choice: 436x250 distinct=269 dark=25831 accent=263 text=405
failed:       436x175 distinct=171 dark=17774 accent=125 text=610
```

判定标准：
- 三张 MD5 必须互不相同（相同说明渲染没生效）
- `dark` 占采样区九成以上（卡片确实画出来了）
- `accent` 各自出现对应强调色（完成=绿、选择=琥珀、失败=红）
- `text` 大于 150（文字真的渲染了，不是一张空卡）
- 四角像素必须等于 `31,31,31`（纯色底，证明图里没有任何桌面内容）
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

重启 DSH 后，用任意会话触发三种情况：

| 触发方式 | 期望 |
| --- | --- |
| 让一个回合正常跑完 | 右下角弹「任务完成」绿卡，8 秒后自动消失 |
| 让 Agent 调 `ask_user_question`，或触发一次需要批准的操作 | 弹「需要你选择」琥珀卡，等你处理 |
| 让一个回合报错（例如让工具失败） | 弹「执行失败」红卡 |
| 点击卡片 | DSH 窗口被切到前台，剪贴板里是这批提醒的标题+明细 |
| 卡片显示期间关掉 DSH | helper 进程随之退出，不留孤儿窗口（`Get-Process powershell` 无新增常驻） |

## 5. 已知边界

- 只验证过**单显示器 2560×1440 @ 100%**；多显示器与高 DPI 走 `SystemParameters.WorkArea`
  与 `SetProcessDPIAware`，逻辑正确但未在真机多屏上跑过。
- 点击只能聚焦 DSH 窗口 + 复制线索：Web GUI 是单页应用，没有按会话直达的 URL。
- 卡片是「提醒」不是「操作面板」：批准/回答仍需回到 DSH 里做。
