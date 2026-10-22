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
- selftest 输出 `ALL PASS (23 checks)`，退出码 0。

证据（实测）：

```
PASS  helper 回报 shown  --  [{"left":2172,"width":372,"top":1214,"type":"shown","count":2,"height":162}]
PASS  卡片贴右下角（left>屏宽*0.7）  --  left=2172, top=1214
PASS  dispose 后 helper 退出（无孤儿）  --  exitCode=null, signalCode=SIGTERM
ALL PASS (23 checks)
```

其中坐标是硬证据：屏幕 2560×1440、工作区高 1392、卡片 372 宽 162 高 →
`2560-372-16 = 2172`、`1392-162-16 = 1214`，正好贴在工作区右下角。

## 2. 三种状态的无头渲染（不需要屏幕）

```powershell
& $node .\scripts\selftest.mjs   # 已经包含这一步，产物在 screenshots\*.png
```

期望：`completed.png` 436×150、`needs_choice.png` 436×237、`failed.png` 436×181（412 = 卡片 384 宽 + 两侧 14px 阴影留白，再各加 12px 底色留白），均 >4KB。

## 2.5 窗口可拖动 / 可缩放

- 样式位包含 `WS_THICKFRAME`（`GetWindowLong(hwnd, GWL_STYLE) & 0x40000`），这是系统执行缩放的前提。
- 鼠标进入四边/四角 8px 感应区时光标变成 `SizeWE / SizeNS / SizeNWSE / SizeNESW`。
- 在感应区按下 → `ReleaseCapture()` + `SendMessage(hwnd, WM_NCLBUTTONDOWN, HT<edge>, 0)`，由系统接管缩放；卡片内部按下 → `DragMove()`，位移 < 4px 视为点击（回 DSH + 复制提醒 + 关闭）。
- 内容自适应可用 `-SnapshotWidth <px>` 验证：同一份 payload 在 240 / 300 / 384 / 560 宽下都能排版，宽度严格跟随参数（图片宽 = 卡片宽 + 28 阴影留白 + 24 底边 = +52）。

## 2.6 溢出滚动条

- 窗口比内容矮时不裁切，正文可滚：`ScrollViewer` 纵向 `Auto`、横向 `Disabled`。
- 滚动条的布局宽度被 ScrollViewer 锁在 17px（`ScrollBar.MinWidth` 由系统滚动条宽决定，样式里写 `Width` 无效，实测 `ActualWidth=17`、`MinWidth=17`）。因此把"看得见的部分"做成模板内 5px 右对齐的 Grid：外观是细条，布局仍占 17px。
- 像素校验（`screenshots/scrollbar.png`，卡片高 168、内容溢出）：滑块在 x≈404..408（5px 宽），y 37..104（68px 高），亮度 >95；滑轨同宽，亮度 50–70；内容放得下时该区域亮度与卡片底色一致（46），即滚动条不显示。

## 3.' 卡片图内容自证（纯像素，不需要屏幕）

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
completed:    436x150 distinct=133 dark=16077 accent=70 text=135
needs_choice: 436x237 distinct=229 dark=25107 accent=183 text=248
failed:       436x181 distinct=147 dark=19057 accent=132 text=401
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
