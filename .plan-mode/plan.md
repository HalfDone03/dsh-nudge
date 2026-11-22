# 计划：语音播报到任务名 + 弹窗/播报提速

## Goal（目标）

1. **语音具体到任务**：preset 默认只念「任务完成了」，丢掉任务名；改为播报包含「完成了什么任务」。
2. **消除可感延迟**：实测 push→spawn 1208ms（合并窗口）+ helper 冷启动→shown 1743ms ≈ 3 秒；压到 <1 秒。

## 勘察证据（已实测，✅可命令）

- `lib/index.js:121-147` `speechTextOf()` 会拼 `{label}：{headline}`（带任务名），但默认 `sound.source="preset"`。
- `lib/popup.ps1:662-665` preset 命中即 `return`，`payload.sound.text`（含任务名）**从不使用** → 只念固定短句。
- `lib/index.js:1440` `setTimeout(..., mergeWindowMs)`，`mergeWindowMs=1200` → 实测 push→spawn **1208ms**。
- helper 每次弹卡新起 PowerShell，WPF 程序集每次 `Add-Type` → 实测启动→shown **1743ms**。
- `lib/popup.ps1` 已有 native DLL 磁盘缓存，但 WPF/语音程序集无预热。

## Ordered steps（有序步骤）

1. **语音带任务名**：`sound.phrase` 默认 `auto`→`detail`；`Start-CardSound` 的 preset 分支播完短句后，若 `phrase=detail` 且有任务名，串行追加一次 TTS 念任务名（`-SoundOnly` 里同步追加）。
2. **降合并窗口**：`DEFAULTS.mergeWindowMs` 1200→400（保留合并、肉眼近乎无感；可配置，不覆盖用户自定义值）。
3. **helper 预热**：`popup.ps1` 增 `-WarmUp` 模式（只加载 WPF/SAPI 程序集 + native 缓存后退出）；`createPlugin` 启动时 fire-and-forget 预热一次，try/catch 包裹，失败不影响插件。
4. **文档**：CHANGELOG 未发布段、README 默认值说明与提速说明；版本 **2.0.0**（默认值与行为变更）。
5. **发布**：`tools/release.ps1 -Version 2.0.0`，推送 + tag + Release，同步 profile。

## Acceptance checks（精确命令 + 期望值）

| ID | 命令 | 期望 |
| --- | --- | --- |
| A1 | `node -e "import('./lib/index.js').then(m=>console.log(m.DEFAULTS.sound.phrase))"` | `detail` |
| A2 | `node -e "import('./lib/index.js').then(m=>console.log(m.DEFAULTS.mergeWindowMs))"` | `400` |
| A3 | `grep -c 'WarmUp' lib/popup.ps1` | `>=3`（参数 + 分支 + 文档） |
| A4 | `cat > /tmp/t.mjs` 量 push→spawn（见 tools 下临时脚本） | `< 600ms` |
| A5 | `powershell -File lib/popup.ps1 -PayloadFile ... -StaySeconds 1` 计时启动→shown | `< 1200ms`（预热后） |
| A6 | `node scripts/selftest.mjs 2>&1 \| tail -1` | `ALL PASS (>=...)` |
| A7 | `python -c "print(sum(1 for b in open('lib/popup.ps1','rb').read() if b>=128))"` | `0` |
| A8 | `-SoundOnly` preset + 任务名 payload | 状态行含 preset ok + tts ok（任务名被念） |

## Risks（风险）

- preset 追加 TTS 会念两段（短句+任务名），必须串行不重叠；用 `MediaEnded` 事件串接。
- 缩短合并窗口会让同回合多条更易拆卡：用 400ms 折中，保留可配置。
- WarmUp 失败不能影响插件启动：fire-and-forget + try/catch。
- 用户自定义 `mergeWindowMs`/`phrase` 不被默认值覆盖。
